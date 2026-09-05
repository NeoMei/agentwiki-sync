import {
  canonicalBytes,
  capabilitiesHash,
  contentHash,
  revisionContentHash,
  type SyncPage,
} from "../../src/agentwiki/protocol";
import {
  TREE_SYNC_V3_HARD_LIMITS,
  treeCapabilitiesHashV3,
  treeRevisionContentHashV2,
  treeRevisionContentHashV3,
  type BlobChunkReceiptV3,
  type BlobRequirementV3,
  type CompletedBlobV3,
  type SyncAttachmentV3,
  type SyncFolderV2,
  type SyncPageV2,
  type SyncPageV3,
  type TreePushBatchV2,
  type TreeSyncCapabilitiesV3,
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
  TreeRemotePortV3,
  TreeSnapshotSegmentV3,
  TreeHeadV3,
  TreeSpaceSummaryV3,
  TreeBootstrapPreviewV3,
  TreeFinalizeResultV3,
  TreePushSessionV3,
  TreePushSessionStatusV3,
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

export const V3_CAPABILITIES: TreeSyncCapabilitiesV3 = {
  ...CAPABILITIES,
  maxChangeCount: 100,
  maxClientTotalBodyBytes: 2 * 1024 * 1024,
  maxClientSpaceFolders: CAPABILITIES.maxClientSpaceFolders!,
  maxSnapshotObjects: CAPABILITIES.maxSnapshotObjects!,
  maxDeltaItems: CAPABILITIES.maxDeltaItems!,
  ...TREE_SYNC_V3_HARD_LIMITS,
  allowedMimeTypes: ["image/gif", "image/jpeg", "image/png", "image/webp"],
  blobStagingTtlSeconds: 900,
  downloadAuthorizationTtlSeconds: 300,
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
  private protocolVersionValue: "1" | "2" = "2";
  readonly capabilitiesHash: Promise<string>;
  lastCreateInput: TreeCreatePushSession | null = null;
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

  get protocolVersion(): "1" | "2" {
    return this.protocolVersionValue;
  }

  setProtocol(protocol: "1" | "2"): void {
    this.protocolVersionValue = protocol;
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
        revisionBodyBytes: this.bodyBytes(),
      },
    ];
  }

  async head(): Promise<TreeHead> {
    const snapshot = await this.buildSnapshot();
    return {
      protocolVersion: this.protocolVersionValue,
      spaceId: "space",
      revision: String(this.revision),
      sequence: this.revision,
      revisionContentHash: await this.treeHash(snapshot),
      folderCount: String(this.folders.size),
      pageCount: String(this.pages.size),
      revisionManifestByteLength: "0",
      revisionBodyBytes: this.bodyBytes(),
      publishedAt: "2026-08-14T00:00:00.000Z",
    };
  }

  private async buildSnapshot(): Promise<TreeSnapshot> {
    return {
      protocolVersion: this.protocolVersionValue,
      spaceId: "space",
      revision: String(this.revision),
      revisionContentHash: "",
      folders: [...this.folders.values()].map((f) => ({ ...f })),
      pages: [...this.pages.values()].map((p) => ({ ...p })),
    };
  }

  private async treeHash(snapshot: TreeSnapshot): Promise<string> {
    if (this.protocolVersionValue === "1")
      return revisionContentHash({
        protocolVersion: "1",
        spaceId: "space",
        pages: snapshot.pages.map((page) => ({
          pageId: page.pageId,
          path: page.path,
          title: page.title,
          contentHash: page.contentHash,
        })),
      });
    return treeRevisionContentHashV2({
      protocolVersion: "2",
      spaceId: "space",
      folders: snapshot.folders,
      pages: snapshot.pages,
    });
  }

  private bodyBytes(): string {
    let total = 0;
    for (const page of this.pages.values())
      total += new TextEncoder().encode(page.body).byteLength;
    return String(total);
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
      protocolVersion: this.protocolVersionValue,
      spaceId: "space",
      revision: String(this.revision),
      sequence: this.revision,
      revisionContentHash: await this.treeHash(all),
      folderCount: String(folders.length),
      pageCount: String(pages.length),
      revisionManifestByteLength: "0",
      revisionBodyBytes: this.bodyBytes(),
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
    this.lastCreateInput = input;
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
      protocolVersion: this.protocolVersionValue,
      status: "published",
      revision: String(this.revision),
      sequence: this.revision,
      publishedAt: "2026-08-14T00:00:00.000Z",
      revisionContentHash: await this.treeHash(snapshot),
      folderCount: String(this.folders.size),
      pageCount: String(this.pages.size),
      revisionManifestByteLength: "0",
      revisionBodyBytes: this.bodyBytes(),
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

export class FakeTreeRemoteV3 implements TreeRemotePortV3 {
  readonly protocolVersion = "3" as const;
  readonly capabilitiesHash = treeCapabilitiesHashV3(V3_CAPABILITIES);
  readonly downloads: Array<{
    revision: string;
    attachmentId: string;
    contentHash: string;
  }> = [];
  failAfterSnapshot = false;
  syncMode: TreeSpaceSummaryV3["syncMode"] = "native_v3";
  private revision = "rev-3";
  private folders: SyncFolderV2[] = [];
  private pages: SyncPageV3[] = [];
  private attachments: SyncAttachmentV3[] = [];
  private readonly blobs = new Map<string, Uint8Array>();

  async seedTree(input: {
    revision?: string;
    folders?: SyncFolderV2[];
    pages?: SyncPageV3[];
    attachments?: SyncAttachmentV3[];
    blobs?: Record<string, Uint8Array>;
  }): Promise<void> {
    this.revision = input.revision ?? "rev-3";
    this.folders = (input.folders ?? []).map((item) => ({ ...item }));
    this.pages = (input.pages ?? []).map((item) => ({
      ...item,
      referencedAttachmentIds: [...item.referencedAttachmentIds],
    }));
    this.attachments = (input.attachments ?? []).map((item) => ({ ...item }));
    this.blobs.clear();
    for (const [id, bytes] of Object.entries(input.blobs ?? {}))
      this.blobs.set(id, bytes.slice());
  }

  async capabilities(): Promise<TreeSyncCapabilitiesV3> {
    return {
      ...V3_CAPABILITIES,
      allowedMimeTypes: [...V3_CAPABILITIES.allowedMimeTypes],
    };
  }

  async refreshCapabilities(): Promise<TreeSyncCapabilitiesV3> {
    return this.capabilities();
  }

  private async metrics() {
    const manifest = {
      protocolVersion: "3" as const,
      spaceId: "space",
      folders: this.folders,
      pages: this.pages,
      attachments: this.attachments,
    };
    return {
      hash: await treeRevisionContentHashV3(manifest),
      manifestBytes: canonicalBytes(manifest).byteLength,
      bodyBytes: this.pages.reduce(
        (total, page) => total + new TextEncoder().encode(page.body).byteLength,
        0,
      ),
      attachmentBytes: this.attachments.reduce(
        (total, attachment) => total + Number(attachment.sizeBytes),
        0,
      ),
    };
  }

  async spaces(): Promise<TreeSpaceSummaryV3[]> {
    const value = await this.metrics();
    return [
      {
        spaceId: "space",
        displayName: "Space",
        role: "owner",
        canRead: true,
        canPublish: true,
        syncMode: this.syncMode,
        currentRevision: this.revision,
        folderCount: String(this.folders.length),
        pageCount: String(this.pages.length),
        attachmentCount: String(this.attachments.length),
        revisionManifestByteLength: String(value.manifestBytes),
        revisionBodyBytes: String(value.bodyBytes),
        revisionAttachmentBytes: String(value.attachmentBytes),
      },
    ];
  }

  async head(): Promise<TreeHeadV3> {
    const value = await this.metrics();
    return {
      protocolVersion: "3",
      spaceId: "space",
      revision: this.revision,
      sequence: 3,
      revisionContentHash: value.hash,
      folderCount: String(this.folders.length),
      pageCount: String(this.pages.length),
      attachmentCount: String(this.attachments.length),
      revisionManifestByteLength: String(value.manifestBytes),
      revisionBodyBytes: String(value.bodyBytes),
      revisionAttachmentBytes: String(value.attachmentBytes),
      publishedAt: "2026-09-05T00:00:00.000Z",
    };
  }

  async *snapshotPages(
    revision = this.revision,
  ): AsyncIterable<TreeSnapshotSegmentV3> {
    if (revision !== this.revision) throw new Error("REVISION_GONE");
    const head = await this.head();
    const { publishedAt: _publishedAt, ...metadata } = head;
    yield {
      ...metadata,
      folders: this.folders.map((item) => ({ ...item })),
      pages: this.pages.map((item) => ({
        ...item,
        referencedAttachmentIds: [...item.referencedAttachmentIds],
      })),
      attachments: this.attachments.map((item) => ({ ...item })),
    };
    if (this.failAfterSnapshot) throw new Error("SNAPSHOT_FINAL_HASH_MISMATCH");
  }

  async delta() {
    return { toRevision: this.revision, items: [] };
  }

  async bootstrapPreview(): Promise<TreeBootstrapPreviewV3> {
    return {
      protocolVersion: "3",
      mode: "bootstrap_required",
      baseRevision: this.revision,
      candidateHash: (await this.metrics()).hash,
      attachmentCount: String(this.attachments.length),
      transferBytes: String((await this.metrics()).attachmentBytes),
      blockers: [],
    };
  }

  async bootstrapConfirmed(input: {
    baseRevision: string;
    confirmationHash: string;
    userConfirmed: true;
  }): Promise<TreeFinalizeResultV3> {
    void input;
    this.syncMode = "native_v3";
    const head = await this.head();
    const { spaceId: _spaceId, ...result } = head;
    return { ...result, status: "published", changeSetId: null };
  }

  async createPushSession(): Promise<TreePushSessionV3> {
    throw new Error("V3_PUSH_NOT_IMPLEMENTED");
  }
  async uploadBatch(): Promise<{ receipt: string }> {
    throw new Error("V3_PUSH_NOT_IMPLEMENTED");
  }
  async finalize(): Promise<TreeFinalizeResultV3> {
    throw new Error("V3_PUSH_NOT_IMPLEMENTED");
  }
  async getSession(): Promise<TreePushSessionStatusV3> {
    throw new Error("V3_PUSH_NOT_IMPLEMENTED");
  }
  async abort(): Promise<void> {}
  async uploadBlobChunk(): Promise<BlobChunkReceiptV3> {
    throw new Error("V3_PUSH_NOT_IMPLEMENTED");
  }
  async completeBlob(
    _sessionId: string,
    requirement: BlobRequirementV3,
  ): Promise<CompletedBlobV3> {
    return { ...requirement, verifiedAt: "2026-09-05T00:00:00.000Z" };
  }

  async downloadBlob(input: {
    revision: string;
    attachmentId: string;
    contentHash: string;
  }): Promise<Uint8Array> {
    this.downloads.push({ ...input });
    if (input.revision !== this.revision) throw new Error("REVISION_GONE");
    const bytes = this.blobs.get(input.attachmentId);
    if (!bytes) throw new Error("ATTACHMENT_BLOB_MISSING");
    return bytes.slice();
  }
}
