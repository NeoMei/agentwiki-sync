import {
  AgentWikiClient,
  AgentWikiHttpError,
  normalizeServerUrl,
} from "../agentwiki/client";
import type { ControlStorePort } from "../ports/control-store";
import type { HttpPort } from "../ports/http";
import type { SecretPort } from "../ports/secrets";
import {
  ActivateCurrentObsidianCredentialRequestSchema,
  ExchangeObsidianCredentialRequestSchema,
  ExchangeResponseSchema,
  parseCapabilities,
  SessionResponseSchema,
} from "../agentwiki/protocol";
import { MutableControlRepository } from "../storage/envelope";
import { ProtocolSelectionRepository } from "../storage/protocol-selection";

interface ConnectInput {
  serverUrl: string;
  code: string;
  deviceId: string;
  deviceName: string;
  vaultId: string;
  pluginVersion: string;
  allowLoopbackDevelopment?: boolean;
  signal?: AbortSignal;
}
interface ConnectionJournal {
  schemaVersion: 1;
  phase: "exchange_prepared" | "credential_stored" | "activating" | "activated";
  serverUrl: string;
  exchangeId: string;
  codeSecretId: string;
  credentialSecretId: string;
  deviceId: string;
  deviceName: string;
  vaultId: string;
  pluginVersion: string;
  credentialId?: string;
  serverInstanceId?: string;
}
export interface ConnectionState {
  schemaVersion: 1;
  serverUrl: string;
  serverInstanceId: string;
  credentialId: string;
  credentialSecretId: string;
  deviceId: string;
  vaultId: string;
}
const isConnectionJournal = (value: unknown): value is ConnectionJournal => {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ConnectionJournal>;
  return (
    item.schemaVersion === 1 &&
    [
      "exchange_prepared",
      "credential_stored",
      "activating",
      "activated",
    ].includes(item.phase ?? "") &&
    typeof item.serverUrl === "string" &&
    typeof item.exchangeId === "string" &&
    typeof item.codeSecretId === "string" &&
    typeof item.credentialSecretId === "string" &&
    typeof item.deviceId === "string" &&
    typeof item.deviceName === "string" &&
    typeof item.vaultId === "string" &&
    typeof item.pluginVersion === "string"
  );
};
export const isConnectionState = (value: unknown): value is ConnectionState => {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ConnectionState>;
  return (
    item.schemaVersion === 1 &&
    [
      item.serverUrl,
      item.serverInstanceId,
      item.credentialId,
      item.credentialSecretId,
      item.deviceId,
      item.vaultId,
    ].every((value) => typeof value === "string")
  );
};

function randomHex(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}
function uuid(): string {
  return crypto.randomUUID();
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("连接已取消", "AbortError");
}

export class ConnectionService {
  private readonly journal: MutableControlRepository<ConnectionJournal>;
  private readonly connectionState: MutableControlRepository<ConnectionState>;
  constructor(
    private readonly http: HttpPort,
    private readonly secrets: SecretPort,
    private readonly state: ControlStorePort,
  ) {
    this.journal = new MutableControlRepository(
      state,
      "connection-journal.json",
      isConnectionJournal,
    );
    this.connectionState = new MutableControlRepository(
      state,
      "connection-state.json",
      isConnectionState,
    );
  }

