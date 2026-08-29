import type {
  TreeDeltaItem,
  TreePage,
  TreePushChange,
} from "../core/tree-model";
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
} from "../ports/tree-remote";
import type { AgentWikiClient } from "./client";
import {
  CreatePushSessionRequestSchema,
  CreatePushSessionResponseSchema,
  FinalizePushRequestSchema,
  FinalizeResultSchema,
  PushReceiptSchema,
  PushSessionStatusResponseSchema,
  UploadPushBatchRequestSchema,
  batchHash,
  capabilitiesHash,
  type DeltaItem,
  type PushChange,
  type SyncCapabilities,
  type SyncPage,
} from "./protocol";

type TreePageChange = Extract<
  TreePushChange,
  { operation: "upsert_page" | "archive_page" }
>;

const toTreePage = (page: SyncPage): TreePage => ({ ...page, folderId: null });

const toTreeDelta = (item: DeltaItem): TreeDeltaItem =>
  item.operation === "upsert"
    ? { operation: "upsert_page", page: toTreePage(item.page) }
    : {
        operation: "archive_page",
        pageId: item.pageId,
        previousPath: item.previousPath,
      };

function toTreeLimits(capabilities: SyncCapabilities): TreeSyncLimits {
  return { ...capabilities };
}

function toTreeFinalizeResult(value: {
  status: "published" | "noop";
  revision: string;
  sequence: number;
  publishedAt: string | null;
  revisionContentHash: string;
  pageCount: string;
  revisionManifestByteLength: string;
  revisionBodyBytes: string;
  changeSetId: string | null;
}): TreeFinalizeResult {
  return {
    protocolVersion: "1",
    status: value.status,
    revision: value.revision,
    sequence: value.sequence,
    publishedAt: value.publishedAt,
    revisionContentHash: value.revisionContentHash,
    folderCount: "0",
    pageCount: value.pageCount,
    revisionManifestByteLength: value.revisionManifestByteLength,
    revisionBodyBytes: value.revisionBodyBytes,
    changeSetId: value.changeSetId,
  };
}

function assertNoFolderChanges(batch: TreePushBatch): void {
  if (
    batch.changes.some(
      (change) =>
        change.operation === "upsert_folder" ||
        change.operation === "archive_folder",
    )
  )
    throw new Error("v1 适配器不支持目录变更");
}

function toV1PushChange(change: TreePageChange): PushChange {
  if (change.operation === "upsert_page") {
    return {
      operation: "upsert",
      pageId: change.page.pageId,
      path: change.page.path,
      title: change.page.title,
      body: change.page.body,
      contentHash: change.page.contentHash,
    };
  }
  return {
    operation: "archive",
    pageId: change.pageId,
    previousPath: change.previousPath,
  };
}

export class V1TreeRemote implements TreeRemotePort {
  readonly protocolVersion = "1" as const;
  readonly capabilitiesHash: Promise<string>;
  private readonly capabilitiesValue: SyncCapabilities;

  constructor(
    private readonly client: AgentWikiClient,
    private readonly spaceId: string,
    capabilities: SyncCapabilities,
  ) {
    this.capabilitiesValue = capabilities;
    this.capabilitiesHash = capabilitiesHash(capabilities);
  }

  async capabilities(): Promise<TreeSyncLimits> {
    return toTreeLimits(this.capabilitiesValue);
  }

  async refreshCapabilities(): Promise<TreeSyncLimits> {
    return toTreeLimits(this.capabilitiesValue);
  }

  async spaces(): Promise<TreeSpaceSummary[]> {
    const value = await this.client.spaces();
    return value.spaces.map((space) => ({ ...space, folderCount: "0" }));
  }

  async head(): Promise<TreeHead> {
    const value = await this.client.head(this.spaceId);
    return {
      protocolVersion: "1",
      spaceId: value.spaceId,
      revision: value.revision,
      sequence: value.sequence,
      revisionContentHash: value.revisionContentHash,
      folderCount: "0",
      pageCount: value.pageCount,
      revisionManifestByteLength: value.revisionManifestByteLength,
      revisionBodyBytes: value.revisionBodyBytes,
      publishedAt: value.publishedAt,
    };
  }

