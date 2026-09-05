import { describe, expect, it } from "vitest";
import {
  AgentWikiClient,
  AgentWikiHttpError,
} from "../../src/agentwiki/client";
import {
  canonicalBytes,
  capabilitiesHash,
  sha256Hex,
} from "../../src/agentwiki/protocol";
import { treeCapabilitiesHashV3 } from "@neomei/agentwiki-sync-protocol";
import type { HttpPort } from "../../src/ports/http";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { FakeHttp } from "../fakes/fake-http";
import {
  ProtocolNegotiator,
  type ProtocolProbeIdentity,
} from "../../src/application/protocol-negotiator";
import { ProtocolSelectionRepository } from "../../src/storage/protocol-selection";
import {
  assertTreeRuntimeProtocolVersion,
  TreeRuntimeProtocolUnavailableError,
} from "../../src/ports/tree-remote";

const identity: ProtocolProbeIdentity = {
  serverOrigin: "https://wiki.example.com",
  serverInstanceId: "11111111-1111-4111-8111-111111111111",
  pluginVersion: "0.2.12",
};

function fakeClientRejecting(error: unknown): AgentWikiClient {
  const http: HttpPort = {
    async request() {
      throw error;
    },
  };
  return new AgentWikiClient("https://wiki.example.com", http, () => "secret");
}

function fakeClientReturningV2(json: unknown): AgentWikiClient {
  const http = new FakeHttp();
  http.responses.push(newResponse(404, {}), newResponse(200, json));
  return new AgentWikiClient("https://wiki.example.com", http, () => "secret");
}

function syncHttpError(status: number, code: string): AgentWikiHttpError {
  return new AgentWikiHttpError(status, {
    protocolVersion: "1",
    error: { code, message: code, retryable: false },
  });
}

function negotiator(client: AgentWikiClient): ProtocolNegotiator {
  return new ProtocolNegotiator(
    client,
    new ProtocolSelectionRepository(new MemoryControlStore()),
  );
}

const validCapabilities = {
  maxPageBytes: 1048576,
  maxBatchBytes: 1048576,
  maxBatchItems: 100,
  maxChangeCount: 100,
  maxConfirmationBytes: 1048576,
  maxClientSpacePages: 5000,
  maxClientSpaceFolders: 10000,
  maxSnapshotObjects: 15000,
  maxClientManifestBytes: 1048576,
  maxClientTotalBodyBytes: 2097152,
  maxDeltaItems: 15000,
  maxResponseBytes: 1048576,
  maxPageItems: 200,
  pushSessionTtlSeconds: 900,
};

const validV3Capabilities = {
  ...validCapabilities,
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxRevisionAttachments: 1000,
  maxTransferBlobBytes: 100 * 1024 * 1024,
  blobChunkBytes: 1024 * 1024,
  maxBlobChunks: 10,
  maxConcurrentBlobs: 2,
  maxImageDimension: 10_000,
  maxDecodedPixels: 40_000_000,
  allowedMimeTypes: [
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
  ] as Array<"image/gif" | "image/jpeg" | "image/png" | "image/webp">,
  blobStagingTtlSeconds: 900,
  downloadAuthorizationTtlSeconds: 300,
};