  private async writeJournal(value: ConnectionJournal): Promise<void> {
    await this.journal.write(value);
  }
  private async readJournal(): Promise<ConnectionJournal | null> {
    const raw = await this.state.read("connection-journal.json");
    if (raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("连接日志已损坏");
      }
      if (isConnectionJournal(parsed)) {
        await this.state.remove("connection-journal.json");
        await this.writeJournal(parsed);
        return parsed;
      }
    }
    const envelope = await this.journal.read();
    return envelope?.payload ?? null;
  }
  private async commitConnection(value: ConnectionState): Promise<void> {
    const previous = await this.connectionState.read();
    if (
      !previous ||
      previous.payload.credentialId !== value.credentialId ||
      previous.payload.credentialSecretId !== value.credentialSecretId
    )
      await new ProtocolSelectionRepository(this.state).clear();
    await this.connectionState.write(value);
    await this.journal.clear();
  }

  private isTerminalResumeError(error: unknown): boolean {
    if (!(error instanceof AgentWikiHttpError)) return false;
    if (error.status === 401 || error.status === 403) return true;
    const code = (error.body as { error?: { code?: string } } | undefined)
      ?.error?.code;
    return (
      code === "DEVICE_CREDENTIAL_EXPIRED" ||
      code === "DEVICE_CREDENTIAL_REVOKED" ||
      code === "INSTALLATION_CODE_EXPIRED" ||
      code === "INSTALLATION_CODE_INVALID" ||
      code === "INSTALLATION_ALREADY_EXCHANGED" ||
      code === "USER_INACTIVE"
    );
  }

  private async discardPendingConnection(
    journal: ConnectionJournal,
  ): Promise<void> {
    this.secrets.set(journal.codeSecretId, "");
    this.secrets.set(journal.credentialSecretId, "");
    await this.journal.clear();
  }

  async connect(input: ConnectInput): Promise<{
    credentialSecretId: string;
    credentialId: string;
    serverInstanceId: string;
  }> {
    assertNotAborted(input.signal);
    const serverUrl = normalizeServerUrl(
      input.serverUrl,
      input.allowLoopbackDevelopment ?? false,
    );
    const existing = await this.readJournal();
    assertNotAborted(input.signal);
    if (existing) {
      const identityMatches =
        existing.serverUrl === serverUrl &&
        existing.deviceId === input.deviceId &&
        existing.vaultId === input.vaultId &&
        existing.pluginVersion === input.pluginVersion;
      if (!identityMatches) {
        // A journal from a different server/device/vault/plugin version can
        // never be resumed in this context. Discard it and start fresh with
        // the user's new code instead of blocking the connection forever.
        await this.discardPendingConnection(existing);
      } else {
        // A fresh, different code supersedes the failed attempt: discard
        // dead secrets instead of replaying them and getting stuck.
        const storedCode = this.secrets.get(existing.codeSecretId);
        if (
          existing.phase === "exchange_prepared" &&
          input.code &&
          storedCode !== input.code
        ) {
          await this.discardPendingConnection(existing);
        } else {
          try {
            return await this.resume(existing, input.code, input.signal);
          } catch (error) {
            if (
              existing.phase === "exchange_prepared" ||
              !input.code ||
              !this.isTerminalResumeError(error)
            )
              throw error;
            assertNotAborted(input.signal);
            await this.discardPendingConnection(existing);
            assertNotAborted(input.signal);
          }
        }
      }
    }
    const codeSecretId = `agentwiki-sync-secret-${randomHex(16)}`;
    const credentialSecretId = `agentwiki-sync-secret-${randomHex(16)}`;
    let credential = base64url(crypto.getRandomValues(new Uint8Array(32)));
    this.secrets.set(codeSecretId, input.code);
    this.secrets.set(credentialSecretId, credential);
    if (
      this.secrets.get(codeSecretId) !== input.code ||
      this.secrets.get(credentialSecretId) !== credential
    )
      throw new Error("密钥存储验证失败");
    let journal: ConnectionJournal = {
      schemaVersion: 1,
      phase: "exchange_prepared",
      serverUrl,
      exchangeId: uuid(),
      codeSecretId,
      credentialSecretId,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      vaultId: input.vaultId,
      pluginVersion: input.pluginVersion,
    };
    await this.writeJournal(journal);
    assertNotAborted(input.signal);
    let client = new AgentWikiClient(serverUrl, this.http, () =>
      this.secrets.get(credentialSecretId),
    );
    let exchanged: { credentialId: string; serverInstanceId: string } | null =
      null;
    for (
      let collisionCount = 0;
      collisionCount < 3 && !exchanged;
      collisionCount += 1
    ) {
      const request = ExchangeObsidianCredentialRequestSchema.parse({
        code: input.code,
        exchangeId: journal.exchangeId,
        credential,
        deviceId: input.deviceId,
        deviceName: input.deviceName,
        vaultId: input.vaultId,
        pluginVersion: input.pluginVersion,
        supportedProtocolVersions: ["3", "2", "1"],
      });
      try {
        const exchangeResponse = await client.raw(
          "POST",
          "/api/integrations/obsidian/exchange",
          request,
          false,
        );
        assertNotAborted(input.signal);
        const value = ExchangeResponseSchema.parse(exchangeResponse.json);
        parseCapabilities(value.capabilities);
        exchanged = value;
      } catch (error) {
        const code =
          error instanceof AgentWikiHttpError &&
          typeof error.body === "object" &&
          error.body !== null
            ? (error.body as { error?: { code?: string } }).error?.code
            : null;
        if (code !== "CREDENTIAL_COLLISION") throw error;
        credential = base64url(crypto.getRandomValues(new Uint8Array(32)));
        this.secrets.set(credentialSecretId, credential);
        journal = { ...journal, exchangeId: uuid() };
        await this.writeJournal(journal);
        client = new AgentWikiClient(serverUrl, this.http, () =>
          this.secrets.get(credentialSecretId),
        );
      }
    }
    if (!exchanged) throw new Error("重复凭据冲突");
    journal = {
      ...journal,
      phase: "credential_stored",
      credentialId: exchanged.credentialId,
      serverInstanceId: exchanged.serverInstanceId,
    };
    await this.writeJournal(journal);
    assertNotAborted(input.signal);
    if ((await this.journal.read()) === null)
      throw new Error("连接日志验证失败");
    this.secrets.set(codeSecretId, "");
    const session = SessionResponseSchema.parse(
      (await client.raw("GET", "/api/integrations/obsidian/session")).json,
    );
    assertNotAborted(input.signal);
    this.assertSession(session, journal, exchanged);
    journal = { ...journal, phase: "activating" };
    await this.writeJournal(journal);
    assertNotAborted(input.signal);
    await client.raw(
      "POST",
      "/api/integrations/obsidian/credentials/current/activate",
      ActivateCurrentObsidianCredentialRequestSchema.parse({
        credentialId: exchanged.credentialId,
      }),
    );
    const active = SessionResponseSchema.parse(
      (await client.raw("GET", "/api/integrations/obsidian/session")).json,
    );
    this.assertSession(active, journal, exchanged);
    if (active.credentialStatus !== "active") throw new Error("凭据激活未确认");
    journal = { ...journal, phase: "activated" };
    await this.writeJournal(journal);
    await this.commitConnection({
      schemaVersion: 1,
      serverUrl,
      serverInstanceId: exchanged.serverInstanceId,
      credentialId: exchanged.credentialId,
      credentialSecretId,
      deviceId: input.deviceId,
      vaultId: input.vaultId,
    });
    this.secrets.set(codeSecretId, "");
    return {
      credentialSecretId,
      credentialId: exchanged.credentialId,
      serverInstanceId: exchanged.serverInstanceId,
    };
  }

  private assertSession(
    session: {
      serverInstanceId: string;
      credentialId: string;
      deviceId: string;
      vaultId: string;
    },
    journal: ConnectionJournal,
    exchanged: { credentialId: string; serverInstanceId: string },
  ): void {
    if (
      session.serverInstanceId !== exchanged.serverInstanceId ||
      session.credentialId !== exchanged.credentialId ||
      session.deviceId !== journal.deviceId ||
      session.vaultId !== journal.vaultId
    )
      throw new Error("设备会话身份不匹配");
  }
  private parseJournal(raw: string): ConnectionJournal {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("连接日志已损坏");
    }
    if (!isConnectionJournal(value)) throw new Error("连接日志已损坏");
    return value;
  }

  private async resume(
    journal: ConnectionJournal,
    code: string,
    signal?: AbortSignal,
  ): Promise<{
    credentialSecretId: string;
    credentialId: string;
    serverInstanceId: string;
  }> {
    assertNotAborted(signal);
    void code;
    const credential = this.secrets.get(journal.credentialSecretId);
    if (!credential) throw new Error("待处理凭据缺失");
    const client = new AgentWikiClient(
      journal.serverUrl,
      this.http,
      () => credential,
    );
    try {
      const session = SessionResponseSchema.parse(
        (await client.raw("GET", "/api/integrations/obsidian/session")).json,
      );
      const exchanged = {
        credentialId: session.credentialId,
        serverInstanceId: session.serverInstanceId,
      };
      this.assertSession(session, journal, exchanged);
      if (session.credentialStatus === "provisional") assertNotAborted(signal);
      if (session.credentialStatus === "provisional")
        await client.raw(
          "POST",
          "/api/integrations/obsidian/credentials/current/activate",
          ActivateCurrentObsidianCredentialRequestSchema.parse({
            credentialId: session.credentialId,
          }),
        );
      const active = SessionResponseSchema.parse(
        (await client.raw("GET", "/api/integrations/obsidian/session")).json,
      );
      this.assertSession(active, journal, exchanged);
      if (active.credentialStatus !== "active")
        throw new Error("凭据激活未确认");
      this.secrets.set(journal.codeSecretId, "");
      await this.commitConnection({
        schemaVersion: 1,
        serverUrl: journal.serverUrl,
        serverInstanceId: session.serverInstanceId,
        credentialId: session.credentialId,
        credentialSecretId: journal.credentialSecretId,
        deviceId: journal.deviceId,
        vaultId: journal.vaultId,
      });
      return { credentialSecretId: journal.credentialSecretId, ...exchanged };
    } catch (error) {
      if (
        !(error instanceof AgentWikiHttpError) ||
        error.status !== 401 ||
        journal.phase !== "exchange_prepared"
      )
        throw error;
      let prepared = journal;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const storedCode = this.secrets.get(prepared.codeSecretId);
        const storedCredential = this.secrets.get(prepared.credentialSecretId);
        if (!storedCode || !storedCredential)
          throw new Error("待处理交换密钥缺失");
        const request = ExchangeObsidianCredentialRequestSchema.parse({
          code: storedCode,
          exchangeId: prepared.exchangeId,
          credential: storedCredential,
          deviceId: prepared.deviceId,
          deviceName: prepared.deviceName,
          vaultId: prepared.vaultId,
          pluginVersion: prepared.pluginVersion,
          supportedProtocolVersions: ["3", "2", "1"],
        });
        try {
          const value = ExchangeResponseSchema.parse(
            (
              await client.raw(
                "POST",
                "/api/integrations/obsidian/exchange",
                request,
                false,
              )
            ).json,
          );
          parseCapabilities(value.capabilities);
          prepared = {
            ...prepared,
            phase: "credential_stored",
            credentialId: value.credentialId,
            serverInstanceId: value.serverInstanceId,
          };
          await this.writeJournal(prepared);
          assertNotAborted(signal);
          return this.resume(prepared, "", signal);
        } catch (exchangeError) {
          const exchangeCode =
            exchangeError instanceof AgentWikiHttpError &&
            typeof exchangeError.body === "object" &&
            exchangeError.body !== null
              ? (exchangeError.body as { error?: { code?: string } }).error
                  ?.code
              : null;
          if (exchangeCode !== "CREDENTIAL_COLLISION") throw exchangeError;
          const nextCredential = base64url(
            crypto.getRandomValues(new Uint8Array(32)),
          );
          this.secrets.set(prepared.credentialSecretId, nextCredential);
          prepared = { ...prepared, exchangeId: uuid() };
          await this.writeJournal(prepared);
        }
      }
      throw new Error("重复凭据冲突");
    }
  }
}