  async *snapshotPages(
    revision = "current",
  ): AsyncIterable<TreeSnapshotSegment> {
    for await (const segment of this.client.snapshotPages(
      this.spaceId,
      revision,
    )) {
      yield {
        protocolVersion: "1",
        spaceId: segment.metadata.spaceId,
        revision: segment.metadata.revision,
        sequence: segment.metadata.sequence,
        revisionContentHash: segment.metadata.revisionContentHash,
        folderCount: "0",
        pageCount: segment.metadata.pageCount,
        revisionManifestByteLength: segment.metadata.revisionManifestByteLength,
        revisionBodyBytes: segment.metadata.revisionBodyBytes,
        folders: [],
        pages: segment.items.map(toTreePage),
      };
    }
  }

  async delta(fromRevision: string): Promise<TreeDelta> {
    const value = await this.client.delta(this.spaceId, fromRevision);
    return {
      toRevision: value.toRevision,
      items: value.items.map(toTreeDelta),
    };
  }

  async createPushSession(
    input: TreeCreatePushSession,
  ): Promise<TreePushSession> {
    const body = CreatePushSessionRequestSchema.parse(input);
    const value = CreatePushSessionResponseSchema.parse(
      (
        await this.client.raw(
          "POST",
          `/api/sync/v1/spaces/${encodeURIComponent(this.spaceId)}/push-sessions`,
          body,
          true,
          true,
        )
      ).json,
    );
    return {
      sessionId: value.sessionId,
      status: value.status,
      expiresAt: value.expiresAt,
      result: value.result ? toTreeFinalizeResult(value.result) : null,
    };
  }

  async uploadBatch(
    sessionId: string,
    batch: TreePushBatch,
  ): Promise<{ receipt: string }> {
    assertNoFolderChanges(batch);
    const changes: PushChange[] = batch.changes.map((change) => {
      if (
        change.operation === "upsert_page" ||
        change.operation === "archive_page"
      )
        return toV1PushChange(change);
      throw new Error("v1 适配器不支持目录变更");
    });
    const withoutHash = {
      protocolVersion: "1" as const,
      batchIndex: batch.batchIndex,
      changes,
    };
    const body = UploadPushBatchRequestSchema.parse({
      ...withoutHash,
      batchHash: await batchHash(withoutHash),
    });
    const value = PushReceiptSchema.parse(
      (
        await this.client.raw(
          "PUT",
          `/api/sync/v1/spaces/${encodeURIComponent(this.spaceId)}/push-sessions/${encodeURIComponent(sessionId)}/batches/${batch.batchIndex}`,
          body,
          true,
          true,
        )
      ).json,
    );
    return { receipt: value.receipt };
  }

  async finalize(
    sessionId: string,
    confirmationHash: string,
  ): Promise<TreeFinalizeResult> {
    const body = FinalizePushRequestSchema.parse({
      confirmationHash,
      userConfirmed: true,
    });
    const value = FinalizeResultSchema.parse(
      (
        await this.client.raw(
          "POST",
          `/api/sync/v1/spaces/${encodeURIComponent(this.spaceId)}/push-sessions/${encodeURIComponent(sessionId)}/finalize`,
          body,
        )
      ).json,
    );
    return toTreeFinalizeResult(value);
  }

  async getSession(sessionId: string): Promise<TreePushSessionStatus> {
    const value = PushSessionStatusResponseSchema.parse(
      (
        await this.client.raw(
          "GET",
          `/api/sync/v1/spaces/${encodeURIComponent(this.spaceId)}/push-sessions/${encodeURIComponent(sessionId)}`,
        )
      ).json,
    );
    return {
      sessionId: value.sessionId,
      status: value.status,
      expiresAt: value.expiresAt,
      receivedBatchIndexes: value.receivedBatchIndexes,
      result: value.result ? toTreeFinalizeResult(value.result) : null,
    };
  }

  async abort(sessionId: string): Promise<void> {
    await this.client.raw(
      "DELETE",
      `/api/sync/v1/spaces/${encodeURIComponent(this.spaceId)}/push-sessions/${encodeURIComponent(sessionId)}`,
    );
  }
}