describe("ProtocolNegotiator", () => {
  it("selects v3 before probing v2", async () => {
    const http = new FakeHttp();
    const capabilitiesHashValue =
      await treeCapabilitiesHashV3(validV3Capabilities);
    http.route("GET", "/api/sync/v3/capabilities", {
      status: 200,
      json: {
        protocolVersion: "3",
        capabilities: validV3Capabilities,
        capabilitiesHash: capabilitiesHashValue,
      },
    });
    const subject = negotiator(
      new AgentWikiClient("https://wiki.example.com", http, () => "secret"),
    );

    await expect(subject.select(identity)).resolves.toEqual({
      version: "3",
      capabilities: validV3Capabilities,
      capabilitiesHash: capabilitiesHashValue,
    });
    expect(http.calls.map((call) => call.path)).toEqual([
      "/api/sync/v3/capabilities",
    ]);
  });

  it.each([401, 403, 409, 429, 500])(
    "does not hide a real v3 failure by downgrading (%s)",
    async (status) => {
      const http = new FakeHttp();
      http.responses.push(newResponse(status, {}));
      await expect(
        negotiator(
          new AgentWikiClient("https://wiki.example.com", http, () => "secret"),
        ).select(identity),
      ).rejects.toMatchObject({ status });
      expect(http.calls.map((call) => call.path)).toEqual([
        "/api/sync/v3/capabilities",
      ]);
    },
  );

  it("does not hide a v3 schema failure by downgrading", async () => {
    const http = new FakeHttp();
    http.responses.push(newResponse(200, { protocolVersion: "3" }));
    await expect(
      negotiator(
        new AgentWikiClient("https://wiki.example.com", http, () => "secret"),
      ).select(identity),
    ).rejects.toThrow();
    expect(http.calls.map((call) => call.path)).toEqual([
      "/api/sync/v3/capabilities",
    ]);
  });

  it.each([
    new TypeError("network unavailable"),
    new SyntaxError("malformed JSON"),
  ])(
    "does not hide a v3 transport or JSON failure by downgrading",
    async (error) => {
      await expect(
        negotiator(fakeClientRejecting(error)).select(identity),
      ).rejects.toBe(error);
    },
  );

  it("probes v2 only after v3 is explicitly unsupported", async () => {
    const http = new FakeHttp();
    const capabilitiesHashValue = await capabilitiesHash(validCapabilities);
    http.responses.push(
      newResponse(400, {
        protocolVersion: "3",
        error: { code: "PROTOCOL_UNSUPPORTED", retryable: false },
      }),
      newResponse(200, {
        protocolVersion: "2",
        capabilities: validCapabilities,
        capabilitiesHash: capabilitiesHashValue,
      }),
    );
    await expect(
      negotiator(
        new AgentWikiClient("https://wiki.example.com", http, () => "secret"),
      ).select(identity),
    ).resolves.toMatchObject({ version: "2" });
    expect(http.calls.map((call) => call.path)).toEqual([
      "/api/sync/v3/capabilities",
      "/api/sync/v2/capabilities",
    ]);
  });

  it("reaches v1 only after both discovery endpoints are unsupported", async () => {
    const http = new FakeHttp();
    http.responses.push(newResponse(404, {}), newResponse(404, {}));
    await expect(
      negotiator(
        new AgentWikiClient("https://wiki.example.com", http, () => "secret"),
      ).select(identity),
    ).resolves.toEqual({ version: "1", reason: "endpoint_missing" });
    expect(http.calls.map((call) => call.path)).toEqual([
      "/api/sync/v3/capabilities",
      "/api/sync/v2/capabilities",
    ]);
  });

  it("fails closed when the server requires a newer protocol", async () => {
    const http = new FakeHttp();
    http.responses.push(
      newResponse(409, {
        protocolVersion: "3",
        error: {
          code: "SYNC_PROTOCOL_UPGRADE_REQUIRED",
          retryable: false,
        },
      }),
    );
    await expect(
      negotiator(
        new AgentWikiClient("https://wiki.example.com", http, () => "secret"),
      ).select(identity),
    ).rejects.toMatchObject({ status: 409 });
    expect(http.calls).toHaveLength(1);
  });

  it("rejects unknown v3 capability fields and hash mismatches", async () => {
    const validHash = await treeCapabilitiesHashV3(validV3Capabilities);
    for (const json of [
      {
        protocolVersion: "3",
        capabilities: { ...validV3Capabilities, futureLimit: 1 },
        capabilitiesHash: validHash,
      },
      {
        protocolVersion: "3",
        capabilities: validV3Capabilities,
        capabilitiesHash: "0".repeat(64),
      },
    ]) {
      const http = new FakeHttp();
      http.responses.push(newResponse(200, json));
      await expect(
        negotiator(
          new AgentWikiClient("https://wiki.example.com", http, () => "secret"),
        ).select(identity),
      ).rejects.toThrow();
      expect(http.calls).toHaveLength(1);
    }
  });

  it("rejects an oversized capabilities response without downgrading", async () => {
    const http = new FakeHttp();
    http.responses.push(
      newResponse(200, {
        protocolVersion: "3",
        capabilities: validV3Capabilities,
        capabilitiesHash: await treeCapabilitiesHashV3(validV3Capabilities),
        padding: "x".repeat(65 * 1024),
      }),
    );
    await expect(
      negotiator(
        new AgentWikiClient("https://wiki.example.com", http, () => "secret"),
      ).select(identity),
    ).rejects.toThrow(/response|size|large|limit/i);
    expect(http.calls).toHaveLength(1);
  });

  it("uses v1 only when the v2 endpoint is absent", async () => {
    const client = fakeClientRejecting(new AgentWikiHttpError(404, {}));
    await expect(negotiator(client).select(identity)).resolves.toEqual({
      version: "1",
      reason: "endpoint_missing",
    });
  });

  it("uses v1 when the server explicitly rejects protocol v2", async () => {
    const client = fakeClientRejecting(
      syncHttpError(400, "PROTOCOL_UNSUPPORTED"),
    );
    await expect(negotiator(client).select(identity)).resolves.toEqual({
      version: "1",
      reason: "protocol_unsupported",
    });
  });

  it.each([401, 403, 409, 429, 500])(
    "does not downgrade a real v2 failure (%s)",
    async (status) => {
      const http = new FakeHttp();
      http.responses.push(newResponse(404, {}), newResponse(status, {}));
      const client = new AgentWikiClient(
        "https://wiki.example.com",
        http,
        () => "secret",
      );
      await expect(negotiator(client).select(identity)).rejects.toMatchObject({
        status,
      });
      expect(http.calls.map((call) => call.path)).toEqual([
        "/api/sync/v3/capabilities",
        "/api/sync/v2/capabilities",
      ]);
    },
  );

  it("does not downgrade malformed capabilities", async () => {
    const client = fakeClientReturningV2({
      protocolVersion: "2",
      capabilities: {},
    });
    await expect(negotiator(client).select(identity)).rejects.toThrow();
  });

  it("selects v2 when capabilities are valid and hashed consistently", async () => {
    const capabilitiesHashValue = await capabilitiesHash(validCapabilities);
    const client = fakeClientReturningV2({
      protocolVersion: "2",
      capabilities: validCapabilities,
      capabilitiesHash: capabilitiesHashValue,
    });
    await expect(negotiator(client).select(identity)).resolves.toEqual({
      version: "2",
      capabilities: validCapabilities,
      capabilitiesHash: capabilitiesHashValue,
    });
  });

  it("rejects a v2 response whose capabilities hash does not match", async () => {
    const client = fakeClientReturningV2({
      protocolVersion: "2",
      capabilities: validCapabilities,
      capabilitiesHash: "0".repeat(64),
    });
    await expect(negotiator(client).select(identity)).rejects.toThrow(
      /hash mismatch/,
    );
  });

  it("caches the negotiated selection for the same server identity", async () => {
    const http = new FakeHttp();
    const capabilitiesHashValue = await capabilitiesHash(validCapabilities);
    http.route("GET", "/api/sync/v2/capabilities", {
      status: 200,
      json: {
        protocolVersion: "2",
        capabilities: validCapabilities,
        capabilitiesHash: capabilitiesHashValue,
      },
    });
    const client = new AgentWikiClient(
      "https://wiki.example.com",
      http,
      () => "secret",
    );
    const subject = new ProtocolNegotiator(
      client,
      new ProtocolSelectionRepository(new MemoryControlStore()),
    );
    await subject.select(identity);
    await subject.select(identity);
    expect(
      http.calls.filter((call) => call.path === "/api/sync/v2/capabilities"),
    ).toHaveLength(1);
  });
});

