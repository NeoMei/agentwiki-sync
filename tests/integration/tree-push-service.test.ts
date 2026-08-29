import { describe, expect, it } from "vitest";

import { AgentWikiHttpError } from "../../src/agentwiki/client";
import { capabilitiesHash } from "../../src/agentwiki/protocol";
import type { SyncCapabilities } from "../../src/agentwiki/protocol";
import { PushService } from "../../src/application/push-service";
import {
  TreePushService,
  type PreparedTreePushChange,
  type TreePushPreview,
} from "../../src/application/tree-push-service";
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
