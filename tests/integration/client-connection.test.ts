import { describe, expect, it } from "vitest";
import { canonicalBytes, sha256Hex } from "../../src/agentwiki/protocol";
import {
  AgentWikiClient,
  normalizeServerUrl,
} from "../../src/agentwiki/client";
import { ConnectionService } from "../../src/application/connection-service";
import { ProtocolSelectionRepository } from "../../src/storage/protocol-selection";
import { MemorySecrets } from "../fakes/memory-secrets";
import { FakeHttp } from "../fakes/fake-http";
import { MemoryControlStore } from "../fakes/memory-control-store";

describe("AgentWiki connection", () => {
  it("accepts HTTPS and literal loopback development URLs only", () => {
    expect(normalizeServerUrl("https://wiki.example.com/")).toBe(
      "https://wiki.example.com",
    );
    expect(normalizeServerUrl("http://127.0.0.1:3000", true)).toBe(
      "http://127.0.0.1:3000",
    );
    expect(() => normalizeServerUrl("http://example.com", true)).toThrow();
    expect(() => normalizeServerUrl("https://u:p@example.com?q=1")).toThrow();
  });

  it("rejects redirects and validates a fixed paginated revision", async () => {
    const http = new FakeHttp();
    http.responses.push({ status: 302, json: {} });
    const client = new AgentWikiClient(
      "https://wiki.example.com",
      http,
      () => "secret",
    );
    await expect(client.head("space")).rejects.toThrow(/redirect/);
  });

  it("rejects mixed snapshot pages before returning any combined result", async () => {
    const http = new FakeHttp();
    const page = {
      protocolVersion: "1",
      spaceId: "space",
      revision: "r1",
      sequence: 1,
      revisionContentHash: "a".repeat(64),
      pageCount: "2",
      revisionManifestByteLength: "10",
      revisionBodyBytes: "2",
      items: [],
      nextCursor: "next",
    };
    http.responses.push(
      { status: 200, json: page },
      {
        status: 200,
        json: {
          ...page,
          revisionContentHash: "b".repeat(64),
          nextCursor: null,
        },
      },
    );
    await expect(
      new AgentWikiClient(
        "https://wiki.example.com",
        http,
        () => "secret",
      ).snapshot("space"),
    ).rejects.toThrow(/元数据已变更/);
  });

  it("stores a credential before exchange and activates only after verification", async () => {
    const http = new FakeHttp();
    http.route("POST", "/api/integrations/obsidian/exchange", {
      status: 201,
      json: {
        protocolVersion: "1",
        serverInstanceId: "11111111-1111-4111-8111-111111111111",
        credentialId: "22222222-2222-4222-8222-222222222222",
        credentialStatus: "provisional",
        provisionalExpiresAt: "2026-08-14T01:00:00.000Z",
        user: { id: "u", displayName: "U" },
        capabilities: FakeHttp.capabilities,
      },
    });
    const session = {
      protocolVersion: "1",
      serverInstanceId: "11111111-1111-4111-8111-111111111111",
      credentialId: "22222222-2222-4222-8222-222222222222",
      deviceId: "33333333-3333-4333-8333-333333333333",
      deviceName: "Phone",
      vaultId: "44444444-4444-4444-8444-444444444444",
      createdAt: "2026-08-14T00:00:00.000Z",
      lastUsedAt: "2026-08-14T00:00:00.000Z",
      credentialStatus: "provisional",
      provisionalExpiresAt: "2026-08-14T01:00:00.000Z",
      user: { id: "u", displayName: "U" },
      capabilities: FakeHttp.capabilities,
    };
    http.responses.push(
      {
        status: 201,
        json: {
          protocolVersion: "1",
          serverInstanceId: "11111111-1111-4111-8111-111111111111",
          credentialId: "22222222-2222-4222-8222-222222222222",
          credentialStatus: "provisional",
          provisionalExpiresAt: "2026-08-14T01:00:00.000Z",
          user: { id: "u", displayName: "U" },
          capabilities: FakeHttp.capabilities,
        },
      },
      { status: 200, json: session },
      {
        status: 200,
        json: { protocolVersion: "1", credentialStatus: "active" },
      },
      {
        status: 200,
        json: {
          ...session,
          credentialStatus: "active",
          provisionalExpiresAt: null,
        },
      },
    );
    http.route(
      "POST",
      "/api/integrations/obsidian/credentials/current/activate",
      {
        status: 200,
        json: { protocolVersion: "1", credentialStatus: "active" },
      },
    );
    const secrets = new MemorySecrets();
    const control = new MemoryControlStore();
    const cachedProtocols = new ProtocolSelectionRepository(control);
    await cachedProtocols.write(
      {
        serverOrigin: "https://wiki.example.com",
        serverInstanceId: "11111111-1111-4111-8111-111111111111",
        pluginVersion: "0.1.0",
      },
      { version: "1", reason: "endpoint_missing" },
    );
    const service = new ConnectionService(http, secrets, control);
    const result = await service.connect({
      serverUrl: "https://wiki.example.com",
      code: "a".repeat(27),
      deviceId: "33333333-3333-4333-8333-333333333333",
      deviceName: "Phone",
      vaultId: "44444444-4444-4444-8444-444444444444",
      pluginVersion: "0.1.0",
    });
    expect(result.credentialSecretId).toMatch(
      /^agentwiki-sync-secret-[0-9a-f]{32}$/,
    );
    expect(secrets.get(result.credentialSecretId)).toHaveLength(43);
    expect(http.calls.map((call) => call.path)).toEqual([
      "/api/integrations/obsidian/exchange",
      "/api/integrations/obsidian/session",
      "/api/integrations/obsidian/credentials/current/activate",
      "/api/integrations/obsidian/session",
    ]);
    expect(http.calls[0]?.body).toMatchObject({
      supportedProtocolVersions: ["3", "2", "1"],
    });
    expect(await control.read("connection-journal.json")).toBeNull();
    expect(await control.read("connection-state.json")).toContain(
      result.credentialId,
    );
    await expect(
      cachedProtocols.readFor({
        serverOrigin: "https://wiki.example.com",
        serverInstanceId: result.serverInstanceId,
        pluginVersion: "0.1.0",
      }),
    ).resolves.toBeNull();
  });

  it("keeps the code and rotates credential material on an explicit collision", async () => {
    const http = new FakeHttp();
    http.responses.push(
      {
        status: 409,
        json: {
          protocolVersion: "1",
          error: {
            code: "CREDENTIAL_COLLISION",
            message: "collision",
            retryable: false,
          },
        },
      },
      {
        status: 201,
        json: {
          protocolVersion: "1",
          serverInstanceId: "11111111-1111-4111-8111-111111111111",
          credentialId: "22222222-2222-4222-8222-222222222222",
          credentialStatus: "provisional",
          provisionalExpiresAt: "2026-08-14T01:00:00.000Z",
          user: { id: "u", displayName: "U" },
          capabilities: FakeHttp.capabilities,
        },
      },
      {
        status: 200,
        json: {
          protocolVersion: "1",
          serverInstanceId: "11111111-1111-4111-8111-111111111111",
          credentialId: "22222222-2222-4222-8222-222222222222",
          deviceId: "33333333-3333-4333-8333-333333333333",
          deviceName: "Phone",
          vaultId: "44444444-4444-4444-8444-444444444444",
          createdAt: "2026-08-14T00:00:00.000Z",
          lastUsedAt: "2026-08-14T00:00:00.000Z",
          credentialStatus: "provisional",
          provisionalExpiresAt: "2026-08-14T01:00:00.000Z",
          user: { id: "u", displayName: "U" },
          capabilities: FakeHttp.capabilities,
        },
      },
      {
        status: 200,
        json: { protocolVersion: "1", credentialStatus: "active" },
      },
      {
        status: 200,
        json: {
          protocolVersion: "1",
          serverInstanceId: "11111111-1111-4111-8111-111111111111",
          credentialId: "22222222-2222-4222-8222-222222222222",
          deviceId: "33333333-3333-4333-8333-333333333333",
          deviceName: "Phone",
          vaultId: "44444444-4444-4444-8444-444444444444",
          createdAt: "2026-08-14T00:00:00.000Z",
          lastUsedAt: "2026-08-14T00:00:00.000Z",
          credentialStatus: "active",
          provisionalExpiresAt: null,
          user: { id: "u", displayName: "U" },
          capabilities: FakeHttp.capabilities,
        },
      },
    );
    const secrets = new MemorySecrets();
    await new ConnectionService(
      http,
      secrets,
      new MemoryControlStore(),
    ).connect({
      serverUrl: "https://wiki.example.com",
      code: "a".repeat(27),
      deviceId: "33333333-3333-4333-8333-333333333333",
      deviceName: "Phone",
      vaultId: "44444444-4444-4444-8444-444444444444",
      pluginVersion: "0.1.0",
    });
    const exchanges = http.calls.filter(
      (call) => call.path === "/api/integrations/obsidian/exchange",
    );
    expect(exchanges).toHaveLength(2);
    expect((exchanges[0]!.body as { credential: string }).credential).not.toBe(
      (exchanges[1]!.body as { credential: string }).credential,
    );
    expect((exchanges[0]!.body as { code: string }).code).toBe(
      (exchanges[1]!.body as { code: string }).code,
    );
  });

  it("replays the exact prepared exchange after an authentication probe fails", async () => {
    const http = new FakeHttp();
    const control = new MemoryControlStore();
    const secrets = new MemorySecrets();
    const journal = {
      schemaVersion: 1,
      phase: "exchange_prepared",
      serverUrl: "https://wiki.example.com",
      exchangeId: "55555555-5555-4555-8555-555555555555",
      codeSecretId: "code",
      credentialSecretId: "credential",
      deviceId: "33333333-3333-4333-8333-333333333333",
      deviceName: "Phone",
      vaultId: "44444444-4444-4444-8444-444444444444",
      pluginVersion: "0.1.0",
    };
    await control.write("connection-journal.json", JSON.stringify(journal));
    secrets.set("code", "a".repeat(27));
    secrets.set("credential", "b".repeat(43));
    const session = {
      protocolVersion: "1",
      serverInstanceId: "11111111-1111-4111-8111-111111111111",
      credentialId: "22222222-2222-4222-8222-222222222222",
      deviceId: journal.deviceId,
      deviceName: "Phone",
      vaultId: journal.vaultId,
      createdAt: "2026-08-14T00:00:00.000Z",
      lastUsedAt: "2026-08-14T00:00:00.000Z",
      credentialStatus: "provisional",
      provisionalExpiresAt: "2026-08-14T01:00:00.000Z",
      user: { id: "u", displayName: "U" },
      capabilities: FakeHttp.capabilities,
    };
    http.responses.push(
      { status: 401, json: {} },
      {
        status: 201,
        json: {
          protocolVersion: "1",
          serverInstanceId: session.serverInstanceId,
          credentialId: session.credentialId,
          credentialStatus: "provisional",
          provisionalExpiresAt: session.provisionalExpiresAt,
          user: session.user,
          capabilities: FakeHttp.capabilities,
        },
      },
      { status: 200, json: session },
      {
        status: 200,
        json: { protocolVersion: "1", credentialStatus: "active" },
      },
      {
        status: 200,
        json: {
          ...session,
          credentialStatus: "active",
          provisionalExpiresAt: null,
        },
      },
    );
    await new ConnectionService(http, secrets, control).connect({
      serverUrl: journal.serverUrl,
      code: "a".repeat(27),
      deviceId: journal.deviceId,
      deviceName: journal.deviceName,
      vaultId: journal.vaultId,
      pluginVersion: journal.pluginVersion,
    });
    const exchange = http.calls.find((call) => call.path.endsWith("/exchange"));
    expect(exchange?.body).toMatchObject({
      exchangeId: journal.exchangeId,
      code: "a".repeat(27),
      credential: "b".repeat(43),
    });
  });

  it("rejects remote snapshot paths that are not portable relative markdown paths", async () => {
    const http = new FakeHttp();
    http.responses.push({
      status: 200,
      json: {
        protocolVersion: "1",
        spaceId: "space",
        revision: "r1",
        sequence: 1,
        revisionContentHash: "h",
        pageCount: "1",
        revisionManifestByteLength: "1",
        revisionBodyBytes: "1",
        items: [
          {
            pageId: "p",
            path: "../../Private.md",
            title: "Private",
            body: "x",
            contentHash: "h",
            updatedAt: "2026-08-14T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      },
    });
    await expect(
      new AgentWikiClient(
        "https://wiki.example.com",
        http,
        () => "secret",
      ).snapshot("space"),
    ).rejects.toThrow(/relative segment|portable/i);
  });

  it("sends push requests using the same canonical bytes that are hashed", async () => {
    const http = new FakeHttp();
    http.responses.push({
      status: 200,
      json: { protocolVersion: "1", receipt: "ok" },
    });
    const client = new AgentWikiClient(
      "https://wiki.example.com",
      http,
      () => "secret",
    );
    const remote = new (
      await import("../../src/agentwiki/push-remote")
    ).AgentWikiPushRemote(client, "space");
    const body = {
      protocolVersion: "1" as const,
      batchIndex: 0,
      changes: [
        { operation: "archive" as const, pageId: "p1", previousPath: "A.md" },
      ],
    };
    const { batchHash, canonicalBytes } =
      await import("../../src/agentwiki/protocol");
    const batch = { ...body, batchHash: await batchHash(body) };
    await remote.uploadBatch("11111111-1111-4111-8111-111111111111", batch);
    expect(http.calls[0]?.canonicalBody).toEqual(canonicalBytes(batch));
  });

  it("discards a stale journal from another Vault and reconnects fresh", async () => {
    const http = new FakeHttp();
    const control = new MemoryControlStore();
    const secrets = new MemorySecrets();
    await control.write(
      "connection-journal.json",
      JSON.stringify({
        schemaVersion: 1,
        phase: "exchange_prepared",
        serverUrl: "https://wiki.example.com",
        exchangeId: "x",
        codeSecretId: "code",
        credentialSecretId: "credential",
        deviceId: "33333333-3333-4333-8333-333333333333",
        deviceName: "Phone",
        vaultId: "44444444-4444-4444-8444-444444444444",
        pluginVersion: "0.1.0",
      }),
    );
    secrets.set("code", "old-code");
    secrets.set("credential", "dead-credential");
    const session = {
      protocolVersion: "1",
      serverInstanceId: "11111111-1111-4111-8111-111111111111",
      credentialId: "22222222-2222-4222-8222-222222222222",
      deviceId: "33333333-3333-4333-8333-333333333333",
      deviceName: "Phone",
      vaultId: "99999999-9999-4999-8999-999999999999",
      createdAt: "2026-08-14T00:00:00.000Z",
      lastUsedAt: "2026-08-14T00:00:00.000Z",
      credentialStatus: "active",
      provisionalExpiresAt: null,
      user: { id: "u", displayName: "U" },
      capabilities: FakeHttp.capabilities,
    };
    http.route("POST", "/api/integrations/obsidian/exchange", {
      status: 201,
      json: {
        protocolVersion: "1",
        serverInstanceId: session.serverInstanceId,
        credentialId: session.credentialId,
        credentialStatus: "provisional",
        provisionalExpiresAt: "2026-08-14T01:00:00.000Z",
        user: session.user,
        capabilities: FakeHttp.capabilities,
      },
    });
    http.route("GET", "/api/integrations/obsidian/session", {
      status: 200,
      json: session,
    });
    http.route(
      "POST",
      "/api/integrations/obsidian/credentials/current/activate",
      {
        status: 200,
        json: { protocolVersion: "1", credentialStatus: "active" },
      },
    );
    const result = await new ConnectionService(http, secrets, control).connect({
      serverUrl: "https://wiki.example.com",
      code: "c".repeat(27),
      deviceId: "33333333-3333-4333-8333-333333333333",
      deviceName: "Phone",
      vaultId: "99999999-9999-4999-8999-999999999999",
      pluginVersion: "0.1.0",
    });
    expect(result.credentialId).toBe(session.credentialId);
    // The stale journal's secrets must be wiped, not replayed.
    expect(secrets.get("code")).toBe("");
    expect(secrets.get("credential")).toBe("");
    expect(await control.read("connection-journal.json")).toBeNull();
  });
});

describe("connection retry recovery", () => {
  it("discards a dead pending journal and retries with the fresh code", async () => {
    const http = new FakeHttp();
    const control = new MemoryControlStore();
    const secrets = new MemorySecrets();
    // Legacy envelope journal from a previous failed attempt
    await control.write(
      "connection-journal.json.next",
      JSON.stringify({
        envelopeSchemaVersion: 1,
        writeGeneration: 1,
        payloadHash: await sha256Hex(
          canonicalBytes({
            schemaVersion: 1,
            phase: "exchange_prepared",
            serverUrl: "https://wiki.example.com",
            exchangeId: "55555555-5555-4555-8555-555555555555",
            codeSecretId: "old-code",
            credentialSecretId: "old-credential",
            deviceId: "33333333-3333-4333-8333-333333333333",
            deviceName: "Phone",
            vaultId: "44444444-4444-4444-8444-444444444444",
            pluginVersion: "0.1.0",
          }),
        ),
        payload: {
          schemaVersion: 1,
          phase: "exchange_prepared",
          serverUrl: "https://wiki.example.com",
          exchangeId: "55555555-5555-4555-8555-555555555555",
          codeSecretId: "old-code",
          credentialSecretId: "old-credential",
          deviceId: "33333333-3333-4333-8333-333333333333",
          deviceName: "Phone",
          vaultId: "44444444-4444-4444-8444-444444444444",
          pluginVersion: "0.1.0",
        },
      }),
    );
    await control.rename(
      "connection-journal.json.next",
      "connection-journal.json",
    );
    secrets.set("old-code", "old");
    secrets.set("old-credential", "dead");

    const session = {
      protocolVersion: "1",
      serverInstanceId: "11111111-1111-4111-8111-111111111111",
      credentialId: "22222222-2222-4222-8222-222222222222",
      deviceId: "33333333-3333-4333-8333-333333333333",
      deviceName: "Phone",
      vaultId: "44444444-4444-4444-8444-444444444444",
      createdAt: "2026-08-14T00:00:00.000Z",
      lastUsedAt: "2026-08-14T00:00:00.000Z",
      credentialStatus: "provisional",
      provisionalExpiresAt: "2026-08-14T01:00:00.000Z",
      user: { id: "u", displayName: "U" },
      capabilities: FakeHttp.capabilities,
    };
    http.responses.push(
      {
        status: 201,
        json: {
          protocolVersion: "1",
          serverInstanceId: session.serverInstanceId,
          credentialId: session.credentialId,
          credentialStatus: "provisional",
          provisionalExpiresAt: session.provisionalExpiresAt,
          user: session.user,
          capabilities: FakeHttp.capabilities,
        },
      },
      { status: 200, json: session },
      {
        status: 200,
        json: { protocolVersion: "1", credentialStatus: "active" },
      },
      {
        status: 200,
        json: {
          ...session,
          credentialStatus: "active",
          provisionalExpiresAt: null,
        },
      },
    );

    const result = await new ConnectionService(http, secrets, control).connect({
      serverUrl: "https://wiki.example.com",
      code: "a".repeat(27),
      deviceId: "33333333-3333-4333-8333-333333333333",
      deviceName: "Phone",
      vaultId: "44444444-4444-4444-8444-444444444444",
      pluginVersion: "0.1.0",
    });
    expect(result.credentialId).toBe("22222222-2222-4222-8222-222222222222");
    // old secrets were cleared
    expect(secrets.get("old-code")).toBe("");
    expect(secrets.get("old-credential")).toBe("");
  });
});

describe("connection cancellation", () => {
  it("does not activate or commit when cancellation arrives after exchange", async () => {
    const base = new FakeHttp();
    const abort = new AbortController();
    base.enqueue({
      status: 201,
      json: {
        protocolVersion: "1",
        serverInstanceId: "11111111-1111-4111-8111-111111111111",
        credentialId: "22222222-2222-4222-8222-222222222222",
        credentialStatus: "provisional",
        provisionalExpiresAt: "2026-08-14T01:00:00.000Z",
        user: { id: "u", displayName: "U" },
        capabilities: FakeHttp.capabilities,
      },
    });
    const http = {
      request: async (request: Parameters<FakeHttp["request"]>[0]) => {
        const response = await base.request(request);
        abort.abort();
        return response;
      },
    };
    const control = new MemoryControlStore();

    await expect(
      new ConnectionService(http, new MemorySecrets(), control).connect({
        serverUrl: "https://wiki.example.com",
        code: "a".repeat(27),
        deviceId: "33333333-3333-4333-8333-333333333333",
        deviceName: "Phone",
        vaultId: "44444444-4444-4444-8444-444444444444",
        pluginVersion: "0.1.0",
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(base.calls.map((call) => call.path)).toEqual([
      "/api/integrations/obsidian/exchange",
    ]);
    expect(await control.read("connection-state.json")).toBeNull();
  });

  it("does not activate when cancellation arrives while persisting the activation phase", async () => {
    const http = new FakeHttp();
    const abort = new AbortController();
    http.enqueue({
      status: 201,
      json: {
        protocolVersion: "1",
        serverInstanceId: "11111111-1111-4111-8111-111111111111",
        credentialId: "22222222-2222-4222-8222-222222222222",
        credentialStatus: "provisional",
        provisionalExpiresAt: "2026-08-14T01:00:00.000Z",
        user: { id: "u", displayName: "U" },
        capabilities: FakeHttp.capabilities,
      },
    });
    http.enqueue({
      status: 200,
      json: {
        protocolVersion: "1",
        serverInstanceId: "11111111-1111-4111-8111-111111111111",
        credentialId: "22222222-2222-4222-8222-222222222222",
        credentialStatus: "provisional",
        deviceId: "33333333-3333-4333-8333-333333333333",
        deviceName: "Phone",
        vaultId: "44444444-4444-4444-8444-444444444444",
        createdAt: "2026-08-14T00:00:00.000Z",
        lastUsedAt: "2026-08-14T00:00:00.000Z",
        provisionalExpiresAt: "2026-08-14T01:00:00.000Z",
        user: { id: "u", displayName: "U" },
        capabilities: FakeHttp.capabilities,
      },
    });
    const control = new MemoryControlStore();
    let journalWrites = 0;
    control.onTextWrite = async (path) => {
      if (!path.endsWith("connection-journal.json.next")) return;
      journalWrites += 1;
      if (journalWrites === 3) abort.abort();
    };

    await expect(
      new ConnectionService(http, new MemorySecrets(), control).connect({
        serverUrl: "https://wiki.example.com",
        code: "a".repeat(27),
        deviceId: "33333333-3333-4333-8333-333333333333",
        deviceName: "Phone",
        vaultId: "44444444-4444-4444-8444-444444444444",
        pluginVersion: "0.1.0",
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(http.calls.map((call) => call.path)).toEqual([
      "/api/integrations/obsidian/exchange",
      "/api/integrations/obsidian/session",
    ]);
    expect(await control.read("connection-state.json")).toBeNull();
  });

  it("resumes an activating journal without discarding its credential or exchanging again", async () => {
    const http = new FakeHttp();
    const control = new MemoryControlStore();
    const secrets = new MemorySecrets();
    const credentialSecretId = "agentwiki-sync-secret-existing";
    const codeSecretId = "agentwiki-sync-secret-cleared-code";
    secrets.set(credentialSecretId, "existing-credential");
    secrets.set(codeSecretId, "");
    await control.write(
      "connection-journal.json",
      JSON.stringify({
        schemaVersion: 1,
        phase: "activating",
        serverUrl: "https://wiki.example.com",
        exchangeId: "55555555-5555-4555-8555-555555555555",
        codeSecretId,
        credentialSecretId,
        credentialId: "22222222-2222-4222-8222-222222222222",
        serverInstanceId: "11111111-1111-4111-8111-111111111111",
        deviceId: "33333333-3333-4333-8333-333333333333",
        deviceName: "Phone",
        vaultId: "44444444-4444-4444-8444-444444444444",
        pluginVersion: "0.5.0",
      }),
    );
    const activeSession = {
      protocolVersion: "1",
      serverInstanceId: "11111111-1111-4111-8111-111111111111",
      credentialId: "22222222-2222-4222-8222-222222222222",
      credentialStatus: "active",
      deviceId: "33333333-3333-4333-8333-333333333333",
      deviceName: "Phone",
      vaultId: "44444444-4444-4444-8444-444444444444",
      createdAt: "2026-08-14T00:00:00.000Z",
      lastUsedAt: "2026-08-14T00:00:00.000Z",
      provisionalExpiresAt: null,
      user: { id: "u", displayName: "U" },
      capabilities: FakeHttp.capabilities,
    };
    http.enqueue({ status: 200, json: activeSession });
    http.enqueue({ status: 200, json: activeSession });

    await new ConnectionService(http, secrets, control).connect({
      serverUrl: "https://wiki.example.com",
      code: "new-authorized-code-123456789",
      deviceId: "33333333-3333-4333-8333-333333333333",
      deviceName: "Phone",
      vaultId: "44444444-4444-4444-8444-444444444444",
      pluginVersion: "0.5.0",
    });

    expect(http.calls.map((call) => call.path)).toEqual([
      "/api/integrations/obsidian/session",
      "/api/integrations/obsidian/session",
    ]);
    expect(secrets.get(credentialSecretId)).toBe("existing-credential");
  });

  it("replaces an advanced journal only after its credential is confirmed terminal", async () => {
    const http = new FakeHttp();
    const control = new MemoryControlStore();
    const secrets = new MemorySecrets();
    const oldCredentialSecretId = "agentwiki-sync-secret-old-credential";
    const oldCodeSecretId = "agentwiki-sync-secret-old-code";
    secrets.set(oldCredentialSecretId, "old-credential");
    secrets.set(oldCodeSecretId, "");
    await control.write(
      "connection-journal.json",
      JSON.stringify({
        schemaVersion: 1,
        phase: "activating",
        serverUrl: "https://wiki.example.com",
        exchangeId: "55555555-5555-4555-8555-555555555555",
        codeSecretId: oldCodeSecretId,
        credentialSecretId: oldCredentialSecretId,
        credentialId: "22222222-2222-4222-8222-222222222222",
        serverInstanceId: "11111111-1111-4111-8111-111111111111",
        deviceId: "33333333-3333-4333-8333-333333333333",
        deviceName: "Phone",
        vaultId: "44444444-4444-4444-8444-444444444444",
        pluginVersion: "0.5.0",
      }),
    );
    const session = {
      protocolVersion: "1",
      serverInstanceId: "11111111-1111-4111-8111-111111111111",
      credentialId: "66666666-6666-4666-8666-666666666666",
      credentialStatus: "provisional",
      deviceId: "33333333-3333-4333-8333-333333333333",
      deviceName: "Phone",
      vaultId: "44444444-4444-4444-8444-444444444444",
      createdAt: "2026-08-14T00:00:00.000Z",
      lastUsedAt: "2026-08-14T00:00:00.000Z",
      provisionalExpiresAt: "2026-08-14T01:00:00.000Z",
      user: { id: "u", displayName: "U" },
      capabilities: FakeHttp.capabilities,
    };
    http.responses.push(
      {
        status: 401,
        json: {
          protocolVersion: "1",
          error: {
            code: "DEVICE_CREDENTIAL_REVOKED",
            message: "revoked",
            retryable: false,
          },
        },
      },
      {
        status: 201,
        json: {
          protocolVersion: "1",
          serverInstanceId: session.serverInstanceId,
          credentialId: session.credentialId,
          credentialStatus: "provisional",
          provisionalExpiresAt: session.provisionalExpiresAt,
          user: session.user,
          capabilities: FakeHttp.capabilities,
        },
      },
      { status: 200, json: session },
      {
        status: 200,
        json: { protocolVersion: "1", credentialStatus: "active" },
      },
      {
        status: 200,
        json: {
          ...session,
          credentialStatus: "active",
          provisionalExpiresAt: null,
        },
      },
    );

    const result = await new ConnectionService(http, secrets, control).connect({
      serverUrl: "https://wiki.example.com",
      code: "fresh-authorized-code-1234567",
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      vaultId: session.vaultId,
      pluginVersion: "0.5.0",
    });

    expect(http.calls.map((call) => call.path)).toEqual([
      "/api/integrations/obsidian/session",
      "/api/integrations/obsidian/exchange",
      "/api/integrations/obsidian/session",
      "/api/integrations/obsidian/credentials/current/activate",
      "/api/integrations/obsidian/session",
    ]);
    expect(result.credentialId).toBe(session.credentialId);
    expect(secrets.get(oldCredentialSecretId)).toBe("");
  });

  it.each([
    { status: 403, code: "ACCESS_DENIED" },
    { status: 401, code: "UNKNOWN_AUTH_ERROR" },
    { status: 503, code: "SERVICE_UNAVAILABLE" },
  ])(
    "preserves an advanced journal for unknown $status/$code responses",
    async ({ status, code }) => {
      const http = new FakeHttp();
      const control = new MemoryControlStore();
      const secrets = new MemorySecrets();
      const oldCredentialSecretId = "agentwiki-sync-secret-old-credential";
      const oldCodeSecretId = "agentwiki-sync-secret-old-code";
      secrets.set(oldCredentialSecretId, "old-credential");
      secrets.set(oldCodeSecretId, "");
      await control.write(
        "connection-journal.json",
        JSON.stringify({
          schemaVersion: 1,
          phase: "credential_stored",
          serverUrl: "https://wiki.example.com",
          exchangeId: "55555555-5555-4555-8555-555555555555",
          codeSecretId: oldCodeSecretId,
          credentialSecretId: oldCredentialSecretId,
          credentialId: "22222222-2222-4222-8222-222222222222",
          serverInstanceId: "11111111-1111-4111-8111-111111111111",
          deviceId: "33333333-3333-4333-8333-333333333333",
          deviceName: "Phone",
          vaultId: "44444444-4444-4444-8444-444444444444",
          pluginVersion: "0.5.0",
        }),
      );
      http.enqueue({
        status,
        json: {
          protocolVersion: "1",
          error: {
            code,
            message: "unknown policy response",
            retryable: false,
          },
        },
      });

      await expect(
        new ConnectionService(http, secrets, control).connect({
          serverUrl: "https://wiki.example.com",
          code: "fresh-authorized-code-1234567",
          deviceId: "33333333-3333-4333-8333-333333333333",
          deviceName: "Phone",
          vaultId: "44444444-4444-4444-8444-444444444444",
          pluginVersion: "0.5.0",
        }),
      ).rejects.toMatchObject({ status });

      expect(http.calls.map((call) => call.path)).toEqual([
        "/api/integrations/obsidian/session",
      ]);
      expect(secrets.get(oldCredentialSecretId)).toBe("old-credential");
      expect(await control.read("connection-journal.json")).not.toBeNull();
    },
  );
});