describe("ProtocolSelectionRepository", () => {
  it("normalizes the server origin before matching the cache", async () => {
    const store = new MemoryControlStore();
    const repository = new ProtocolSelectionRepository(store);
    await repository.write(
      { ...identity, serverOrigin: "https://WIKI.example.com:443" },
      { version: "1", reason: "endpoint_missing" },
    );
    await expect(repository.readFor(identity)).resolves.toEqual({
      version: "1",
      reason: "endpoint_missing",
    });
  });

  it("rejects legacy selection when a committed v3 generation exists", async () => {
    const http = new FakeHttp();
    http.responses.push(newResponse(404, {}), newResponse(404, {}));
    await expect(
      negotiator(
        new AgentWikiClient("https://wiki.example.com", http, () => "secret"),
      ).select(identity, "3"),
    ).rejects.toMatchObject({ code: "SYNC_PROTOCOL_UPGRADE_REQUIRED" });
  });

  it("returns null when the cached server identity differs", async () => {
    const store = new MemoryControlStore();
    const repository = new ProtocolSelectionRepository(store);
    await repository.write(identity, {
      version: "1",
      reason: "endpoint_missing",
    });
    await expect(
      repository.readFor({
        ...identity,
        serverInstanceId: "99999999-9999-4999-8999-999999999999",
      }),
    ).resolves.toBeNull();
  });

  it("returns null after a plugin version upgrade", async () => {
    const store = new MemoryControlStore();
    const repository = new ProtocolSelectionRepository(store);
    await repository.write(identity, {
      version: "1",
      reason: "endpoint_missing",
    });
    await expect(
      repository.readFor({ ...identity, pluginVersion: "0.2.13" }),
    ).resolves.toBeNull();
  });

  it("returns the cached selection for a matching identity", async () => {
    const store = new MemoryControlStore();
    const repository = new ProtocolSelectionRepository(store);
    const selection = {
      version: "1" as const,
      reason: "endpoint_missing" as const,
    };
    await repository.write(identity, selection);
    await expect(repository.readFor(identity)).resolves.toEqual(selection);
  });

  it("throws for an unknown schema version", async () => {
    const store = new MemoryControlStore();
    const payload = {
      schemaVersion: 2,
      serverOrigin: identity.serverOrigin,
      serverInstanceId: identity.serverInstanceId,
      pluginVersion: identity.pluginVersion,
      selection: { version: "1", reason: "endpoint_missing" },
    };
    await store.write(
      "protocol-selection.json",
      JSON.stringify({
        envelopeSchemaVersion: 1,
        writeGeneration: 1,
        payloadHash: await sha256Hex(canonicalBytes(payload)),
        payload,
      }),
    );
    const repository = new ProtocolSelectionRepository(store);
    await expect(repository.readFor(identity)).rejects.toThrow();
  });
});

describe("tree runtime protocol boundary", () => {
  it("fails explicitly instead of routing selected v3 through a legacy adapter", () => {
    expect(() => assertTreeRuntimeProtocolVersion("3")).toThrowError(
      TreeRuntimeProtocolUnavailableError,
    );
    try {
      assertTreeRuntimeProtocolVersion("3");
    } catch (error) {
      expect(error).toMatchObject({ code: "SYNC_PROTOCOL_UPGRADE_REQUIRED" });
    }
    expect(() => assertTreeRuntimeProtocolVersion("2")).not.toThrow();
    expect(() => assertTreeRuntimeProtocolVersion("1")).not.toThrow();
  });
});

function newResponse(status: number, json: unknown) {
  return { status, json };
}
