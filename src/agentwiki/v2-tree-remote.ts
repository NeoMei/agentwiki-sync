import { z } from "zod";
import {
  TREE_SYNC_V2_LIMITS,
  CreateTreePushSessionRequestV2Schema,
  CreateTreePushSessionResponseV2Schema,
  TreeDeltaPageV2Schema,
  TreeFinalizePushRequestV2Schema,
  TreeFinalizePushResponseV2Schema,
  TreePushBatchReceiptV2Schema,
  TreePushBatchV2Schema,
  TreePushSessionStatusResponseV2Schema,
  TreeRevisionHeadResponseV2Schema,
  TreeSnapshotPageV2Schema,
  parseDecimalCount,
  type TreeSyncCapabilitiesV2,
} from "@neomei/agentwiki-sync-protocol";
import type { SyncProtocolSelection } from "../application/protocol-negotiator";
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
import { DecimalByteCountSchema, DecimalCountSchema } from "./protocol";
import { retryRead } from "./retry";

const TreeSpaceSummaryV2Schema = z
  .object({
    spaceId: z.string().min(1),
    displayName: z.string(),
    role: z.enum(["viewer", "editor", "admin", "owner"]),
    canRead: z.literal(true),
    canPublish: z.boolean(),
    currentRevision: z.string().min(1),
    folderCount: DecimalCountSchema,
    pageCount: DecimalCountSchema,
    revisionManifestByteLength: DecimalByteCountSchema,
    revisionBodyBytes: DecimalByteCountSchema,
  })
  .strict();

export const TreeSpaceListResponseV2Schema = z
  .object({
    protocolVersion: z.literal("2"),
    spaces: z.array(TreeSpaceSummaryV2Schema),
  })
  .strict();

type V2Selection = Extract<SyncProtocolSelection, { version: "2" }>;

function toTreeLimits(capabilities: TreeSyncCapabilitiesV2): TreeSyncLimits {
  return {
    maxPageBytes: capabilities.maxPageBytes,
    maxBatchBytes: capabilities.maxBatchBytes,
    maxBatchItems: capabilities.maxBatchItems,
    maxChangeCount: capabilities.maxChangeCount,
    maxConfirmationBytes: capabilities.maxConfirmationBytes,
    maxClientSpacePages: capabilities.maxClientSpacePages,
    maxClientManifestBytes: capabilities.maxClientManifestBytes,
    maxClientTotalBodyBytes: capabilities.maxClientTotalBodyBytes,
    maxResponseBytes: capabilities.maxResponseBytes,
    maxPageItems: capabilities.maxPageItems,
    pushSessionTtlSeconds: capabilities.pushSessionTtlSeconds,
    maxClientSpaceFolders: capabilities.maxClientSpaceFolders,
    maxSnapshotObjects: capabilities.maxSnapshotObjects,
    maxDeltaItems: capabilities.maxDeltaItems,
  };
}

function assertSnapshotLimits(page: {
  folderCount: string;
  pageCount: string;
  revisionManifestByteLength: string;
  revisionBodyBytes: string;
}): void {
  const objectCount =
    parseDecimalCount(page.folderCount) + parseDecimalCount(page.pageCount);
  if (objectCount > BigInt(TREE_SYNC_V2_LIMITS.maxSnapshotObjects))
    throw new Error("快照对象数量超过限制");
  const bytes =
    parseDecimalCount(page.revisionManifestByteLength) +
    parseDecimalCount(page.revisionBodyBytes);
  if (bytes > BigInt(TREE_SYNC_V2_LIMITS.maxDocumentTreeBytes))
    throw new Error("快照字节数超过限制");
}

export class V2TreeRemote implements TreeRemotePort {
  readonly protocolVersion = "2" as const;
  readonly capabilitiesHash: Promise<string>;

  constructor(
    private readonly client: AgentWikiClient,
    private readonly spaceId: string,
    private readonly selection: V2Selection,
  ) {
    this.capabilitiesHash = Promise.resolve(this.selection.capabilitiesHash);
  }

