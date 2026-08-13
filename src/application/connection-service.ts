import { AgentWikiClient, AgentWikiHttpError, normalizeServerUrl } from "../agentwiki/client";
import type { ControlStorePort } from "../ports/control-store";
import type { HttpPort } from "../ports/http";
import type { SecretPort } from "../ports/secrets";
import { ExchangeResponseSchema, parseCapabilities, SessionResponseSchema } from "../agentwiki/protocol";

interface ConnectInput { serverUrl: string; code: string; deviceId: string; deviceName: string; vaultId: string; pluginVersion: string }
interface ConnectionJournal { schemaVersion: 1; phase: "exchange_prepared" | "credential_stored" | "activating" | "activated"; serverUrl: string; exchangeId: string; codeSecretId: string; credentialSecretId: string; deviceId: string; deviceName: string; vaultId: string; pluginVersion: string; credentialId?: string; serverInstanceId?: string }

function randomHex(bytes: number): string { const data = crypto.getRandomValues(new Uint8Array(bytes)); return Array.from(data, (value) => value.toString(16).padStart(2, "0")).join(""); }
function base64url(bytes: Uint8Array): string { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, ""); }
function uuid(): string { return crypto.randomUUID(); }

export class ConnectionService {
  constructor(private readonly http: HttpPort, private readonly secrets: SecretPort, private readonly state: ControlStorePort) {}

  async connect(input: ConnectInput): Promise<{ credentialSecretId: string; credentialId: string; serverInstanceId: string }> {
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const existingRaw = await this.state.read("connection-journal.json");
    if (existingRaw) {const journal=this.parseJournal(existingRaw);if(journal.serverUrl!==serverUrl||journal.deviceId!==input.deviceId||journal.vaultId!==input.vaultId||journal.pluginVersion!==input.pluginVersion)throw new Error("Pending connection identity mismatch");return this.resume(journal, input.code);}
    const codeSecretId = `agentwiki-sync-secret-${randomHex(16)}`;
    const credentialSecretId = `agentwiki-sync-secret-${randomHex(16)}`;
    let credential = base64url(crypto.getRandomValues(new Uint8Array(32)));
    this.secrets.set(codeSecretId, input.code); this.secrets.set(credentialSecretId, credential);
    if (this.secrets.get(codeSecretId) !== input.code || this.secrets.get(credentialSecretId) !== credential) throw new Error("Secret Storage verification failed");
    let journal: ConnectionJournal = { schemaVersion: 1, phase: "exchange_prepared", serverUrl, exchangeId: uuid(), codeSecretId, credentialSecretId, deviceId: input.deviceId, deviceName: input.deviceName, vaultId: input.vaultId, pluginVersion: input.pluginVersion };
    await this.state.write("connection-journal.json", JSON.stringify(journal));
    let client = new AgentWikiClient(serverUrl, this.http, () => this.secrets.get(credentialSecretId));
    let exchanged: { credentialId: string; serverInstanceId: string } | null = null;
    for (let collisionCount = 0; collisionCount < 3 && !exchanged; collisionCount += 1) {
      const request = { code: input.code, exchangeId: journal.exchangeId, credential, deviceId: input.deviceId, deviceName: input.deviceName, vaultId: input.vaultId, pluginVersion: input.pluginVersion, supportedProtocolVersions: ["1"] };
      try { const value = ExchangeResponseSchema.parse((await client.raw("POST", "/api/integrations/obsidian/exchange", request, false)).json); parseCapabilities(value.capabilities); exchanged = value; }
      catch (error) {
        const code = error instanceof AgentWikiHttpError && typeof error.body === "object" && error.body !== null ? (error.body as { error?: { code?: string } }).error?.code : null;
        if (code !== "CREDENTIAL_COLLISION") throw error;
        credential = base64url(crypto.getRandomValues(new Uint8Array(32))); this.secrets.set(credentialSecretId, credential); journal = { ...journal, exchangeId: uuid() }; await this.state.write("connection-journal.json", JSON.stringify(journal)); client = new AgentWikiClient(serverUrl, this.http, () => this.secrets.get(credentialSecretId));
      }
    }
    if (!exchanged) throw new Error("Repeated credential collision");
    journal = { ...journal, phase: "credential_stored", credentialId: exchanged.credentialId, serverInstanceId: exchanged.serverInstanceId };
    await this.state.write("connection-journal.json", JSON.stringify(journal));
    if ((await this.state.read("connection-journal.json")) === null) throw new Error("Connection journal verification failed");
    this.secrets.set(codeSecretId, "");
    const session = SessionResponseSchema.parse((await client.raw("GET", "/api/integrations/obsidian/session")).json); this.assertSession(session, journal, exchanged);
    journal = { ...journal, phase: "activating" }; await this.state.write("connection-journal.json", JSON.stringify(journal));
    await client.raw("POST", "/api/integrations/obsidian/credentials/current/activate", { credentialId: exchanged.credentialId });
    const active = SessionResponseSchema.parse((await client.raw("GET", "/api/integrations/obsidian/session")).json); this.assertSession(active, journal, exchanged);
    if (active.credentialStatus !== "active") throw new Error("Credential activation was not confirmed");
    journal = { ...journal, phase: "activated" }; await this.state.write("connection-journal.json", JSON.stringify(journal));
    return { credentialSecretId, credentialId: exchanged.credentialId, serverInstanceId: exchanged.serverInstanceId };
  }

