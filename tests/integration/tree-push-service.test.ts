import { describe, expect, it } from "vitest";

import { AgentWikiHttpError } from "../../src/agentwiki/client";
import { canonicalBytes, capabilitiesHash } from "../../src/agentwiki/protocol";
import type { SyncCapabilities } from "../../src/agentwiki/protocol";
import {
  blobChunkHashV3,
  blobContentHashV3,
  treeBatchHashV3,
  treeCapabilitiesHashV3,
  treeConfirmationHashV3,
  type BlobChunkReceiptV3,
  type BlobRequirementV3,
  type CompletedBlobV3,
  type CreateTreePushSessionRequestV3,
  type TreePushBatchV3,
  type TreePushConfirmationManifestV3,
  type TreePushManifestChangeV3,
  type TreeSyncCapabilitiesV3,
} from "@neomei/agentwiki-sync-protocol";
import { PushService } from "../../src/application/push-service";
import {
  TreePushService,
  type PreparedTreePushChange,
  type TreePushPreview,
} from "../../src/application/tree-push-service";
import {
  TreePushServiceV3,
  type PreparedTreePushChangeV3,
  type TreePushPreviewV3,
} from "../../src/application/tree-push-service-v3";
import type {
  TreeCreatePushSession,
  TreeDelta,
  TreeFinalizeResult,
  TreeHead,
  TreePushBatch,
  TreePushSession,
  TreePushSessionStatus,
  TreeRemotePort,
  TreeSnapshotSegment,
  TreeSpaceSummary,
  TreeSyncLimits,
  TreeFinalizeResultV3,
  TreeHeadV3,
  TreePushSessionStatusV3,
  TreePushSessionV3,
  TreeRemotePortV3,
  TreeSnapshotSegmentV3,
  TreeSpaceSummaryV3,
  TreeBootstrapPreviewV3,
} from "../../src/ports/tree-remote";
import { FakePushRemote } from "../fakes/fake-push-remote";
import { MemoryControlStore } from "../fakes/memory-control-store";

const HELLO_HASH =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

const v2Capabilities: TreeSyncLimits = {
  maxPageBytes: 1048576,
  maxBatchBytes: 4194304,
  maxBatchItems: 100,
  maxChangeCount: 100,
  maxConfirmationBytes: 4194304,
  maxClientSpacePages: 5000,
  maxClientSpaceFolders: 10000,
  maxSnapshotObjects: 15000,
  maxClientManifestBytes: 4194304,
  maxClientTotalBodyBytes: 2097152,
  maxDeltaItems: 15000,
  maxResponseBytes: 4194304,
  maxPageItems: 200,
  pushSessionTtlSeconds: 900,
};

const v1Capabilities: SyncCapabilities = {
  maxPageBytes: 1048576,
  maxBatchBytes: 4194304,
  maxBatchItems: 100,
  maxChangeCount: 5000,
  maxConfirmationBytes: 4194304,
  maxClientSpacePages: 5000,
  maxClientManifestBytes: 4194304,
  maxClientTotalBodyBytes: 104857600,
  maxResponseBytes: 4194304,
  maxPageItems: 200,
  pushSessionTtlSeconds: 900,
};

class FakeTreeRemote implements TreeRemotePort {
  readonly protocolVersion = "2" as const;
  createCount = 0;
  changeCapabilitiesOnCreate = 0;
  loseFirstUploadOnce = false;
  finalizeCalls = 0;
  abortCalls = 0;
  revision = "r1";
  readonly batches: TreePushBatch[] = [];
  private serverCaps: TreeSyncLimits = { ...v2Capabilities };
  private clientCaps: TreeSyncLimits = { ...v2Capabilities };
  private clientHash: Promise<string>;
  private readonly receivedOps: string[] = [];
  private readonly sessions = new Map<string, TreePushSession>();

  constructor() {
    this.clientHash = capabilitiesHash(this.clientCaps);
  }

  get capabilitiesHash(): Promise<string> {
    return this.clientHash;
  }

  async capabilities(): Promise<TreeSyncLimits> {
    return { ...this.clientCaps };
  }

  async refreshCapabilities(): Promise<TreeSyncLimits> {
    this.clientCaps = { ...this.serverCaps };
    this.clientHash = capabilitiesHash(this.clientCaps);
    return { ...this.clientCaps };
  }

