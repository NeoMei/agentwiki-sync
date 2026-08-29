import {
  capabilitiesHash,
  contentHash,
  type SyncPage,
} from "../../src/agentwiki/protocol";
import {
  treeRevisionContentHashV2,
  type SyncFolderV2,
  type SyncPageV2,
  type TreePushBatchV2,
} from "@neomei/agentwiki-sync-protocol";
import type {
  TreeDelta,
  TreeFinalizeResult,
  TreeHead,
  TreePushSession,
  TreePushSessionStatus,
  TreeRemotePort,
  TreeSnapshotSegment,
  TreeSpaceSummary,
  TreeSyncLimits,
  TreeCreatePushSession,
} from "../../src/ports/tree-remote";
import type {
  TreeDeltaItem,
  TreeFolder,
  TreePage,
  TreeSnapshot,
} from "../../src/core/tree-model";

const CAPABILITIES: TreeSyncLimits = {
  maxPageBytes: 1048576,
  maxBatchBytes: 4194304,
  maxBatchItems: 100,
  maxChangeCount: 5000,
  maxConfirmationBytes: 4194304,
  maxClientSpacePages: 5000,
  maxClientSpaceFolders: 10000,
  maxSnapshotObjects: 15000,
  maxClientManifestBytes: 4194304,
  maxClientTotalBodyBytes: 104857600,
  maxDeltaItems: 15000,
  maxResponseBytes: 4194304,
  maxPageItems: 200,
  pushSessionTtlSeconds: 900,
};

interface Session {
  sessionId: string;
  baseRevision: string;
  status: TreePushSession["status"];
  expiresAt: string;
  result: TreeFinalizeResult | null;
  batches: TreePushBatchV2[];
}

function toTreePage(page: SyncPage): TreePage {
  return { ...page, folderId: null, updatedAt: "2026-08-14T00:00:00.000Z" };
}

function toSyncPage(page: TreePage): SyncPage {
  return {
    pageId: page.pageId,
    path: page.path,
    title: page.title,
    body: page.body,
    contentHash: page.contentHash,
    updatedAt: page.updatedAt,
  };
}

export class FakeTreeRemote implements TreeRemotePort {
  readonly protocolVersion = "2" as const;
  readonly capabilitiesHash: Promise<string>;
  canPublish = true;
  truncateNextSnapshot = false;
  private revision = 0;
  private readonly folders = new Map<string, TreeFolder>();
  private readonly pages = new Map<string, TreePage>();
  private readonly sessions = new Map<string, Session>();
  private readonly changeLog: Array<{ revision: number; item: TreeDeltaItem }> =
    [];

  constructor() {
    this.capabilitiesHash = capabilitiesHash(CAPABILITIES);
  }

  async capabilities(): Promise<TreeSyncLimits> {
    return { ...CAPABILITIES };
  }

  async refreshCapabilities(): Promise<TreeSyncLimits> {
    return { ...CAPABILITIES };
  }

  async spaces(): Promise<TreeSpaceSummary[]> {
    return [
      {
        spaceId: "space",
        displayName: "Space",
        role: "owner",
        canRead: true,
        canPublish: this.canPublish,
        currentRevision: String(this.revision),
        folderCount: String(this.folders.size),
        pageCount: String(this.pages.size),
        revisionManifestByteLength: "0",
        revisionBodyBytes: "0",
      },
    ];
  }

  async head(): Promise<TreeHead> {
    const snapshot = await this.buildSnapshot();
    return {
      protocolVersion: "2",
      spaceId: "space",
      revision: String(this.revision),
      sequence: this.revision,
      revisionContentHash: await this.treeHash(snapshot),
      folderCount: String(this.folders.size),
      pageCount: String(this.pages.size),
      revisionManifestByteLength: "0",
      revisionBodyBytes: "0",
      publishedAt: "2026-08-14T00:00:00.000Z",
    };
  }

  private async buildSnapshot(): Promise<TreeSnapshot> {
    return {
      protocolVersion: "2",
      spaceId: "space",
      revision: String(this.revision),
      revisionContentHash: "",
      folders: [...this.folders.values()].map((f) => ({ ...f })),
      pages: [...this.pages.values()].map((p) => ({ ...p })),
    };
  }

  private async treeHash(snapshot: TreeSnapshot): Promise<string> {
    return treeRevisionContentHashV2({
      protocolVersion: "2",
      spaceId: "space",
      folders: snapshot.folders,
      pages: snapshot.pages,
    });
  }

  async *snapshotPages(
    revision = "current",
  ): AsyncIterable<TreeSnapshotSegment> {
    void revision;
    const all = await this.buildSnapshot();
    const folders = this.truncateNextSnapshot
      ? all.folders.slice(0, -1)
      : all.folders;
    const pages = this.truncateNextSnapshot
      ? all.pages.slice(0, -1)
      : all.pages;
    this.truncateNextSnapshot = false;
    yield {
      protocolVersion: "2",
      spaceId: "space",
      revision: String(this.revision),
      sequence: this.revision,
      revisionContentHash: await this.treeHash(all),
      folderCount: String(folders.length),
      pageCount: String(pages.length),
      revisionManifestByteLength: "0",
      revisionBodyBytes: "0",
      folders,
      pages,
    };
  }

  async delta(fromRevision: string): Promise<TreeDelta> {
    const from = Number(fromRevision);
    return {
      toRevision: String(this.revision),
      items: this.changeLog
        .filter((entry) => entry.revision > from)
        .map((entry) => entry.item),
    };
  }

