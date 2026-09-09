import { describe, expect, it, vi } from "vitest";
import {
  BrowserAuthorizationController,
  type BrowserAuthorizationScheduler,
} from "../../src/application/browser-authorization";
import { FakeHttp } from "../fakes/fake-http";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { MemorySecrets } from "../fakes/memory-secrets";

class ManualScheduler implements BrowserAuthorizationScheduler {
  private nextId = 0;
  readonly tasks = new Map<number, { delayMs: number; run: () => void }>();

  set(delayMs: number, run: () => void): number {
    this.nextId += 1;
    this.tasks.set(this.nextId, { delayMs, run });
    return this.nextId;
  }

  clear(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  async runNext(): Promise<void> {
    const entry = [...this.tasks.entries()][0];
    if (!entry) throw new Error("no scheduled poll");
    this.tasks.delete(entry[0]);
    entry[1].run();
    await vi.waitFor(() => expect(this.tasks.size).toBeLessThanOrEqual(1));
  }

  onlyDelay(): number {
    expect(this.tasks.size).toBe(1);
    return [...this.tasks.values()][0]!.delayMs;
  }
}

const started = {
  deviceCode: "awd_device_secret",
  userCode: "ABCD-EFGH",
  verificationUri: "https://wiki.example.com/onboard/device",
  verificationUriComplete:
    "https://wiki.example.com/onboard/device?user_code=ABCD-EFGH",
  expiresIn: 600,
  interval: 5,
};

function fixture(now = 1_000_000) {
  const http = new FakeHttp();
  const secrets = new MemorySecrets();
  const store = new MemoryControlStore();
  const scheduler = new ManualScheduler();
  const connect = vi.fn(async (_code: string) => {});
  const subject = new BrowserAuthorizationController({
    http,
    secrets,
    store,
    connect,
    now: () => now,
    scheduler,
  });
  return { http, secrets, store, scheduler, connect, subject };
}

describe("browser authorization", () => {
  it("uses an Obsidian-compatible secret ID for pending device codes", async () => {
    const f = fixture();
    f.http.enqueue({ status: 200, json: started });

    await f.subject.start("https://wiki.example.com", "0.4.0");

    const [secretId] = f.secrets.values.keys();
    expect(secretId).toMatch(/^[a-z0-9-]{1,64}$/u);
  });

  it("publishes one stable listener snapshot when a settings redraw resubscribes", async () => {
    const f = fixture();
    f.http.enqueue({ status: 404, json: {} });
    const calls: string[] = [];
    let unsubscribe = () => {};
    unsubscribe = f.subject.subscribe(() => {
      calls.push("old");
      unsubscribe();
      f.subject.subscribe(() => calls.push("new"));
    });

    await f.subject.start("https://wiki.example.com", "0.4.0");

    expect(calls).toEqual(["old"]);
  });

  it("keeps the device code only in secret storage and connects through the existing code entry", async () => {
    const f = fixture();
    f.http.enqueue({ status: 200, json: started });
    f.http.enqueue({
      status: 200,
      json: { status: "authorized", code: "awo_install_once", expiresIn: 600 },
    });

    const waiting = await f.subject.start("https://wiki.example.com", "0.4.0");

    expect(waiting).toMatchObject({
      status: "waiting",
      authorizationUrl: started.verificationUriComplete,
      userCode: started.userCode,
    });
    expect(JSON.stringify(waiting)).not.toContain(started.deviceCode);
    expect([...f.secrets.values.values()]).toEqual([started.deviceCode]);
    expect(f.scheduler.onlyDelay()).toBe(5_000);

    await f.scheduler.runNext();
    await vi.waitFor(() =>
      expect(f.subject.current()).toMatchObject({ status: "connected" }),
    );

    expect(f.connect).toHaveBeenCalledWith("awo_install_once");
    expect([...f.secrets.values.values()]).toEqual([""]);
    expect(f.scheduler.tasks.size).toBe(0);
  });

  it("isolates pending device secrets across Vault-local authorization stores", async () => {
    const f = fixture();
    f.http.enqueue({ status: 200, json: started });
    await f.subject.start("https://wiki.example.com", "0.4.0");
    const otherHttp = new FakeHttp();
    otherHttp.enqueue({
      status: 200,
      json: { ...started, deviceCode: "awd_other_vault_secret" },
    });
    const other = new BrowserAuthorizationController({
      http: otherHttp,
      secrets: f.secrets,
      store: new MemoryControlStore(),
      connect: vi.fn(),
      now: () => 1_000_000,
      scheduler: new ManualScheduler(),
    });

    await other.start("https://wiki.example.com", "0.4.0");

    expect([...f.secrets.values.values()].sort()).toEqual(
      [started.deviceCode, "awd_other_vault_secret"].sort(),
    );
  });

  it("rejects cross-origin or device-secret-bearing authorization URLs", async () => {
    for (const verificationUriComplete of [
      "https://evil.example/onboard/device?user_code=ABCD-EFGH",
      "https://wiki.example.com/onboard/device?deviceCode=awd_device_secret",
    ]) {
      const f = fixture();
      f.http.enqueue({
        status: 200,
        json: { ...started, verificationUriComplete },
      });

      await expect(
        f.subject.start("https://wiki.example.com", "0.4.0"),
      ).rejects.toThrow(/authorization URL/i);
      expect(f.secrets.values.size).toBe(0);
      expect(f.scheduler.tasks.size).toBe(0);
    }
  });

  it("cancels the only poll loop and removes pending authorization", async () => {
    const f = fixture();
    f.http.enqueue({ status: 200, json: started });
    await f.subject.start("https://wiki.example.com", "0.4.0");

    await f.subject.cancel();

    expect(f.subject.current()).toMatchObject({ status: "cancelled" });
    expect(f.scheduler.tasks.size).toBe(0);
    expect([...f.secrets.values.values()]).toEqual([""]);
    expect(f.http.calls).toHaveLength(1);
  });

  it("does not let a cancelled in-flight poll interfere with the replacement flow", async () => {
    const f = fixture();
    f.http.enqueue({ status: 200, json: started });
    let releaseOld!: () => void;
    const oldPoll = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const originalRequest = f.http.request.bind(f.http);
    let polling = false;
    f.http.request = async (request) => {
      if (request.url.endsWith("/device/poll") && !polling) {
        polling = true;
        await oldPoll;
        return { status: 200, json: { status: "authorization_pending" } };
      }
      return originalRequest(request);
    };
    await f.subject.start("https://wiki.example.com", "0.4.0");
    const firstTimer = [...f.scheduler.tasks.entries()][0]!;
    f.scheduler.tasks.delete(firstTimer[0]);
    firstTimer[1].run();
    await vi.waitFor(() => expect(polling).toBe(true));
    f.http.enqueue({
      status: 200,
      json: { ...started, deviceCode: "awd_replacement" },
    });

    await f.subject.start("https://wiki.example.com", "0.4.0");
    releaseOld();
    await Promise.resolve();
    f.subject.retry();

    expect(f.scheduler.tasks.size).toBe(1);
  });

  it("resumes one new loop when settings reopen during an in-flight poll", async () => {
    const f = fixture();
    f.http.enqueue({ status: 200, json: started });
    let releaseOld!: () => void;
    const oldPoll = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const originalRequest = f.http.request.bind(f.http);
    let polling = false;
    f.http.request = async (request) => {
      if (request.url.endsWith("/device/poll") && !polling) {
        polling = true;
        await oldPoll;
        return { status: 200, json: { status: "authorization_pending" } };
      }
      return originalRequest(request);
    };
    await f.subject.start("https://wiki.example.com", "0.4.0");
    const firstTimer = [...f.scheduler.tasks.entries()][0]!;
    f.scheduler.tasks.delete(firstTimer[0]);
    firstTimer[1].run();
    await vi.waitFor(() => expect(polling).toBe(true));

    f.subject.stop();
    await f.subject.resume();

    expect(f.scheduler.tasks.size).toBe(1);
    releaseOld();
  });

  it("honors slow_down and retry never starts a second poll loop", async () => {
    const f = fixture();
    f.http.enqueue({ status: 200, json: started });
    f.http.enqueue({
      status: 200,
      json: { status: "slow_down", interval: 12 },
    });
    await f.subject.start("https://wiki.example.com", "0.4.0");

    await f.scheduler.runNext();
    await vi.waitFor(() => expect(f.scheduler.onlyDelay()).toBe(12_000));
    f.subject.retry();

    expect(f.scheduler.tasks.size).toBe(1);
    expect(f.scheduler.onlyDelay()).toBe(12_000);
  });

  it("backs off by five seconds when slow_down omits its optional interval", async () => {
    const f = fixture();
    f.http.enqueue({ status: 200, json: started });
    f.http.enqueue({ status: 200, json: { status: "slow_down" } });
    await f.subject.start("https://wiki.example.com", "0.4.0");

    await f.scheduler.runNext();
    await vi.waitFor(() => expect(f.scheduler.tasks.size).toBe(1));

    expect(f.scheduler.onlyDelay()).toBe(10_000);
  });

  it("keeps polling after a transient request failure without creating a second loop", async () => {
    const f = fixture();
    f.http.enqueue({ status: 200, json: started });
    f.http.enqueue({ status: 503, json: { error: { code: "UNAVAILABLE" } } });
    await f.subject.start("https://wiki.example.com", "0.4.0");

    await f.scheduler.runNext();
    await vi.waitFor(() =>
      expect(f.subject.current()).toMatchObject({ status: "error" }),
    );

    expect(f.scheduler.tasks.size).toBe(1);
    expect(f.scheduler.onlyDelay()).toBe(5_000);
  });

  it("recovers one pending loop after plugin reload without exposing the secret", async () => {
    const f = fixture();
    f.http.enqueue({ status: 200, json: started });
    await f.subject.start("https://wiki.example.com", "0.4.0");
    f.subject.stop();

    const restored = new BrowserAuthorizationController({
      http: f.http,
      secrets: f.secrets,
      store: f.store,
      connect: f.connect,
      now: () => 1_000_000,
      scheduler: f.scheduler,
    });
    const state = await restored.resume();

    expect(state).toMatchObject({
      status: "waiting",
      authorizationUrl: started.verificationUriComplete,
    });
    expect(JSON.stringify(state)).not.toContain(started.deviceCode);
    expect(f.scheduler.tasks.size).toBe(1);
    expect(f.scheduler.onlyDelay()).toBe(5_000);
  });

  it("expires stale persisted authorization without polling", async () => {
    const f = fixture();
    f.http.enqueue({ status: 200, json: { ...started, expiresIn: 1 } });
    await f.subject.start("https://wiki.example.com", "0.4.0");
    f.subject.stop();

    const restored = new BrowserAuthorizationController({
      http: f.http,
      secrets: f.secrets,
      store: f.store,
      connect: f.connect,
      now: () => 1_002_000,
      scheduler: f.scheduler,
    });

    await expect(restored.resume()).resolves.toMatchObject({
      status: "expired",
    });
    expect(f.scheduler.tasks.size).toBe(0);
    expect([...f.secrets.values.values()]).toEqual([""]);
  });

  it("stops on an old-server 404 and provides the configured fallback guide", async () => {
    const f = fixture();
    f.http.enqueue({ status: 404, json: { error: { code: "NOT_FOUND" } } });

    const result = await f.subject.start("https://self.example.com", "0.4.0");

    expect(result).toEqual({
      status: "unsupported",
      guideUrl: "https://self.example.com/guide/obsidian#connect",
    });
    expect(f.scheduler.tasks.size).toBe(0);
    expect(f.http.calls).toHaveLength(1);
  });
});
