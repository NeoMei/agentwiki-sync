import type {
  BlobChunkReceiptV3,
  BlobRequirementV3,
  CompletedBlobV3,
  CreateTreePushSessionRequestV3,
  SyncAttachmentV3,
  SyncFolderV3,
  SyncPageV3,
  SyncV3ErrorCode,
  TreeDeltaItemV3,
  TreePushBatchV3,
  TreeSyncCapabilitiesV3,
} from "@neomei/agentwiki-sync-protocol";
import type {
  TreeDeltaItem,
  TreeFolder,
  TreePage,
  TreePushChange,
} from "../core/tree-model";

export interface TreeSyncLimits {
  maxPageBytes: number;
  maxBatchBytes: number;
  maxBatchItems: number;
  maxChangeCount: number;
  maxConfirmationBytes: number;
  maxClientSpacePages: number;
  maxClientManifestBytes: number;
  maxClientTotalBodyBytes: number;
  maxResponseBytes: number;
  maxPageItems: number;
  pushSessionTtlSeconds: number;
  maxClientSpaceFolders?: number;
  maxSnapshotObjects?: number;
  maxDeltaItems?: number;
}

export interface TreeSpaceSummary {
  spaceId: string;
  displayName: string;
  role: "viewer" | "editor" | "admin" | "owner";
  canRead: true;
  canPublish: boolean;
  /** Present only when discovered through the strict public v3 Space schema. */
  syncMode?: "native_v3" | "bootstrap_required" | "legacy_v2";
  currentRevision: string;
  folderCount: string;
  pageCount: string;
  revisionManifestByteLength: string;
  revisionBodyBytes: string;
}

export interface TreeHead {
  protocolVersion: "1" | "2";
  spaceId: string;
  revision: string;
  sequence: number;
  revisionContentHash: string;
  folderCount: string;
  pageCount: string;
  revisionManifestByteLength: string;
  revisionBodyBytes: string;
  publishedAt: string | null;
}

export interface TreeSnapshotSegment {
  protocolVersion: "1" | "2";
  spaceId: string;
  revision: string;
  sequence: number;
  revisionContentHash: string;
  folderCount: string;
  pageCount: string;
  revisionManifestByteLength: string;
  revisionBodyBytes: string;
  folders: TreeFolder[];
  pages: TreePage[];
}

export interface TreeDelta {
  toRevision: string;
  items: TreeDeltaItem[];
}

export interface TreeCreatePushSession {
  baseRevision: string;
  idempotencyKey: string;
  capabilitiesHash: string;
  confirmationHash: string;
  confirmationByteLength: number;
  changeCount: number;
  totalBodyBytes: number;
}

export interface TreePushBatch {
  protocolVersion: "1" | "2";
  batchIndex: number;
  changes: TreePushChange[];
  batchHash: string;
}

export interface TreeFinalizeResult {
  protocolVersion: "1" | "2";
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
}

export type TreePushSessionStatusValue =
  "uploading" | "ready_to_finalize" | "published" | "aborted" | "expired";

export interface TreePushSession {
  sessionId: string;
  status: TreePushSessionStatusValue;
  expiresAt: string;
  result: TreeFinalizeResult | null;
}

export interface TreePushSessionStatus {
  sessionId: string;
  status: TreePushSessionStatusValue;
  expiresAt: string;
  receivedBatchIndexes: number[];
  result: TreeFinalizeResult | null;
}

export interface TreeRemotePort {
  readonly protocolVersion: "1" | "2";
  readonly capabilitiesHash: Promise<string>;
  capabilities(): Promise<TreeSyncLimits>;
  refreshCapabilities(): Promise<TreeSyncLimits>;
  spaces(): Promise<TreeSpaceSummary[]>;
  head(): Promise<TreeHead>;
  snapshotPages(revision?: string): AsyncIterable<TreeSnapshotSegment>;
  delta(fromRevision: string): Promise<TreeDelta>;
  createPushSession(input: TreeCreatePushSession): Promise<TreePushSession>;
  uploadBatch(
    sessionId: string,
    batch: TreePushBatch,
  ): Promise<{ receipt: string }>;
  finalize(
    sessionId: string,
    confirmationHash: string,
  ): Promise<TreeFinalizeResult>;
  getSession(sessionId: string): Promise<TreePushSessionStatus>;
  abort(sessionId: string): Promise<void>;
}