  async spaces(): Promise<TreeSpaceSummary[]> {
    return [];
  }

  async head(): Promise<TreeHead> {
    return {
      protocolVersion: "2",
      spaceId: "space",
      revision: this.revision,
      sequence: 0,
      revisionContentHash: "e".repeat(64),
      folderCount: "0",
      pageCount: "0",
      revisionManifestByteLength: "0",
      revisionBodyBytes: "0",
      publishedAt: null,
    };
  }

  async *snapshotPages(): AsyncIterable<TreeSnapshotSegment> {
    yield* [];
  }

  async delta(): Promise<TreeDelta> {
    return { toRevision: this.revision, items: [] };
  }

  async createPushSession(
    _input: TreeCreatePushSession,
  ): Promise<TreePushSession> {
    this.createCount += 1;
    if (this.changeCapabilitiesOnCreate > 0) {
      this.changeCapabilitiesOnCreate -= 1;
      this.serverCaps = {
        ...this.serverCaps,
        maxBatchItems: this.serverCaps.maxBatchItems + 1,
      };
      throw new AgentWikiHttpError(409, {
        error: {
          code: "CAPABILITIES_CHANGED",
          message: "capabilities changed",
          retryable: true,
        },
      });
    }
    const session: TreePushSession = {
      sessionId: `session-${this.createCount}`,
      status: "uploading",
      expiresAt: "2099-01-01T00:00:00.000Z",
      result: null,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  async uploadBatch(
    _sessionId: string,
    batch: TreePushBatch,
  ): Promise<{ receipt: string }> {
    if (this.loseFirstUploadOnce) {
      this.loseFirstUploadOnce = false;
      throw new Error("upload interrupted");
    }
    this.batches.push(batch);
    for (const change of batch.changes) this.receivedOps.push(change.operation);
    return { receipt: `r-${batch.batchIndex}` };
  }

  async finalize(
    sessionId: string,
    _confirmationHash: string,
  ): Promise<TreeFinalizeResult> {
    this.finalizeCalls += 1;
    this.revision = "r2";
    const result: TreeFinalizeResult = {
      protocolVersion: "2",
      status: "published",
      revision: "r2",
      sequence: 1,
      publishedAt: "2026-08-29T00:00:00.000Z",
      revisionContentHash: "e".repeat(64),
      folderCount: "0",
      pageCount: "0",
      revisionManifestByteLength: "0",
      revisionBodyBytes: "0",
      changeSetId: "c1",
    };
    const session = this.sessions.get(sessionId);
    if (session)
      this.sessions.set(sessionId, { ...session, status: "published", result });
    return result;
  }

  async getSession(sessionId: string): Promise<TreePushSessionStatus> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("missing session");
    return {
      sessionId: session.sessionId,
      status: session.status,
      expiresAt: session.expiresAt,
      receivedBatchIndexes: this.batches.map((batch) => batch.batchIndex),
      result: session.result,
    };
  }

  async abort(sessionId: string): Promise<void> {
    this.abortCalls += 1;
    const session = this.sessions.get(sessionId);
    if (session)
      this.sessions.set(sessionId, { ...session, status: "aborted" });
  }

  receivedOperations(): string[] {
    return [...this.receivedOps];
  }
}

let store: MemoryControlStore;

function upsertPage(
  pageId: string,
  folderId: string | null,
  path: string,
): PreparedTreePushChange {
  return {
    operation: "upsert_page",
    page: {
      pageId,
      folderId,
      path,
      title: pageId,
      contentHash: HELLO_HASH,
      updatedAt: "2026-08-29T00:00:00.000Z",
      payloadPath: `preview/${pageId}.md`,
      bodyBytes: 5,
    },
  };
}

function upsertFolder(
  folderId: string,
  parentFolderId: string | null,
  path: string,
): PreparedTreePushChange {
  return {
    operation: "upsert_folder",
    folder: {
      folderId,
      parentFolderId,
      name: path.split("/").at(-1) ?? "Folder",
      path,
      sortOrder: 0,
      updatedAt: "2026-08-29T00:00:00.000Z",
    },
  };
}

async function prepared(
  changes: PreparedTreePushChange[],
  capabilities: TreeSyncLimits = v2Capabilities,
): Promise<TreePushPreview> {
  for (const change of changes)
    if (change.operation === "upsert_page")
      await store.write(change.page.payloadPath, "hello");
  return {
    spaceId: "space",
    baseRevision: "r1",
    changes,
    capabilities,
  };
}

describe("TreePushService", () => {
  it("publishes parent folders before their pages", async () => {
    const remote = new FakeTreeRemote();
    store = new MemoryControlStore();
    const service = new TreePushService(remote, store, ".agentwiki/tree/p1");
    const result = await service.publishPrepared(
      await prepared([
        upsertPage("p1", "f1", "pages/A/P.md"),
        upsertFolder("f1", null, "pages/A"),
      ]),
    );
    expect(remote.receivedOperations()).toEqual([
      "upsert_folder",
      "upsert_page",
    ]);
    expect(result.protocolVersion).toBe("2");
  });

  it("rebuilds once after CAPABILITIES_CHANGED and fails on a second change", async () => {
    const remote = new FakeTreeRemote();
    remote.changeCapabilitiesOnCreate = 2;
    store = new MemoryControlStore();
    const service = new TreePushService(remote, store, ".agentwiki/tree/p2");
    const input = await prepared([upsertPage("p1", null, "pages/A.md")]);
    await expect(service.publishPrepared(input)).rejects.toThrow(
      /CAPABILITIES_CHANGED/,
    );
    expect(remote.createCount).toBe(2);
  });

  it("rebuilds once after a single CAPABILITIES_CHANGED and publishes", async () => {
    const remote = new FakeTreeRemote();
    remote.changeCapabilitiesOnCreate = 1;
    store = new MemoryControlStore();
    const service = new TreePushService(remote, store, ".agentwiki/tree/p2b");
    const result = await service.publishPrepared(
      await prepared([upsertPage("p1", null, "pages/A.md")]),
    );
    expect(remote.createCount).toBe(2);
    expect(result.status).toBe("published");
    expect(remote.receivedOperations()).toEqual(["upsert_page"]);
  });

  it("refuses to overwrite an unfinished push journal", async () => {
    const remote = new FakeTreeRemote();
    remote.changeCapabilitiesOnCreate = 2;
    store = new MemoryControlStore();
    const service = new TreePushService(remote, store, ".agentwiki/tree/guard");
    const input = await prepared([upsertPage("p1", null, "pages/A.md")]);
    await expect(service.publishPrepared(input)).rejects.toThrow(
      /CAPABILITIES_CHANGED/,
    );
    await expect(service.publishPrepared(input)).rejects.toThrow(/未终结/);
  });

  it("rejects stale caller capabilities that do not match the remote", async () => {
    const remote = new FakeTreeRemote();
    store = new MemoryControlStore();
    const service = new TreePushService(remote, store, ".agentwiki/tree/stale");
    await expect(
      service.publishPrepared(
        await prepared([upsertPage("p1", null, "pages/A.md")], {
          ...v2Capabilities,
          maxBatchItems: 1,
        }),
      ),
    ).rejects.toThrow(/能力集与服务器不一致/);
  });

  it("keeps page bodies in sidecars instead of the JSON journal", async () => {
    const remote = new FakeTreeRemote();
    store = new MemoryControlStore();
    const service = new TreePushService(remote, store, ".agentwiki/tree/p3");
    await service.publishPrepared(
      await prepared([upsertPage("p1", null, "pages/A.md")]),
    );
    expect(await store.read(".agentwiki/tree/p3/journal.json")).not.toContain(
      "hello",
    );
  });

  it("marks a published push verified and clears staged payloads", async () => {
    const remote = new FakeTreeRemote();
    store = new MemoryControlStore();
    const service = new TreePushService(remote, store, ".agentwiki/tree/mv");
    await service.publishPrepared(
      await prepared([upsertPage("p1", null, "pages/A.md")]),
    );
    expect((await service.inspect())?.localCommitPhase).toBe("not_started");
    expect(
      (await store.list(".agentwiki/tree/mv/payload")).files.length,
    ).toBeGreaterThan(0);
    await service.markVerified();
    expect((await service.inspect())?.localCommitPhase).toBe("verified");
    expect((await store.list(".agentwiki/tree/mv/payload")).files.length).toBe(
      0,
    );
  });

  it("refuses to publish when remote head is ahead", async () => {
    const remote = new FakeTreeRemote();
    remote.revision = "r2";
    store = new MemoryControlStore();
    const service = new TreePushService(remote, store, ".agentwiki/tree/stale");
    await expect(
      service.publishPrepared(
        await prepared([upsertPage("p1", null, "pages/A.md")]),
      ),
    ).rejects.toThrow(/BASE_STALE/);
  });

  it("resumes an interrupted upload from persisted sidecars", async () => {
    const remote = new FakeTreeRemote();
    remote.loseFirstUploadOnce = true;
    store = new MemoryControlStore();
    const service = new TreePushService(
      remote,
      store,
      ".agentwiki/tree/resume",
    );
    await expect(
      service.publishPrepared(
        await prepared([
          upsertPage("p1", null, "pages/A.md"),
          upsertPage("p2", null, "pages/B.md"),
        ]),
      ),
    ).rejects.toThrow(/interrupted/);
    const result = await service.resume();
    expect(result?.status).toBe("published");
    expect(remote.receivedOperations()).toEqual(["upsert_page", "upsert_page"]);
  });

  it("supersedes a failed push and refuses to resume", async () => {
    const remote = new FakeTreeRemote();
    remote.changeCapabilitiesOnCreate = 2;
    store = new MemoryControlStore();
    const service = new TreePushService(remote, store, ".agentwiki/tree/sup");
    await expect(
      service.publishPrepared(
        await prepared([upsertPage("p1", null, "pages/A.md")]),
      ),
    ).rejects.toThrow(/CAPABILITIES_CHANGED/);
    await service.supersede();
    await expect(service.resume()).rejects.toThrow(/无法恢复/);
  });
});

describe("PushService future-version rejection", () => {
  it("rejects a future journal schema at the v1 push path", async () => {
    store = new MemoryControlStore();
    await store.write(
      ".agentwiki/push/future/journal.json",
      JSON.stringify({
        envelopeSchemaVersion: 1,
        writeGeneration: 1,
        payloadHash: "x".repeat(64),
        payload: { schemaVersion: 3, spaceId: "space" },
      }),
    );
    const service = new PushService(
      new FakePushRemote(v1Capabilities, "r1"),
      store,
      ".agentwiki/push/future",
    );
    await expect(service.resume()).rejects.toThrow(/不支持的推送日志版本/);
  });
});

const V3_CAPABILITIES: TreeSyncCapabilitiesV3 = {
  ...v2Capabilities,
  maxClientSpaceFolders: v2Capabilities.maxClientSpaceFolders!,
  maxSnapshotObjects: v2Capabilities.maxSnapshotObjects!,
  maxDeltaItems: v2Capabilities.maxDeltaItems!,
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxRevisionAttachments: 1000,
  maxTransferBlobBytes: 100 * 1024 * 1024,
  blobChunkBytes: 4,
  maxBlobChunks: 10,
  maxConcurrentBlobs: 1,
  maxImageDimension: 10000,
  maxDecodedPixels: 40000000,
  allowedMimeTypes: ["image/png"],
  blobStagingTtlSeconds: 900,
  downloadAuthorizationTtlSeconds: 300,
};

class StrictV3PushRemote implements TreeRemotePortV3 {
  readonly protocolVersion = "3" as const;
  readonly capabilitiesHash = treeCapabilitiesHashV3(V3_CAPABILITIES);
  readonly uploadedChunkIndexes: number[] = [];
  readonly batches: TreePushBatchV3[] = [];
  createInputs: CreateTreePushSessionRequestV3[] = [];
  failAfterChunk: number | null = null;
  failAfterReadyOnce = false;
  loseFinalizeResponseOnce = false;
  finalizeCalls = 0;
  abortCalls = 0;
  private status: TreePushSessionStatusV3 | null = null;

