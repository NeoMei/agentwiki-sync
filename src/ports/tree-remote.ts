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
