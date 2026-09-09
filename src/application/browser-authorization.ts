import { AgentWikiHttpError, normalizeServerUrl } from "../agentwiki/client";
import type { ControlStorePort } from "../ports/control-store";
import type { HttpPort } from "../ports/http";
import type { SecretPort } from "../ports/secrets";
import { MutableControlRepository } from "../storage/envelope";

const PENDING_PATH = "browser-authorization.json";
const DEVICE_SECRET_PREFIX = "agentwiki-device-";
const MAX_RESPONSE_BYTES = 64 * 1024;

interface PendingAuthorization {
  schemaVersion: 1;
  serverUrl: string;
  authorizationUrl: string;
  userCode: string;
  expiresAt: number;
  intervalSeconds: number;
  deviceSecretId: string;
}

export type BrowserAuthorizationState =
  | { status: "idle" }
  | {
      status: "waiting" | "connecting" | "error";
      authorizationUrl: string;
      userCode: string;
      expiresAt: number;
      message?: string;
    }
  | { status: "connected" }
  | { status: "cancelled" | "expired" | "denied" }
  | { status: "unsupported"; guideUrl: string };

export interface BrowserAuthorizationScheduler {
  set(delayMs: number, run: () => void): unknown;
  clear(handle: unknown): void;
}

interface BrowserAuthorizationOptions {
  http: HttpPort;
  secrets: SecretPort;
  store: ControlStorePort;
  connect: (
    code: string,
    serverUrl: string,
    signal: AbortSignal,
  ) => Promise<void>;
  now?: () => number;
  scheduler?: BrowserAuthorizationScheduler;
  allowLoopbackDevelopment?: boolean;
}

const isPendingAuthorization = (
  value: unknown,
): value is PendingAuthorization => {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PendingAuthorization>;
  return (
    item.schemaVersion === 1 &&
    typeof item.serverUrl === "string" &&
    typeof item.authorizationUrl === "string" &&
    typeof item.userCode === "string" &&
    typeof item.expiresAt === "number" &&
    Number.isFinite(item.expiresAt) &&
    typeof item.intervalSeconds === "number" &&
    Number.isFinite(item.intervalSeconds) &&
    item.intervalSeconds >= 1 &&
    typeof item.deviceSecretId === "string" &&
    item.deviceSecretId.startsWith(DEVICE_SECRET_PREFIX)
  );
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid browser authorization response");
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== "string" || item.length === 0)
    throw new TypeError("Invalid browser authorization response");
  return item;
}

function positiveSeconds(value: Record<string, unknown>, key: string): number {
  const item = value[key];
  if (!Number.isSafeInteger(item) || (item as number) < 1)
    throw new TypeError("Invalid browser authorization response");
  return item as number;
}

function trustedAuthorizationUrl(
  candidate: string,
  serverUrl: string,
  userCode: string,
): string {
  const url = new URL(candidate);
  if (
    url.origin !== serverUrl ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.size !== 1 ||
    url.searchParams.get("user_code") !== userCode ||
    [...url.searchParams.keys()][0] !== "user_code" ||
    /device.?code/iu.test(candidate)
  )
    throw new TypeError("Untrusted browser authorization URL");
  return url.toString();
}

function guideUrl(serverUrl: string): string {
  return `${serverUrl}/guide/obsidian#connect`;
}

const realScheduler: BrowserAuthorizationScheduler = {
  set: (delayMs, run) => window.setTimeout(run, delayMs),
  clear: (handle) => window.clearTimeout(handle as number),
};

export class BrowserAuthorizationController {
  private readonly repository: MutableControlRepository<PendingAuthorization>;
  private readonly listeners = new Set<
    (state: BrowserAuthorizationState) => void
  >();
  private readonly now: () => number;
  private readonly scheduler: BrowserAuthorizationScheduler;
  private state: BrowserAuthorizationState = { status: "idle" };
  private pending: PendingAuthorization | null = null;
  private timer: unknown = null;
  private pollingGeneration: number | null = null;
  private connectionAbort: AbortController | null = null;
  private pollPromise: Promise<void> | null = null;
  private completedConnectionGeneration: number | null = null;
  private generation = 0;

  constructor(private readonly options: BrowserAuthorizationOptions) {
    this.repository = new MutableControlRepository(
      options.store,
      PENDING_PATH,
      isPendingAuthorization,
    );
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? realScheduler;
  }

  current(): BrowserAuthorizationState {
    return this.state;
  }

