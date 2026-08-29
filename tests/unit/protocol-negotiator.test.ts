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
import type { HttpPort } from "../../src/ports/http";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { FakeHttp } from "../fakes/fake-http";
import {
  ProtocolNegotiator,
  type ProtocolProbeIdentity,
} from "../../src/application/protocol-negotiator";
import { ProtocolSelectionRepository } from "../../src/storage/protocol-selection";

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

function fakeClientReturning(json: unknown): AgentWikiClient {
  const http: HttpPort = {
    async request() {
      return { status: 200, json };
    },
  };
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

describe("ProtocolNegotiator", () => {
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

  it.each([401, 403, 409, 500])(
    "does not downgrade a real v2 failure (%s)",
    async (status) => {
      const client = fakeClientRejecting(new AgentWikiHttpError(status, {}));
      await expect(negotiator(client).select(identity)).rejects.toMatchObject({
        status,
      });
    },
  );

  it("does not downgrade malformed capabilities", async () => {
    const client = fakeClientReturning({
      protocolVersion: "2",
      capabilities: {},
    });
    await expect(negotiator(client).select(identity)).rejects.toThrow();
  });

  it("selects v2 when capabilities are valid and hashed consistently", async () => {
    const capabilitiesHashValue = await capabilitiesHash(validCapabilities);
    const client = fakeClientReturning({
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
    const client = fakeClientReturning({
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