  async capabilities(): Promise<TreeSyncCapabilitiesV3> {
    return structuredClone(V3_CAPABILITIES);
  }
  async refreshCapabilities(): Promise<TreeSyncCapabilitiesV3> {
    return this.capabilities();
  }
  async spaces(): Promise<TreeSpaceSummaryV3[]> {
    return [];
  }
  async head(): Promise<TreeHeadV3> {
    return {
      protocolVersion: "3",
      spaceId: "space",
      revision: this.status?.result?.revision ?? "r1",
      sequence: this.status?.result?.sequence ?? 1,
      revisionContentHash:
        this.status?.result?.revisionContentHash ?? "a".repeat(64),
      folderCount: "0",
      pageCount: this.status?.result?.pageCount ?? "0",
      attachmentCount: this.status?.result?.attachmentCount ?? "0",
      revisionManifestByteLength:
        this.status?.result?.revisionManifestByteLength ?? "0",
      revisionBodyBytes: this.status?.result?.revisionBodyBytes ?? "0",
      revisionAttachmentBytes:
        this.status?.result?.revisionAttachmentBytes ?? "0",
      publishedAt: this.status?.result?.publishedAt ?? null,
    };
  }
  async *snapshotPages(): AsyncIterable<TreeSnapshotSegmentV3> {
    yield* [];
  }
  async delta() {
    return { toRevision: "r1", items: [] };
  }
  async bootstrapPreview(): Promise<TreeBootstrapPreviewV3> {
    return {
      protocolVersion: "3",
      mode: "bootstrap_required",
      baseRevision: "r1",
      candidateHash: "a".repeat(64),
      attachmentCount: "0",
      transferBytes: "0",
      blockers: [],
    };
  }
  async bootstrapConfirmed(): Promise<TreeFinalizeResultV3> {
    throw new Error("unused");
  }
  async createPushSession(
    input: CreateTreePushSessionRequestV3,
  ): Promise<TreePushSessionV3> {
    this.createInputs.push(structuredClone(input));
    this.status = {
      sessionId: "session-v3",
      status: "uploading",
      expiresAt: "2099-01-01T00:00:00.000Z",
      missingContentHashes: input.blobRequirements.map(
        (item) => item.contentHash,
      ),
      completedContentHashes: [],
      receivedBatchIndexes: [],
      result: null,
    };
    return this.status;
  }
  async uploadBlobChunk(
    _sessionId: string,
    contentHash: string,
    chunkIndex: number,
    bytes: Uint8Array,
  ): Promise<BlobChunkReceiptV3> {
    this.uploadedChunkIndexes.push(chunkIndex);
    if (this.failAfterChunk === chunkIndex) {
      const error = new Error("chunk interrupted") as Error & {
        retryable: false;
      };
      error.retryable = false;
      throw error;
    }
    return {
      contentHash,
      chunkIndex,
      chunkHash: await blobChunkHashV3(bytes),
      receipt: `chunk-${chunkIndex}`,
    };
  }
  async completeBlob(
    _sessionId: string,
    requirement: BlobRequirementV3,
  ): Promise<CompletedBlobV3> {
    if (this.status)
      this.status.completedContentHashes = [requirement.contentHash];
    return { ...requirement, verifiedAt: "2026-09-06T00:00:00.000Z" };
  }
  async uploadBatch(
    _sessionId: string,
    batch: TreePushBatchV3,
  ): Promise<{ receipt: string }> {
    expect(batch.batchHash).toBe(
      await treeBatchHashV3({
        protocolVersion: "3",
        batchIndex: batch.batchIndex,
        changes: batch.changes,
      }),
    );
    this.batches.push(structuredClone(batch));
    if (this.status) {
      this.status.receivedBatchIndexes.push(batch.batchIndex);
      this.status.status = "ready_to_finalize";
    }
    if (this.failAfterReadyOnce) {
      this.failAfterReadyOnce = false;
      throw new Error("batch response lost");
    }
    return { receipt: `batch-${batch.batchIndex}` };
  }
  async finalize(): Promise<TreeFinalizeResultV3> {
    this.finalizeCalls += 1;
    const result: TreeFinalizeResultV3 = {
      protocolVersion: "3",
      status: "published",
      revision: "r2",
      sequence: 2,
      publishedAt: "2026-09-06T00:00:00.000Z",
      revisionContentHash: "b".repeat(64),
      folderCount: "0",
      pageCount: "1",
      attachmentCount: "1",
      revisionManifestByteLength: "1",
      revisionBodyBytes: "5",
      revisionAttachmentBytes: "10",
      changeSetId: "change-set-v3",
    };
    if (this.status)
      this.status = { ...this.status, status: "published", result };
    if (this.loseFinalizeResponseOnce) {
      this.loseFinalizeResponseOnce = false;
      throw new Error("finalize response lost");
    }
    return result;
  }
  async getSession(): Promise<TreePushSessionStatusV3> {
    if (!this.status) throw new Error("missing session");
    return structuredClone(this.status);
  }
  async abort(): Promise<void> {
    this.abortCalls += 1;
    if (this.status) this.status.status = "aborted";
  }
  async downloadBlob(): Promise<Uint8Array> {
    throw new Error("unused");
  }
}

const manifestChange = (
  change: PreparedTreePushChangeV3,
): TreePushManifestChangeV3 => {
  switch (change.operation) {
    case "upsert_attachment":
      return { operation: change.operation, attachment: change.attachment };
    case "upsert_page": {
      const { payloadPath: _path, bodyBytes: _bytes, ...page } = change.page;
      return { operation: change.operation, page };
    }
    case "upsert_folder":
      return { operation: change.operation, folder: change.folder };
    case "archive_folder":
      return { ...change };
    case "archive_page":
      return { ...change };
    case "detach_attachment":
      return { ...change };
  }
};

async function v3Prepared(blob: Uint8Array): Promise<{
  preview: TreePushPreviewV3;
  currentHash: { value: string };
}> {
  const hash = await blobContentHashV3(blob);
  const attachmentId = "11111111-1111-4111-8111-111111111111";
  const pageId = "22222222-2222-4222-8222-222222222222";
  const changes: PreparedTreePushChangeV3[] = [
    {
      operation: "upsert_attachment",
      attachment: {
        attachmentId,
        path: "assets/image.png",
        mimeType: "image/png",
        sizeBytes: String(blob.byteLength),
        width: 2,
        height: 3,
        contentHash: hash,
        updatedAt: "2026-09-06T00:00:00.000Z",
      },
      vaultPath: "Wiki/assets/image.png",
    },
    {
      operation: "upsert_page",
      page: {
        pageId,
        folderId: null,
        path: "pages/note.md",
        title: "note",
        contentHash: HELLO_HASH,
        updatedAt: "2026-09-06T00:00:00.000Z",
        referencedAttachmentIds: [attachmentId],
        payloadPath: "preview/note.md",
        bodyBytes: 5,
      },
    },
  ];
  const capabilitiesHashValue = await treeCapabilitiesHashV3(V3_CAPABILITIES);
  const manifest: TreePushConfirmationManifestV3 = {
    protocolVersion: "3",
    spaceId: "space",
    baseRevision: "r1",
    capabilitiesHash: capabilitiesHashValue,
    changes: changes.map(manifestChange),
  };
  const currentHash = { value: await treeConfirmationHashV3(manifest) };
  await store.write("preview/note.md", "hello");
  return {
    currentHash,
    preview: {
      protocolVersion: "3",
      spaceId: "space",
      baseRevision: "r1",
      changes,
      capabilities: V3_CAPABILITIES,
      capabilitiesHash: capabilitiesHashValue,
      confirmationHash: currentHash.value,
    },
  };
}

describe("TreePushServiceV3", () => {
  it("resumes at the first unreceipted blob chunk", async () => {
    const remote = new StrictV3PushRemote();
    store = new MemoryControlStore();
    const blob = Uint8Array.from({ length: 10 }, (_, index) => index);
    const { preview, currentHash } = await v3Prepared(blob);
    const service = new TreePushServiceV3(
      remote,
      store,
      ".agentwiki/tree/v3-resume",
      {
        readBlob: async () => blob.slice(),
        revalidateConfirmation: async () => currentHash.value,
      },
    );
    remote.failAfterChunk = 1;
    await expect(service.publishPrepared(preview)).rejects.toThrow(
      /chunk interrupted/,
    );
    remote.failAfterChunk = null;
    await service.resumePending();
    expect(remote.uploadedChunkIndexes).toEqual([0, 1, 1, 2]);
    expect(remote.finalizeCalls).toBe(1);
  });

  it("clears a journal cancelled before create and aborts during upload", async () => {
    store = new MemoryControlStore();
    const blob = Uint8Array.from({ length: 10 }, (_, index) => index);
    const first = await v3Prepared(blob);
    const remote = new StrictV3PushRemote();
    const before = new AbortController();
    before.abort();
    const service = new TreePushServiceV3(remote, store, ".agentwiki/tree/c1", {
      readBlob: async () => blob,
      revalidateConfirmation: async () => first.currentHash.value,
    });
    await expect(
      service.publishPrepared(first.preview, { signal: before.signal }),
    ).rejects.toThrow(/取消/);
    expect(await service.inspect()).toBeNull();
    expect(remote.createInputs).toHaveLength(0);

    const second = await v3Prepared(blob);
    const during = new AbortController();
    const service2 = new TreePushServiceV3(
      remote,
      store,
      ".agentwiki/tree/c2",
      {
        readBlob: async () => {
          during.abort();
          return blob;
        },
        revalidateConfirmation: async () => second.currentHash.value,
      },
    );
    await expect(
      service2.publishPrepared(second.preview, { signal: during.signal }),
    ).rejects.toThrow();
    expect(remote.abortCalls).toBe(1);
  });

  it("queries a published terminal result after finalize response loss", async () => {
    store = new MemoryControlStore();
    const blob = Uint8Array.from({ length: 10 }, (_, index) => index);
    const { preview, currentHash } = await v3Prepared(blob);
    const remote = new StrictV3PushRemote();
    remote.loseFinalizeResponseOnce = true;
    const service = new TreePushServiceV3(
      remote,
      store,
      ".agentwiki/tree/lost",
      {
        readBlob: async () => blob,
        revalidateConfirmation: async () => currentHash.value,
      },
    );
    await expect(service.publishPrepared(preview)).rejects.toThrow(/lost/);
    await expect(service.resumePending()).resolves.toMatchObject({
      revision: "r2",
    });
    expect(remote.finalizeCalls).toBe(1);
  });

  it("ignores cancellation once finalizing is durable", async () => {
    store = new MemoryControlStore();
    const blob = Uint8Array.from({ length: 10 }, (_, index) => index);
    const { preview, currentHash } = await v3Prepared(blob);
    const remote = new StrictV3PushRemote();
    const controller = new AbortController();
    const service = new TreePushServiceV3(
      remote,
      store,
      ".agentwiki/tree/finalizing",
      {
        readBlob: async () => blob,
        revalidateConfirmation: async () => currentHash.value,
      },
    );
    await expect(
      service.publishPrepared(preview, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === "finalize") controller.abort();
        },
      }),
    ).resolves.toMatchObject({ revision: "r2" });
    expect(remote.abortCalls).toBe(0);
    expect(remote.finalizeCalls).toBe(1);
  });

  it("rejects local confirmation drift before finalize and aborts", async () => {
    store = new MemoryControlStore();
    const blob = Uint8Array.from({ length: 10 }, (_, index) => index);
    const { preview, currentHash } = await v3Prepared(blob);
    const remote = new StrictV3PushRemote();
    const service = new TreePushServiceV3(
      remote,
      store,
      ".agentwiki/tree/drift",
      {
        readBlob: async () => blob,
        revalidateConfirmation: async () => currentHash.value,
      },
    );
    remote.uploadBatch = async (_sessionId, batch) => {
      remote.batches.push(structuredClone(batch));
      currentHash.value = "f".repeat(64);
      return { receipt: "batch" };
    };
    await expect(service.publishPrepared(preview)).rejects.toThrow(
      /CONFIRMATION_MISMATCH/,
    );
    expect(remote.abortCalls).toBe(1);
    expect(remote.finalizeCalls).toBe(0);
  });

  it("revalidates before finalizing a ready session during resume", async () => {
    store = new MemoryControlStore();
    const blob = Uint8Array.from({ length: 10 }, (_, index) => index);
    const { preview, currentHash } = await v3Prepared(blob);
    const remote = new StrictV3PushRemote();
    remote.failAfterReadyOnce = true;
    const service = new TreePushServiceV3(
      remote,
      store,
      ".agentwiki/tree/ready-resume-drift",
      {
        readBlob: async () => blob,
        revalidateConfirmation: async () => currentHash.value,
      },
    );
    await expect(service.publishPrepared(preview)).rejects.toThrow(
      /batch response lost/,
    );
    currentHash.value = "f".repeat(64);

    await expect(service.resumePending()).rejects.toThrow(
      /CONFIRMATION_MISMATCH/,
    );
    expect(remote.abortCalls).toBe(1);
    expect(remote.finalizeCalls).toBe(0);
  });

  it("persists only sidecar paths and exact de-duplicated blob requirements", async () => {
    store = new MemoryControlStore();
    const blob = Uint8Array.from({ length: 10 }, (_, index) => index);
    const { preview, currentHash } = await v3Prepared(blob);
    const original = preview.changes[0]!;
    if (original.operation !== "upsert_attachment") throw new Error("fixture");
    const duplicate = structuredClone(original);
    duplicate.attachment.attachmentId = "33333333-3333-4333-8333-333333333333";
    duplicate.attachment.path = "assets/copy.png";
    duplicate.vaultPath = "Wiki/assets/copy.png";
    preview.changes.splice(1, 0, duplicate);
    const manifest = {
      protocolVersion: "3" as const,
      spaceId: preview.spaceId,
      baseRevision: preview.baseRevision,
      capabilitiesHash: preview.capabilitiesHash,
      changes: preview.changes.map(manifestChange),
    };
    preview.confirmationHash = await treeConfirmationHashV3(manifest);
    currentHash.value = preview.confirmationHash;
    const remote = new StrictV3PushRemote();
    const service = new TreePushServiceV3(
      remote,
      store,
      ".agentwiki/tree/req",
      {
        readBlob: async () => blob,
        revalidateConfirmation: async () => currentHash.value,
      },
    );
    await service.publishPrepared(preview);
    expect(remote.createInputs[0]).toMatchObject({
      attachmentCount: 2,
      transferBlobBytes: 10,
      blobRequirements: [{ contentHash: await blobContentHashV3(blob) }],
    });
    expect(canonicalBytes(remote.createInputs[0]!).byteLength).toBeGreaterThan(
      0,
    );
    expect(await store.read(".agentwiki/tree/req/journal.json")).not.toContain(
      JSON.stringify([...blob]),
    );
  });

  it("fails closed when one content hash declares conflicting metadata", async () => {
    store = new MemoryControlStore();
    const blob = Uint8Array.from({ length: 10 }, (_, index) => index);
    const { preview, currentHash } = await v3Prepared(blob);
    const original = preview.changes[0]!;
    if (original.operation !== "upsert_attachment") throw new Error("fixture");
    const duplicate = structuredClone(original);
    duplicate.attachment.attachmentId = "33333333-3333-4333-8333-333333333333";
    duplicate.attachment.path = "assets/copy.png";
    duplicate.attachment.width = 3;
    preview.changes.splice(1, 0, duplicate);
    const remote = new StrictV3PushRemote();
    const service = new TreePushServiceV3(
      remote,
      store,
      ".agentwiki/tree/conflicting-metadata",
      {
        readBlob: async () => blob,
        revalidateConfirmation: async () => currentHash.value,
      },
    );
    await expect(service.publishPrepared(preview)).rejects.toThrow(
      /BLOB_HASH_METADATA_MISMATCH/,
    );
    expect(remote.createInputs).toEqual([]);
  });

  it("rejects an unknown future strict-v3 journal", async () => {
    store = new MemoryControlStore();
    await store.write(
      ".agentwiki/tree/future-v3/journal.json",
      JSON.stringify({
        envelopeSchemaVersion: 1,
        writeGeneration: 1,
        payloadHash: "x".repeat(64),
        payload: { schemaVersion: 4, protocolVersion: "3" },
      }),
    );
    const remote = new StrictV3PushRemote();
    const service = new TreePushServiceV3(
      remote,
      store,
      ".agentwiki/tree/future-v3",
      {
        readBlob: async () => null,
        revalidateConfirmation: async () => "",
      },
    );
    await expect(service.resumePending()).rejects.toThrow(
      /不支持的推送日志版本/,
    );
  });
});