  subscribe(listener: (state: BrowserAuthorizationState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(state: BrowserAuthorizationState): BrowserAuthorizationState {
    this.state = state;
    for (const listener of [...this.listeners]) listener(state);
    return state;
  }

  async start(
    serverInput: string,
    pluginVersion: string,
  ): Promise<BrowserAuthorizationState> {
    const generation = this.generation + 1;
    await this.clearPending(generation);
    if (generation !== this.generation) return this.state;
    this.completedConnectionGeneration = null;
    const serverUrl = normalizeServerUrl(
      serverInput,
      this.options.allowLoopbackDevelopment ?? false,
    );
    const response = await this.options.http.request({
      method: "POST",
      url: `${serverUrl}/api/integrations/obsidian/device/start`,
      body: { pluginVersion },
      headers: { "Content-Type": "application/json; charset=utf-8" },
      responseType: "bounded-json",
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });
    if (generation !== this.generation) return this.state;
    if (response.status === 404)
      return this.publish({
        status: "unsupported",
        guideUrl: guideUrl(serverUrl),
      });
    if (response.status >= 400)
      throw new AgentWikiHttpError(
        response.status,
        response.json,
        response.headers,
      );

    const body = record(response.json);
    const deviceCode = requiredString(body, "deviceCode");
    const userCode = requiredString(body, "userCode");
    const verificationUri = requiredString(body, "verificationUri");
    const verificationUriComplete = requiredString(
      body,
      "verificationUriComplete",
    );
    const expiresIn = positiveSeconds(body, "expiresIn");
    const intervalSeconds = positiveSeconds(body, "interval");
    const base = new URL(verificationUri);
    if (
      base.origin !== serverUrl ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      /device.?code/iu.test(verificationUri)
    )
      throw new TypeError("Untrusted browser authorization URL");
    const authorizationUrl = trustedAuthorizationUrl(
      verificationUriComplete,
      serverUrl,
      userCode,
    );
    const deviceSecretId = `${DEVICE_SECRET_PREFIX}${crypto.randomUUID()}`;
    const pending: PendingAuthorization = {
      schemaVersion: 1,
      serverUrl,
      authorizationUrl,
      userCode,
      expiresAt: this.now() + expiresIn * 1000,
      intervalSeconds,
      deviceSecretId,
    };
    this.pending = pending;
    this.options.secrets.set(deviceSecretId, deviceCode);
    try {
      await this.repository.write(pending);
    } catch (error) {
      this.options.secrets.set(deviceSecretId, "");
      const ownsPending = this.pending === pending;
      if (ownsPending) this.pending = null;
      if (generation !== this.generation) {
        if (ownsPending) await this.repository.clear();
        return this.state;
      }
      throw error;
    }
    if (generation !== this.generation) {
      this.options.secrets.set(deviceSecretId, "");
      if (this.pending === pending) {
        await this.repository.clear();
        this.pending = null;
      }
      return this.state;
    }
    this.publish(this.visiblePending("waiting"));
    this.schedule(intervalSeconds);
    return this.state;
  }

  async resume(): Promise<BrowserAuthorizationState> {
    const previousConnection =
      this.state.status === "connecting" ? this.pollPromise : null;
    this.stop();
    const generation = this.generation;
    await previousConnection;
    if (generation !== this.generation) return this.state;
    if (previousConnection && this.completedConnectionGeneration !== null) {
      await this.finish({ status: "connected" });
      return this.state;
    }
    const stored = await this.repository.read();
    if (generation !== this.generation) return this.state;
    const pending = stored?.payload ?? null;
    if (!pending || !this.options.secrets.get(pending.deviceSecretId)) {
      this.pending = null;
      return this.publish({ status: "idle" });
    }
    this.pending = pending;
    if (pending.expiresAt <= this.now()) {
      await this.finish({ status: "expired" });
      return this.state;
    }
    this.publish(this.visiblePending("waiting"));
    this.schedule(pending.intervalSeconds);
    return this.state;
  }

  retry(): void {
    if (
      !this.pending ||
      this.timer !== null ||
      this.pollingGeneration === this.generation
    )
      return;
    if (this.pending.expiresAt <= this.now()) {
      void this.finish({ status: "expired" });
      return;
    }
    this.publish(this.visiblePending("waiting"));
    this.schedule(this.pending.intervalSeconds);
  }

  async cancel(): Promise<void> {
    if (this.state.status === "connecting" && this.connectionAbort) {
      this.connectionAbort.abort();
      await this.pollPromise;
      if ((this.state as BrowserAuthorizationState).status === "connected")
        return;
    }
    await this.finish({ status: "cancelled" });
  }

  stop(): void {
    this.generation += 1;
    this.connectionAbort?.abort();
    this.connectionAbort = null;
    if (this.timer !== null) this.scheduler.clear(this.timer);
    this.timer = null;
  }

  private visiblePending(
    status: "waiting" | "connecting" | "error",
    message?: string,
  ): BrowserAuthorizationState {
    if (!this.pending) return { status: "idle" };
    return {
      status,
      authorizationUrl: this.pending.authorizationUrl,
      userCode: this.pending.userCode,
      expiresAt: this.pending.expiresAt,
      ...(message ? { message } : {}),
    };
  }

  private schedule(intervalSeconds: number): void {
    if (
      !this.pending ||
      this.timer !== null ||
      this.pollingGeneration === this.generation
    )
      return;
    const generation = this.generation;
    this.timer = this.scheduler.set(intervalSeconds * 1000, () => {
      this.timer = null;
      if (generation !== this.generation) return;
      const poll = this.poll(generation);
      this.pollPromise = poll;
      void poll.finally(() => {
        if (this.pollPromise === poll) this.pollPromise = null;
      });
    });
  }

  private async poll(generation: number): Promise<void> {
    if (
      this.pollingGeneration === generation ||
      !this.pending ||
      generation !== this.generation
    )
      return;
    if (this.pending.expiresAt <= this.now()) {
      await this.finish({ status: "expired" });
      return;
    }
    const deviceCode = this.options.secrets.get(this.pending.deviceSecretId);
    if (!deviceCode) {
      await this.finish({ status: "expired" });
      return;
    }
    this.pollingGeneration = generation;
    try {
      const response = await this.options.http.request({
        method: "POST",
        url: `${this.pending.serverUrl}/api/integrations/obsidian/device/poll`,
        body: { deviceCode },
        headers: { "Content-Type": "application/json; charset=utf-8" },
        responseType: "bounded-json",
        maxResponseBytes: MAX_RESPONSE_BYTES,
      });
      if (generation !== this.generation) return;
      if (response.status === 404) {
        await this.finish({
          status: "unsupported",
          guideUrl: guideUrl(this.pending.serverUrl),
        });
        return;
      }
      if (response.status >= 400)
        throw new AgentWikiHttpError(
          response.status,
          response.json,
          response.headers,
        );
      const body = record(response.json);
      const status = requiredString(body, "status");
      if (status === "authorization_pending") {
        this.publish(this.visiblePending("waiting"));
      } else if (status === "slow_down") {
        const interval = Math.max(
          this.pending.intervalSeconds + 5,
          body.interval === undefined ? 0 : positiveSeconds(body, "interval"),
        );
        this.pending = { ...this.pending, intervalSeconds: interval };
        await this.repository.write(this.pending);
        this.publish(this.visiblePending("waiting"));
      } else if (status === "denied" || status === "expired") {
        await this.finish({ status });
        return;
      } else if (status === "authorized") {
        const code = requiredString(body, "code");
        positiveSeconds(body, "expiresIn");
        const serverUrl = this.pending.serverUrl;
        const abort = new AbortController();
        this.connectionAbort = abort;
        this.publish(this.visiblePending("connecting"));
        await this.options.connect(code, serverUrl, abort.signal);
        this.completedConnectionGeneration = generation;
        if (generation !== this.generation) return;
        this.connectionAbort = null;
        await this.finish({ status: "connected" });
        return;
      } else {
        throw new TypeError("Invalid browser authorization response");
      }
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.publish(
        this.visiblePending(
          "error",
          error instanceof Error ? error.message : "Authorization failed",
        ),
      );
    } finally {
      if (this.pollingGeneration === generation) this.pollingGeneration = null;
    }
    if (generation === this.generation && this.pending)
      this.schedule(this.pending.intervalSeconds);
  }

  private async clearPending(expectedGeneration?: number): Promise<void> {
    this.stop();
    const generation = this.generation;
    if (expectedGeneration !== undefined && generation !== expectedGeneration)
      return;
    const stored =
      this.pending ?? (await this.repository.read())?.payload ?? null;
    if (generation !== this.generation) return;
    if (stored) this.options.secrets.set(stored.deviceSecretId, "");
    await this.repository.clear();
    if (generation !== this.generation) return;
    this.pending = null;
  }

  private async finish(state: BrowserAuthorizationState): Promise<void> {
    const generation = this.generation + 1;
    await this.clearPending(generation);
    if (generation === this.generation) this.publish(state);
  }
}