  async createPushSession(
    input: TreeCreatePushSession,
  ): Promise<TreePushSession> {
    if (input.baseRevision !== String(this.revision))
      throw new Error("BASE_STALE");
    const sessionId = "session-" + (this.sessions.size + 1);
    const session: Session = {
      sessionId,
      baseRevision: input.baseRevision,
      status: "uploading",
      expiresAt: "2099-01-01T00:00:00.000Z",
      result: null,
      batches: [],
    };
    this.sessions.set(sessionId, session);
    return {
      sessionId: session.sessionId,
      status: session.status,
      expiresAt: session.expiresAt,
      result: null,
    };
  }

  async uploadBatch(
    sessionId: string,
    batch: TreePushBatchV2,
  ): Promise<{ receipt: string }> {
    this.sessions.get(sessionId)!.batches.push(batch);
    return { receipt: "r-" + batch.batchIndex };
  }

  async finalize(
    sessionId: string,
    _confirmationHash: string,
  ): Promise<TreeFinalizeResult> {
    if (!this.canPublish) throw new Error("SPACE_READ_ONLY");
    const session = this.sessions.get(sessionId)!;
    if (session.baseRevision !== String(this.revision))
      throw new Error("BASE_STALE");
    for (const batch of [...session.batches].sort(
      (a, b) => a.batchIndex - b.batchIndex,
    ))
      for (const change of batch.changes) {
        if (change.operation === "archive_folder")
          this.folders.delete(change.folderId);
        else if (change.operation === "upsert_folder")
          this.folders.set(change.folder.folderId, { ...change.folder });
        else if (change.operation === "archive_page")
          this.pages.delete(change.pageId);
        else
          this.pages.set(change.page.pageId, {
            ...change.page,
            contentHash: await contentHash(change.page.body),
          });
      }
    this.revision += 1;
    for (const batch of [...session.batches].sort(
      (a, b) => a.batchIndex - b.batchIndex,
    ))
      for (const change of batch.changes) {
        if (change.operation === "archive_folder")
          this.changeLog.push({
            revision: this.revision,
            item: {
              operation: "archive_folder",
              folderId: change.folderId,
              previousPath: change.previousPath,
            },
          });
        else if (change.operation === "upsert_folder")
          this.changeLog.push({
            revision: this.revision,
            item: {
              operation: "upsert_folder",
              folder: { ...change.folder },
            },
          });
        else if (change.operation === "archive_page")
          this.changeLog.push({
            revision: this.revision,
            item: {
              operation: "archive_page",
              pageId: change.pageId,
              previousPath: change.previousPath,
            },
          });
        else
          this.changeLog.push({
            revision: this.revision,
            item: {
              operation: "upsert_page",
              page: { ...this.pages.get(change.page.pageId)! },
            },
          });
      }
    const snapshot = await this.buildSnapshot();
    const result: TreeFinalizeResult = {
      protocolVersion: "2",
      status: "published",
      revision: String(this.revision),
      sequence: this.revision,
      publishedAt: "2026-08-14T00:00:00.000Z",
      revisionContentHash: await this.treeHash(snapshot),
      folderCount: String(this.folders.size),
      pageCount: String(this.pages.size),
      revisionManifestByteLength: "0",
      revisionBodyBytes: "0",
      changeSetId: "c-" + this.revision,
    };
    session.status = "published";
    session.result = result;
    return result;
  }

  async getSession(sessionId: string): Promise<TreePushSessionStatus> {
    const session = this.sessions.get(sessionId)!;
    return {
      sessionId: session.sessionId,
      status: session.status,
      expiresAt: session.expiresAt,
      receivedBatchIndexes: session.batches.map((b) => b.batchIndex),
      result: session.result,
    };
  }

  async abort(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) session.status = "aborted";
  }

  async seed(pages: SyncPage[]): Promise<void> {
    this.pages.clear();
    this.folders.clear();
    for (const page of pages) this.pages.set(page.pageId, toTreePage(page));
    this.revision = pages.length > 0 ? 1 : 0;
  }

  async replace(pages: SyncPage[]): Promise<void> {
    const previousIds = new Set(this.pages.keys());
    this.pages.clear();
    this.folders.clear();
    for (const page of pages) this.pages.set(page.pageId, toTreePage(page));
    this.revision += 1;
    for (const pageId of previousIds)
      if (!this.pages.has(pageId))
        this.changeLog.push({
          revision: this.revision,
          item: {
            operation: "archive_page",
            pageId,
            previousPath: "pages/unknown.md",
          },
        });
    for (const page of this.pages.values())
      this.changeLog.push({
        revision: this.revision,
        item: { operation: "upsert_page", page: { ...page } },
      });
  }

  async seedTree(input: {
    folders: SyncFolderV2[];
    pages: SyncPageV2[];
  }): Promise<void> {
    this.folders.clear();
    this.pages.clear();
    for (const folder of input.folders)
      this.folders.set(folder.folderId, { ...folder });
    for (const page of input.pages) this.pages.set(page.pageId, { ...page });
    this.revision = input.folders.length > 0 || input.pages.length > 0 ? 1 : 0;
  }

  tree(): { folders: TreeFolder[]; pages: TreePage[] } {
    return {
      folders: [...this.folders.values()].map((f) => ({ ...f })),
      pages: [...this.pages.values()].map((p) => ({ ...p })),
    };
  }

  async snapshot(): Promise<{ items: SyncPage[] }> {
    return {
      items: [...this.pages.values()].map(toSyncPage),
    };
  }

  async advanceEmptyRevision(): Promise<void> {
    this.revision += 1;
  }

  sessionCount(): number {
    return this.sessions.size;
  }
}
