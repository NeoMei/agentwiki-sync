import {
  BlobRequirementV3Schema,
  CompleteBlobRequestV3Schema,
  CreateTreePushSessionRequestV3Schema,
  TreeFinalizePushRequestV3Schema,
  TreePushBatchV3Schema,
  blobChunkHashV3,
  capabilitiesHash,
  treeCapabilitiesHashV3,
  type CreateTreePushSessionRequestV3,
} from "@neomei/agentwiki-sync-protocol";
import { describe, expect, it } from "vitest";

import type { HttpPort, HttpResponse } from "../../src/ports/http";
import type { TreeFinalizeResultV3 } from "../../src/ports/tree-remote";
import {
  SuccessfulUpgradeResponseLossHttp,
  verifyLocalImageUpgradeResponseLoss,
  type LostUpgradeResponse,
} from "../../verification/local-image-upgrade-recovery";
import { FakeTreeRemoteV3, V3_CAPABILITIES } from "../fakes/fake-tree-remote";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { MemoryVault } from "../fakes/memory-vault";

const SESSION = "77777777-7777-4777-8777-777777777777";
const EMPTY_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X2NDWQAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);
const V2_CAPABILITIES = {
  maxPageBytes: 1_048_576,
  maxBatchBytes: 4_194_304,
  maxBatchItems: 100,
  maxChangeCount: 100,
  maxConfirmationBytes: 4_194_304,
  maxClientSpacePages: 5_000,
  maxClientSpaceFolders: 10_000,
  maxSnapshotObjects: 15_000,
  maxClientManifestBytes: 4_194_304,
  maxClientTotalBodyBytes: 2_097_152,
  maxDeltaItems: 15_000,
  maxResponseBytes: 4_194_304,
  maxPageItems: 200,
  pushSessionTtlSeconds: 900,
};

class FixedHttp implements HttpPort {
  constructor(private readonly response: HttpResponse) {}

  async request(): Promise<HttpResponse> {
    return structuredClone(this.response);
  }
}

class LocalOnlyUpgradeHttp implements HttpPort {
  private readonly remote = new FakeTreeRemoteV3();
  private readonly v2Hash: string;
  private readonly v3Hash: string;
  private createInput: CreateTreePushSessionRequestV3 | null = null;
  private createResponse: {
    protocolVersion: "3";
    sessionId: string;
    status: "uploading";
    expiresAt: string;
    missingContentHashes: string[];
  } | null = null;
  private published: TreeFinalizeResultV3 | null = null;

  private constructor(v2Hash: string, v3Hash: string) {
    this.v2Hash = v2Hash;
    this.v3Hash = v3Hash;
  }

  static async create(): Promise<LocalOnlyUpgradeHttp> {
    const subject = new LocalOnlyUpgradeHttp(
      await capabilitiesHash(V2_CAPABILITIES),
      await treeCapabilitiesHashV3(V3_CAPABILITIES),
    );
    await subject.remote.seedTree({ revision: "0" });
    subject.remote.syncMode = "legacy_v2";
    return subject;
  }

  private async v3Head(): Promise<Record<string, unknown>> {
    const head = await this.remote.head();
    return { ...head, sequence: this.published ? 1 : 0 };
  }

  private finalized(
    value: Awaited<ReturnType<FakeTreeRemoteV3["finalize"]>>,
  ): TreeFinalizeResultV3 {
    return { ...value, sequence: 1 };
  }

