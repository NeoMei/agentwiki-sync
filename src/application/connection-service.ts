import { AgentWikiClient, normalizeServerUrl } from "../agentwiki/client";
import type { ControlStorePort } from "../ports/control-store";
import type { HttpPort } from "../ports/http";
import type { SecretPort } from "../ports/secrets";

interface ConnectInput { serverUrl: string; code: string; deviceId: string; deviceName: string; vaultId: string; pluginVersion: string }
interface ConnectionJournal { schemaVersion: 1; phase: "exchange_prepared" | "credential_stored" | "activating" | "activated"; serverUrl: string; exchangeId: string; codeSecretId: string; credentialSecretId: string; deviceId: string; deviceName: string; vaultId: string; pluginVersion: string; credentialId?: string; serverInstanceId?: string }

function randomHex(bytes: number): string { const data = crypto.getRandomValues(new Uint8Array(bytes)); return Array.from(data, (value) => value.toString(16).padStart(2, "0")).join(""); }
function base64url(bytes: Uint8Array): string { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, ""); }
function uuid(): string { return crypto.randomUUID(); }

export class ConnectionService {
  constructor(private readonly http: HttpPort, private readonly secrets: SecretPort, private readonly state: ControlStorePort) {}

  async connect(input: ConnectInput): Promise<{ credentialSecretId: string; credentialId: string; serverInstanceId: string }> {
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const codeSecretId = `agentwiki-sync-secret-${randomHex(16)}`;
    const credentialSecretId = `agentwiki-sync-secret-${randomHex(16)}`;
    const credential = base64url(crypto.getRandomValues(new Uint8Array(32)));
    this.secrets.set(codeSecretId, input.code); this.secrets.set(credentialSecretId, credential);
    if (this.secrets.get(codeSecretId) !== input.code || this.secrets.get(credentialSecretId) !== credential) throw new Error("Secret Storage verification failed");
    let journal: ConnectionJournal = { schemaVersion: 1, phase: "exchange_prepared", serverUrl, exchangeId: uuid(), codeSecretId, credentialSecretId, deviceId: input.deviceId, deviceName: input.deviceName, vaultId: input.vaultId, pluginVersion: input.pluginVersion };
    await this.state.write("connection-journal.json", JSON.stringify(journal));
    const request = { code: input.code, exchangeId: journal.exchangeId, credential, deviceId: input.deviceId, deviceName: input.deviceName, vaultId: input.vaultId, pluginVersion: input.pluginVersion, supportedProtocolVersions: ["1"] };
    const client = new AgentWikiClient(serverUrl, this.http, () => this.secrets.get(credentialSecretId));
    const exchanged = (await client.raw("POST", "/api/integrations/obsidian/exchange", request, false)).json as { credentialId: string; serverInstanceId: string };
    journal = { ...journal, phase: "credential_stored", credentialId: exchanged.credentialId, serverInstanceId: exchanged.serverInstanceId };
    await this.state.write("connection-journal.json", JSON.stringify(journal));
    if ((await this.state.read("connection-journal.json")) === null) throw new Error("Connection journal verification failed");
    this.secrets.set(codeSecretId, "");
    await client.raw("GET", "/api/integrations/obsidian/credentials/current");
    journal = { ...journal, phase: "activating" }; await this.state.write("connection-journal.json", JSON.stringify(journal));
    await client.raw("POST", "/api/integrations/obsidian/credentials/current/activate", { credentialId: exchanged.credentialId });
    journal = { ...journal, phase: "activated" }; await this.state.write("connection-journal.json", JSON.stringify(journal));
    return { credentialSecretId, credentialId: exchanged.credentialId, serverInstanceId: exchanged.serverInstanceId };
  }
}