  async capabilities(): Promise<TreeSyncLimits> {
    return toTreeLimits(this.selection.capabilities);
  }

  async spaces(): Promise<TreeSpaceSummary[]> {
    const parsed = TreeSpaceListResponseV2Schema.parse(
      await retryRead(async () => this.client.treeSpaces()),
    );
    return parsed.spaces.map((space) => ({ ...space }));
  }

  async head(): Promise<TreeHead> {
    const page = await retryRead(async () =>
      TreeRevisionHeadResponseV2Schema.parse(
        (
          await this.client.raw(
            "GET",
            `/api/sync/v2/spaces/${encodeURIComponent(this.spaceId)}/head`,
          )
        ).json,
      ),
    );
    return {
      protocolVersion: "2",
      spaceId: page.spaceId,
      revision: page.revision,
      sequence: page.sequence,
      revisionContentHash: page.revisionContentHash,
      folderCount: page.folderCount,
      pageCount: page.pageCount,
      revisionManifestByteLength: page.revisionManifestByteLength,
      revisionBodyBytes: page.revisionBodyBytes,
      publishedAt: page.publishedAt,
    };
  }

  async *snapshotPages(
    revision = "current",
  ): AsyncIterable<TreeSnapshotSegment> {
    let cursor: string | null = null;
    let requestRevision = revision;
    let fixed: string | null = null;
    const seenCursors = new Set<string>();
    do {
      const query = new URLSearchParams({ revision: requestRevision });
      if (cursor) query.set("cursor", cursor);
      const page = await retryRead(async () =>
        TreeSnapshotPageV2Schema.parse(
          (
            await this.client.raw(
              "GET",
              `/api/sync/v2/spaces/${encodeURIComponent(this.spaceId)}/snapshot?${query}`,
            )
          ).json,
        ),
      );
      const signature = JSON.stringify([
        page.protocolVersion,
        page.spaceId,
        page.revision,
        page.sequence,
        page.revisionContentHash,
        page.folderCount,
        page.pageCount,
        page.revisionManifestByteLength,
        page.revisionBodyBytes,
      ]);
      if (fixed !== null && fixed !== signature)
        throw new Error("分页元数据已变更");
      fixed = signature;
      requestRevision = page.revision;
      assertSnapshotLimits(page);
      yield {
        protocolVersion: "2",
        spaceId: page.spaceId,
        revision: page.revision,
        sequence: page.sequence,
        revisionContentHash: page.revisionContentHash,
        folderCount: page.folderCount,
        pageCount: page.pageCount,
        revisionManifestByteLength: page.revisionManifestByteLength,
        revisionBodyBytes: page.revisionBodyBytes,
        folders: page.folders,
        pages: page.pages,
      };
      const next = page.nextCursor;
      if (next !== null) {
        if (seenCursors.has(next)) throw new Error("分页游标重放");
        seenCursors.add(next);
      }
      cursor = next;
    } while (cursor !== null);
  }

  async delta(fromRevision: string): Promise<TreeDelta> {
    let cursor: string | null = null;
    let fixed: string | null = null;
    let toRevision = fromRevision;
    const seenCursors = new Set<string>();
    const items: TreeDelta["items"] = [];
    do {
      const query = new URLSearchParams({ from: fromRevision });
      if (cursor) query.set("cursor", cursor);
      const page = await retryRead(async () =>
        TreeDeltaPageV2Schema.parse(
          (
            await this.client.raw(
              "GET",
              `/api/sync/v2/spaces/${encodeURIComponent(this.spaceId)}/delta?${query}`,
            )
          ).json,
        ),
      );
      const signature = JSON.stringify([
        page.protocolVersion,
        page.spaceId,
        page.fromRevision,
        page.toRevision,
        page.toSequence,
        page.toRevisionContentHash,
        page.toFolderCount,
        page.toPageCount,
        page.toRevisionManifestByteLength,
        page.toRevisionBodyBytes,
      ]);
      if (fixed !== null && fixed !== signature)
        throw new Error("增量分页元数据已变更");
      fixed = signature;
      toRevision = page.toRevision;
      items.push(...page.items);
      if (items.length > TREE_SYNC_V2_LIMITS.maxDeltaItems)
        throw new Error("增量条目数量超过限制");
      const next = page.nextCursor;
      if (next !== null) {
        if (seenCursors.has(next)) throw new Error("分页游标重放");
        seenCursors.add(next);
      }
      cursor = next;
    } while (cursor !== null);
    return { toRevision, items };
  }