  async request(
    request: Parameters<HttpPort["request"]>[0],
  ): Promise<HttpResponse> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (
      request.method === "GET" &&
      path === "/api/integrations/obsidian/session"
    )
      return {
        status: 200,
        json: {
          protocolVersion: "1",
          serverInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          credentialId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          deviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          deviceName: "Local-only verifier",
          vaultId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          createdAt: "2026-09-06T00:00:00.000Z",
          lastUsedAt: "2026-09-06T00:00:00.000Z",
          credentialStatus: "active",
          provisionalExpiresAt: null,
          user: { id: "local-user", displayName: "Local verifier" },
          capabilities: V2_CAPABILITIES,
        },
      };
    if (request.method === "GET" && path === "/api/sync/v2/capabilities")
      return {
        status: 200,
        json: {
          protocolVersion: "2",
          capabilities: V2_CAPABILITIES,
          capabilitiesHash: this.v2Hash,
        },
      };
    if (request.method === "GET" && path === "/api/sync/v3/capabilities")
      return {
        status: 200,
        json: {
          protocolVersion: "3",
          capabilities: V3_CAPABILITIES,
          capabilitiesHash: this.v3Hash,
        },
      };
    if (request.method === "GET" && path === "/api/sync/v3/spaces")
      return {
        status: 200,
        json: {
          protocolVersion: "3",
          spaces: [
            {
              spaceId: "space",
              displayName: "Local-only legacy fixture",
              role: "owner",
              canRead: true,
              canPublish: true,
              syncMode: this.published ? "native_v3" : "legacy_v2",
              currentRevision: this.published?.revision ?? "0",
              folderCount: this.published?.folderCount ?? "0",
              pageCount: this.published?.pageCount ?? "0",
              attachmentCount: this.published?.attachmentCount ?? "0",
              revisionManifestByteLength:
                this.published?.revisionManifestByteLength ?? "0",
              revisionBodyBytes: this.published?.revisionBodyBytes ?? "0",
              revisionAttachmentBytes:
                this.published?.revisionAttachmentBytes ?? "0",
            },
          ],
        },
      };
    if (request.method === "GET" && path === "/api/sync/v2/spaces/space/head")
      return {
        status: 200,
        json: {
          protocolVersion: "2",
          spaceId: "space",
          revision: "0",
          sequence: 0,
          revisionContentHash: EMPTY_HASH,
          folderCount: "0",
          pageCount: "0",
          revisionManifestByteLength: "0",
          revisionBodyBytes: "0",
          publishedAt: null,
        },
      };
    if (
      request.method === "GET" &&
      path === "/api/sync/v2/spaces/space/snapshot"
    )
      return {
        status: 200,
        json: {
          protocolVersion: "2",
          spaceId: "space",
          revision: "0",
          sequence: 0,
          revisionContentHash: EMPTY_HASH,
          folderCount: "0",
          pageCount: "0",
          revisionManifestByteLength: "0",
          revisionBodyBytes: "0",
          folders: [],
          pages: [],
          nextCursor: null,
        },
      };
    if (
      request.method === "POST" &&
      path === "/api/sync/v3/spaces/space/push-sessions"
    ) {
      const input = CreateTreePushSessionRequestV3Schema.parse(request.body);
      if (this.createInput) {
        if (JSON.stringify(input) !== JSON.stringify(this.createInput))
          throw new Error("local-only idempotency binding changed");
        return { status: 200, json: structuredClone(this.createResponse) };
      }
      this.createInput = structuredClone(input);
      const internal = await this.remote.createPushSession(input);
      this.createResponse = {
        protocolVersion: "3",
        sessionId: SESSION,
        status: "uploading",
        expiresAt: internal.expiresAt,
        missingContentHashes: internal.missingContentHashes,
      };
      return { status: 201, json: structuredClone(this.createResponse) };
    }
    const chunk = path.match(
      /^\/api\/sync\/v3\/spaces\/space\/push-sessions\/[^/]+\/blobs\/([^/]+)\/chunks\/(\d+)$/u,
    );
    if (request.method === "PUT" && chunk) {
      const bytes = request.binaryBody;
      if (!bytes) throw new Error("local-only chunk bytes missing");
      const contentHash = decodeURIComponent(chunk[1]!);
      const chunkIndex = Number(chunk[2]);
      const value = await this.remote.uploadBlobChunk(
        "v3-session-1",
        contentHash,
        chunkIndex,
        bytes,
      );
      return {
        status: 200,
        json: { ...value, chunkHash: await blobChunkHashV3(bytes) },
      };
    }
    const complete = path.match(
      /^\/api\/sync\/v3\/spaces\/space\/push-sessions\/[^/]+\/blobs\/([^/]+)\/complete$/u,
    );
    if (request.method === "POST" && complete) {
      const body = CompleteBlobRequestV3Schema.parse(request.body);
      const requirement = BlobRequirementV3Schema.parse(
        this.createInput?.blobRequirements.find(
          (item) => item.contentHash === body.contentHash,
        ),
      );
      return {
        status: 200,
        json: await this.remote.completeBlob(
          "v3-session-1",
          requirement,
          body.chunkCount,
        ),
      };
    }
    const batch = path.match(
      /^\/api\/sync\/v3\/spaces\/space\/push-sessions\/[^/]+\/batches\/(\d+)$/u,
    );
    if (request.method === "PUT" && batch) {
      const body = TreePushBatchV3Schema.parse(request.body);
      const result = await this.remote.uploadBatch("v3-session-1", body);
      return {
        status: 200,
        json: {
          protocolVersion: "3",
          sessionId: SESSION,
          batchIndex: Number(batch[1]),
          batchHash: body.batchHash,
          receipt: result.receipt,
          receivedBatchCount: this.remote.uploadedBatches.length,
        },
      };
    }
    if (
      request.method === "POST" &&
      path === `/api/sync/v3/spaces/space/push-sessions/${SESSION}/finalize`
    ) {
      const body = TreeFinalizePushRequestV3Schema.parse(request.body);
      this.published = this.finalized(
        await this.remote.finalize("v3-session-1", body.confirmationHash),
      );
      this.remote.syncMode = "native_v3";
      return { status: 200, json: structuredClone(this.published) };
    }
    if (
      request.method === "GET" &&
      path === `/api/sync/v3/spaces/space/push-sessions/${SESSION}`
    ) {
      const value = await this.remote.getSession("v3-session-1");
      return {
        status: 200,
        json: {
          ...value,
          protocolVersion: "3",
          sessionId: SESSION,
          result: value.result ? this.finalized(value.result) : null,
        },
      };
    }
    if (request.method === "GET" && path === "/api/sync/v3/spaces/space/head")
      return { status: 200, json: await this.v3Head() };
    if (
      request.method === "GET" &&
      path === "/api/sync/v3/spaces/space/snapshot"
    ) {
      const revision = url.searchParams.get("revision") ?? "current";
      for await (const page of this.remote.snapshotPages(revision))
        return {
          status: 200,
          json: { ...page, sequence: 1, nextCursor: null },
        };
    }
    const download = path.match(
      /^\/api\/sync\/v3\/spaces\/space\/revisions\/([^/]+)\/attachments\/([^/]+)\/content$/u,
    );
    if (request.method === "GET" && download) {
      const attachmentId = decodeURIComponent(download[2]!);
      const attachment = this.remote.uploadedBatches
        .flatMap((item) => item.changes)
        .find(
          (item) =>
            item.operation === "upsert_attachment" &&
            item.attachment.attachmentId === attachmentId,
        );
      if (!attachment || attachment.operation !== "upsert_attachment")
        throw new Error("local-only attachment missing");
      return {
        status: 200,
        json: undefined,
        bytes: await this.remote.downloadBlob({
          revision: decodeURIComponent(download[1]!),
          attachmentId,
          contentHash: attachment.attachment.contentHash,
        }),
      };
    }
    throw new Error(`unexpected local-only request: ${request.method} ${url}`);
  }
}

