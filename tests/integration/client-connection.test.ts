import { describe, expect, it } from "vitest";
import { AgentWikiClient, normalizeServerUrl } from "../../src/agentwiki/client";
import { ConnectionService } from "../../src/application/connection-service";
import { MemorySecrets } from "../fakes/memory-secrets";
import { FakeHttp } from "../fakes/fake-http";
import { MemoryControlStore } from "../fakes/memory-control-store";

describe("AgentWiki connection", () => {
  it("accepts HTTPS and literal loopback development URLs only", () => {
    expect(normalizeServerUrl("https://wiki.example.com/")).toBe("https://wiki.example.com");
    expect(normalizeServerUrl("http://127.0.0.1:3000", true)).toBe("http://127.0.0.1:3000");
    expect(() => normalizeServerUrl("http://example.com", true)).toThrow();
    expect(() => normalizeServerUrl("https://u:p@example.com?q=1")).toThrow();
  });

  it("rejects redirects and validates a fixed paginated revision", async () => {
    const http = new FakeHttp();
    http.responses.push({ status: 302, json: {} });
    const client = new AgentWikiClient("https://wiki.example.com", http, () => "secret");
    await expect(client.head("space")).rejects.toThrow(/redirect/);
  });

  it("rejects mixed snapshot pages before returning any combined result", async () => {
    const http = new FakeHttp();
    const page = { protocolVersion: "1", spaceId: "space", revision: "r1", sequence: 1, revisionContentHash: "h1", pageCount: "2", revisionManifestByteLength: "10", revisionBodyBytes: "2", items: [], nextCursor: "next" };
    http.responses.push({ status: 200, json: page }, { status: 200, json: { ...page, revisionContentHash: "changed", nextCursor: null } });
    await expect(new AgentWikiClient("https://wiki.example.com", http, () => "secret").snapshot("space")).rejects.toThrow(/metadata changed/);
  });

  it("stores a credential before exchange and activates only after verification", async () => {
    const http = new FakeHttp();
    http.route("POST", "/api/integrations/obsidian/exchange", { status: 201, json: { protocolVersion: "1", serverInstanceId: "11111111-1111-4111-8111-111111111111", credentialId: "22222222-2222-4222-8222-222222222222", credentialStatus: "provisional", provisionalExpiresAt: "2026-08-14T01:00:00.000Z", user: { id: "u", displayName: "U" }, capabilities: FakeHttp.capabilities } });
    const session = { protocolVersion: "1", serverInstanceId: "11111111-1111-4111-8111-111111111111", credentialId: "22222222-2222-4222-8222-222222222222", deviceId: "33333333-3333-4333-8333-333333333333", deviceName: "Phone", vaultId: "44444444-4444-4444-8444-444444444444", createdAt: "2026-08-14T00:00:00.000Z", lastUsedAt: "2026-08-14T00:00:00.000Z", credentialStatus: "provisional", provisionalExpiresAt: "2026-08-14T01:00:00.000Z", user: { id: "u", displayName: "U" }, capabilities: FakeHttp.capabilities };
    http.responses.push(
      { status: 201, json: { protocolVersion: "1", serverInstanceId: "11111111-1111-4111-8111-111111111111", credentialId: "22222222-2222-4222-8222-222222222222", credentialStatus: "provisional", provisionalExpiresAt: "2026-08-14T01:00:00.000Z", user: { id: "u", displayName: "U" }, capabilities: FakeHttp.capabilities } },
      { status: 200, json: session },
      { status: 200, json: { protocolVersion: "1", credentialStatus: "active" } },
      { status: 200, json: { ...session, credentialStatus: "active", provisionalExpiresAt: null } }
    );
    http.route("POST", "/api/integrations/obsidian/credentials/current/activate", { status: 200, json: { protocolVersion: "1", credentialStatus: "active" } });
    const secrets = new MemorySecrets();
    const service = new ConnectionService(http, secrets, new MemoryControlStore());
    const result = await service.connect({ serverUrl: "https://wiki.example.com", code: "a".repeat(27), deviceId: "33333333-3333-4333-8333-333333333333", deviceName: "Phone", vaultId: "44444444-4444-4444-8444-444444444444", pluginVersion: "0.1.0" });
    expect(result.credentialSecretId).toMatch(/^agentwiki-sync-secret-[0-9a-f]{32}$/);
    expect(secrets.get(result.credentialSecretId)).toHaveLength(43);
    expect(http.calls.map((call) => call.path)).toEqual(["/api/integrations/obsidian/exchange", "/api/integrations/obsidian/credentials/current", "/api/integrations/obsidian/credentials/current/activate", "/api/integrations/obsidian/credentials/current"]);
  });

  it("keeps the code and rotates credential material on an explicit collision", async () => {
    const http = new FakeHttp();
    http.responses.push(
      { status: 409, json: { protocolVersion: "1", error: { code: "CREDENTIAL_COLLISION", message: "collision", retryable: false } } },
      { status: 201, json: { protocolVersion: "1", serverInstanceId: "11111111-1111-4111-8111-111111111111", credentialId: "22222222-2222-4222-8222-222222222222", credentialStatus: "provisional", provisionalExpiresAt: "2026-08-14T01:00:00.000Z", user: { id: "u", displayName: "U" }, capabilities: FakeHttp.capabilities } },
      { status: 200, json: { protocolVersion: "1", serverInstanceId: "11111111-1111-4111-8111-111111111111", credentialId: "22222222-2222-4222-8222-222222222222", deviceId: "33333333-3333-4333-8333-333333333333", deviceName: "Phone", vaultId: "44444444-4444-4444-8444-444444444444", createdAt: "2026-08-14T00:00:00.000Z", lastUsedAt: "2026-08-14T00:00:00.000Z", credentialStatus: "provisional", provisionalExpiresAt: "2026-08-14T01:00:00.000Z", user: { id: "u", displayName: "U" }, capabilities: FakeHttp.capabilities } },
      { status: 200, json: { protocolVersion: "1", credentialStatus: "active" } },
      { status: 200, json: { protocolVersion: "1", credentialStatus: "active" } }
    );
    const secrets = new MemorySecrets();
    await new ConnectionService(http, secrets, new MemoryControlStore()).connect({ serverUrl: "https://wiki.example.com", code: "a".repeat(27), deviceId: "33333333-3333-4333-8333-333333333333", deviceName: "Phone", vaultId: "44444444-4444-4444-8444-444444444444", pluginVersion: "0.1.0" });
    const exchanges = http.calls.filter((call) => call.path === "/api/integrations/obsidian/exchange");
    expect(exchanges).toHaveLength(2);
    expect((exchanges[0]!.body as { credential: string }).credential).not.toBe((exchanges[1]!.body as { credential: string }).credential);
    expect((exchanges[0]!.body as { code: string }).code).toBe((exchanges[1]!.body as { code: string }).code);
  });
});