  private assertSession(session: { serverInstanceId: string; credentialId: string; deviceId: string; vaultId: string }, journal: ConnectionJournal, exchanged: { credentialId: string; serverInstanceId: string }): void {
    if (session.serverInstanceId !== exchanged.serverInstanceId || session.credentialId !== exchanged.credentialId || session.deviceId !== journal.deviceId || session.vaultId !== journal.vaultId) throw new Error("Device session identity mismatch");
  }
  private parseJournal(raw:string):ConnectionJournal{let value:unknown;try{value=JSON.parse(raw);}catch{throw new Error("Connection journal is corrupt");}if(!value||typeof value!=="object")throw new Error("Connection journal is corrupt");const item=value as Partial<ConnectionJournal>;if(item.schemaVersion!==1||!["exchange_prepared","credential_stored","activating","activated"].includes(item.phase??"")||typeof item.serverUrl!=="string"||typeof item.exchangeId!=="string"||typeof item.codeSecretId!=="string"||typeof item.credentialSecretId!=="string"||typeof item.deviceId!=="string"||typeof item.deviceName!=="string"||typeof item.vaultId!=="string"||typeof item.pluginVersion!=="string")throw new Error("Connection journal is corrupt");return item as ConnectionJournal;}

  private async resume(journal: ConnectionJournal, code: string): Promise<{ credentialSecretId: string; credentialId: string; serverInstanceId: string }> {
    void code;
    const credential = this.secrets.get(journal.credentialSecretId); if (!credential) throw new Error("Pending credential is missing"); const client = new AgentWikiClient(journal.serverUrl, this.http, () => credential);
    try {
      const session = SessionResponseSchema.parse((await client.raw("GET", "/api/integrations/obsidian/session")).json);
      const exchanged = { credentialId: session.credentialId, serverInstanceId: session.serverInstanceId }; this.assertSession(session, journal, exchanged);
      if (session.credentialStatus === "provisional") await client.raw("POST", "/api/integrations/obsidian/credentials/current/activate", { credentialId: session.credentialId });
      const active = SessionResponseSchema.parse((await client.raw("GET", "/api/integrations/obsidian/session")).json); this.assertSession(active, journal, exchanged); if (active.credentialStatus !== "active") throw new Error("Credential activation was not confirmed");
      this.secrets.set(journal.codeSecretId, ""); await this.state.write("connection-journal.json", JSON.stringify({ ...journal, phase: "activated", credentialId: session.credentialId, serverInstanceId: session.serverInstanceId })); return { credentialSecretId: journal.credentialSecretId, ...exchanged };
    } catch (error) {
      if (!(error instanceof AgentWikiHttpError) || error.status !== 401 || journal.phase !== "exchange_prepared") throw error;
      let prepared = journal;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const storedCode = this.secrets.get(prepared.codeSecretId); const storedCredential = this.secrets.get(prepared.credentialSecretId);
        if (!storedCode || !storedCredential) throw new Error("Pending exchange secrets are missing");
        const request = { code: storedCode, exchangeId: prepared.exchangeId, credential: storedCredential, deviceId: prepared.deviceId, deviceName: prepared.deviceName, vaultId: prepared.vaultId, pluginVersion: prepared.pluginVersion, supportedProtocolVersions: ["1"] };
        try {
          const value = ExchangeResponseSchema.parse((await client.raw("POST", "/api/integrations/obsidian/exchange", request, false)).json); parseCapabilities(value.capabilities);
          prepared = { ...prepared, phase: "credential_stored", credentialId: value.credentialId, serverInstanceId: value.serverInstanceId }; await this.state.write("connection-journal.json", JSON.stringify(prepared));
          return this.resume(prepared, "");
        } catch (exchangeError) {
          const exchangeCode = exchangeError instanceof AgentWikiHttpError && typeof exchangeError.body === "object" && exchangeError.body !== null ? (exchangeError.body as { error?: { code?: string } }).error?.code : null;
          if (exchangeCode !== "CREDENTIAL_COLLISION") throw exchangeError;
          const nextCredential = base64url(crypto.getRandomValues(new Uint8Array(32))); this.secrets.set(prepared.credentialSecretId, nextCredential);
          prepared = { ...prepared, exchangeId: uuid() }; await this.state.write("connection-journal.json", JSON.stringify(prepared));
        }
      }
      throw new Error("Repeated credential collision");
    }
  }
}