  async createPushSession(
    input: TreeCreatePushSession,
  ): Promise<TreePushSession> {
    const body = CreateTreePushSessionRequestV2Schema.parse({
      protocolVersion: "2",
      ...input,
    });
    const value = CreateTreePushSessionResponseV2Schema.parse(
      (
        await this.client.raw(
          "POST",
          `/api/sync/v2/spaces/${encodeURIComponent(this.spaceId)}/push-sessions`,
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
      result: value.result ? toFinalizeResult(value.result) : null,
    };
  }

  async uploadBatch(
    sessionId: string,
    batch: TreePushBatch,
  ): Promise<{ receipt: string }> {
    const body = TreePushBatchV2Schema.parse(batch);
    const value = TreePushBatchReceiptV2Schema.parse(
      (
        await this.client.raw(
          "PUT",
          `/api/sync/v2/spaces/${encodeURIComponent(this.spaceId)}/push-sessions/${encodeURIComponent(sessionId)}/batches/${batch.batchIndex}`,
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
    const body = TreeFinalizePushRequestV2Schema.parse({
      protocolVersion: "2",
      confirmationHash,
      userConfirmed: true,
    });
    const value = TreeFinalizePushResponseV2Schema.parse(
      (
        await this.client.raw(
          "POST",
          `/api/sync/v2/spaces/${encodeURIComponent(this.spaceId)}/push-sessions/${encodeURIComponent(sessionId)}/finalize`,
          body,
        )
      ).json,
    );
    return toFinalizeResult(value);
  }

  async getSession(sessionId: string): Promise<TreePushSessionStatus> {
    const value = TreePushSessionStatusResponseV2Schema.parse(
      (
        await this.client.raw(
          "GET",
          `/api/sync/v2/spaces/${encodeURIComponent(this.spaceId)}/push-sessions/${encodeURIComponent(sessionId)}`,
        )
      ).json,
    );
    return {
      sessionId: value.sessionId,
      status: value.status,
      expiresAt: value.expiresAt,
      receivedBatchIndexes: value.receivedBatchIndexes,
      result: value.result ? toFinalizeResult(value.result) : null,
    };
  }

  async abort(sessionId: string): Promise<void> {
    await this.client.raw(
      "DELETE",
      `/api/sync/v2/spaces/${encodeURIComponent(this.spaceId)}/push-sessions/${encodeURIComponent(sessionId)}`,
    );
  }
}

function toFinalizeResult(value: {
  protocolVersion: "2";
  status: "published" | "noop";
  revision: string;
  sequence: number;
  publishedAt: string | null;
  revisionContentHash: string;
  folderCount: string;
  pageCount: string;
  revisionManifestByteLength: string;
  revisionBodyBytes: string;
  changeSetId: string | null;
}): TreeFinalizeResult {
  return {
    protocolVersion: "2",
    status: value.status,
    revision: value.revision,
    sequence: value.sequence,
    publishedAt: value.publishedAt,
    revisionContentHash: value.revisionContentHash,
    folderCount: value.folderCount,
    pageCount: value.pageCount,
    revisionManifestByteLength: value.revisionManifestByteLength,
    revisionBodyBytes: value.revisionBodyBytes,
    changeSetId: value.changeSetId,
  };
}