export interface TreeHeadV3 {
  protocolVersion: "3";
  spaceId: string;
  revision: string;
  sequence: number;
  revisionContentHash: string;
  folderCount: string;
  pageCount: string;
  attachmentCount: string;
  revisionManifestByteLength: string;
  revisionBodyBytes: string;
  revisionAttachmentBytes: string;
  publishedAt: string | null;
}

export interface TreeSnapshotSegmentV3 extends Omit<TreeHeadV3, "publishedAt"> {
  folders: SyncFolderV3[];
  pages: SyncPageV3[];
  attachments: SyncAttachmentV3[];
}

export interface TreeDeltaV3 {
  toRevision: string;
  items: TreeDeltaItemV3[];
}

export interface TreeSpaceSummaryV3 {
  spaceId: string;
  displayName: string;
  role: "viewer" | "editor" | "admin" | "owner";
  canRead: true;
  canPublish: boolean;
  syncMode: "native_v3" | "bootstrap_required" | "legacy_v2";
  currentRevision: string;
  folderCount: string;
  pageCount: string;
  attachmentCount: string;
  revisionManifestByteLength: string;
  revisionBodyBytes: string;
  revisionAttachmentBytes: string;
}

export interface TreeBootstrapPreviewV3 {
  protocolVersion: "3";
  mode: "bootstrap_required";
  baseRevision: string;
  candidateHash: string;
  attachmentCount: string;
  transferBytes: string;
  blockers: Array<{ pageId: string; code: SyncV3ErrorCode }>;
}

export type TreeCreatePushSessionV3 = CreateTreePushSessionRequestV3;

export interface TreePushSessionV3 {
  sessionId: string;
  status:
    | "uploading"
    | "ready_to_finalize"
    | "finalizing"
    | "published"
    | "aborted"
    | "expired";
  expiresAt: string;
  missingContentHashes: string[];
}

export interface TreeFinalizeResultV3 extends Omit<TreeHeadV3, "spaceId"> {
  status: "published" | "noop";
  changeSetId: string | null;
}

export interface TreePushSessionStatusV3 extends TreePushSessionV3 {
  completedContentHashes: string[];
  receivedBatchIndexes: number[];
  result: TreeFinalizeResultV3 | null;
}

/** Strict v3 is independent of the frozen v1/v2 TreeRemotePort. */
export interface TreeRemotePortV3 {
  readonly protocolVersion: "3";
  readonly capabilitiesHash: Promise<string>;
  capabilities(): Promise<TreeSyncCapabilitiesV3>;
  refreshCapabilities(): Promise<TreeSyncCapabilitiesV3>;
  spaces(): Promise<TreeSpaceSummaryV3[]>;
  head(): Promise<TreeHeadV3>;
  snapshotPages(revision?: string): AsyncIterable<TreeSnapshotSegmentV3>;
  delta(fromRevision: string): Promise<TreeDeltaV3>;
  bootstrapPreview(): Promise<TreeBootstrapPreviewV3>;
  bootstrapConfirmed(input: {
    baseRevision: string;
    confirmationHash: string;
    userConfirmed: true;
  }): Promise<TreeFinalizeResultV3>;
  createPushSession(input: TreeCreatePushSessionV3): Promise<TreePushSessionV3>;
  uploadBatch(
    sessionId: string,
    batch: TreePushBatchV3,
  ): Promise<{ receipt: string }>;
  finalize(
    sessionId: string,
    confirmationHash: string,
  ): Promise<TreeFinalizeResultV3>;
  getSession(sessionId: string): Promise<TreePushSessionStatusV3>;
  abort(sessionId: string): Promise<void>;
  uploadBlobChunk(
    sessionId: string,
    contentHash: string,
    chunkIndex: number,
    bytes: Uint8Array,
  ): Promise<BlobChunkReceiptV3>;
  completeBlob(
    sessionId: string,
    requirement: BlobRequirementV3,
    chunkCount: number,
  ): Promise<CompletedBlobV3>;
  downloadBlob(input: {
    revision: string;
    attachmentId: string;
    contentHash: string;
  }): Promise<Uint8Array>;
}

export class TreeRuntimeProtocolUnavailableError extends Error {
  readonly code = "SYNC_PROTOCOL_UPGRADE_REQUIRED" as const;
  constructor(readonly protocolVersion: "3") {
    super("Sync v3 was selected, but its runtime adapter is not available");
  }
}

export function assertTreeRuntimeProtocolVersion(
  version: "1" | "2" | "3",
): asserts version is "1" | "2" {
  if (version === "3") throw new TreeRuntimeProtocolUnavailableError("3");
}