async function localRecoveryCase() {
  const vault = new MemoryVault({});
  vault.seedMarkdown(
    "Wiki/pages/note.md",
    "local-only first image\n![[assets/used.png]]\n",
  );
  vault.seedFile("Wiki/assets/used.png", PNG);
  return {
    serverOrigin: "https://wiki.example.com",
    http: await LocalOnlyUpgradeHttp.create(),
    control: new MemoryControlStore(),
    vault,
    controlRoot: ".agentwiki/devices/d-device/spaces/s-space",
    mapping: { spaceId: "space", rootPath: "Wiki", status: "active" as const },
    authority: {
      serverOrigin: "https://wiki.example.com",
      serverInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      pluginVersion: "0.4.0",
      deviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      credentialId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      vaultId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    },
  };
}

describe("local image upgrade live response-loss verifier", () => {
  it("drops a create response only after the transport receives a schema-valid success", async () => {
    const http = new SuccessfulUpgradeResponseLossHttp(
      new FixedHttp({
        status: 201,
        json: {
          protocolVersion: "3",
          sessionId: SESSION,
          status: "uploading",
          expiresAt: "2099-01-01T00:00:00.000Z",
          missingContentHashes: [],
        },
      }),
      "create",
    );
    const request = {
      method: "POST",
      url: "https://wiki.example.com/api/sync/v3/spaces/space/push-sessions",
      body: { idempotencyKey: "11111111-1111-4111-8111-111111111111" },
    };

    await expect(http.request(request)).rejects.toThrow(
      "U7_CREATE_SUCCESS_RESPONSE_LOST",
    );
    expect(http.dropped).toEqual({
      kind: "create",
      path: "/api/sync/v3/spaces/space/push-sessions",
      requestBody: request.body,
      responseStatus: 201,
      responseBody: {
        protocolVersion: "3",
        sessionId: SESSION,
        status: "uploading",
        expiresAt: "2099-01-01T00:00:00.000Z",
        missingContentHashes: [],
      },
      sessionId: SESSION,
    });
  });

  it("does not fabricate a dropped success for a non-success response", async () => {
    const http = new SuccessfulUpgradeResponseLossHttp(
      new FixedHttp({ status: 503, json: { code: "UNAVAILABLE" } }),
      "create",
    );

    await expect(
      http.request({
        method: "POST",
        url: "https://wiki.example.com/api/sync/v3/spaces/space/push-sessions",
        body: {},
      }),
    ).resolves.toEqual({ status: 503, json: { code: "UNAVAILABLE" } });
    expect(http.dropped).toBeNull();
    expect(http.successfulMutations).toEqual([]);
  });

  it("rejects a malformed success before recording or dropping it", async () => {
    const http = new SuccessfulUpgradeResponseLossHttp(
      new FixedHttp({ status: 201, json: { sessionId: SESSION } }),
      "create",
    );

    await expect(
      http.request({
        method: "POST",
        url: "https://wiki.example.com/api/sync/v3/spaces/space/push-sessions",
        body: {},
      }),
    ).rejects.not.toThrow("U7_CREATE_SUCCESS_RESPONSE_LOST");
    expect(http.dropped).toBeNull();
    expect(http.successfulMutations).toEqual([]);
  });

  it.each([
    ["create", 2],
    ["finalize", 1],
  ] as const)(
    "restarts the actual local image upgrade entry after a lost %s success without a second revision",
    async (target: LostUpgradeResponse, createCount: number) => {
      const evidence = await verifyLocalImageUpgradeResponseLoss(
        await localRecoveryCase(),
        target,
      );

      expect(evidence).toMatchObject({
        kind: target,
        sourceRevision: "0",
        publishedRevision: "rev-push-1",
        terminalPhase: "complete",
        verifiedPublicationRevision: "rev-push-1",
        baselineRevision: "rev-push-1",
        beforeSequence: 0,
        afterSequence: 1,
        createCount,
        finalizeCount: 1,
      });
      expect(new Set(evidence.idempotencyKeys)).toEqual(
        new Set([evidence.operationId]),
      );
      expect(new Set(evidence.createSessionIds)).toEqual(new Set([SESSION]));
      expect(evidence.sessionId).toBe(SESSION);
    },
  );
});
