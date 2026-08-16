export interface SyncCapabilities {
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
}

export interface PushManifestUpsert {
  operation: "upsert";
  pageId: string;
  path: string;
  title: string;
  contentHash: string;
}

export interface PushUpsert extends PushManifestUpsert {
  body: string;
}

export interface PushArchive {
  operation: "archive";
  pageId: string;
  previousPath: string;
}

export type PushManifestChange = PushManifestUpsert | PushArchive;
export type PushChange = PushUpsert | PushArchive;

export interface PushConfirmationManifest {
  protocolVersion: "1";
  spaceId: string;
  baseRevision: string;
  changes: PushManifestChange[];
}

export interface PushBatchWithoutHash {
  protocolVersion: "1";
  batchIndex: number;
  changes: PushChange[];
}

export interface PushBatch extends PushBatchWithoutHash {
  batchHash: string;
}

export interface RevisionContentManifest {
  protocolVersion: "1";
  spaceId: string;
  pages: Array<{
    pageId: string;
    path: string;
    title: string;
    contentHash: string;
  }>;
}

export interface SyncPage {
  pageId: string;
  path: string;
  title: string;
  body: string;
  contentHash: string;
  updatedAt: string;
}

export type DeltaItem =
  | { operation: "upsert"; page: SyncPage }
  | { operation: "archive"; pageId: string; previousPath: string };

export interface RevisionHeadResponse {
  protocolVersion: "1";
  spaceId: string;
  revision: string;
  sequence: number;
  revisionContentHash: string;
  pageCount: string;
  revisionManifestByteLength: string;
  revisionBodyBytes: string;
  publishedAt: string | null;
}

export interface SnapshotPage {
  protocolVersion: "1";
  spaceId: string;
  revision: string;
  sequence: number;
  revisionContentHash: string;
  pageCount: string;
  revisionManifestByteLength: string;
  revisionBodyBytes: string;
  items: SyncPage[];
  nextCursor: string | null;
}

export interface DeltaPage {
  protocolVersion: "1";
  spaceId: string;
  fromRevision: string;
  toRevision: string;
  toSequence: number;
  toRevisionContentHash: string;
  toPageCount: string;
  toRevisionManifestByteLength: string;
  toRevisionBodyBytes: string;
  items: DeltaItem[];
  nextCursor: string | null;
}

export type SyncErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "DEVICE_CREDENTIAL_REVOKED"
  | "DEVICE_CREDENTIAL_EXPIRED"
  | "USER_INACTIVE"
  | "SPACE_FORBIDDEN"
  | "SPACE_READ_ONLY"
  | "REVISION_GONE"
  | "CURSOR_INVALID"
  | "BASE_STALE"
  | "CREDENTIAL_COLLISION"
  | "PAYLOAD_INVALID"
  | "PAGE_TOO_LARGE"
  | "BATCH_TOO_LARGE"
  | "SPACE_TOO_LARGE"
  | "PUSH_SESSION_EXPIRED"
  | "PUSH_SESSION_NOT_FOUND"
  | "PUSH_SESSION_STATE_INVALID"
  | "IDEMPOTENCY_MISMATCH"
  | "CAPABILITIES_CHANGED"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export interface SyncApiErrorResponse {
  protocolVersion: "1";
  error: {
    code: SyncErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, string | number | boolean | null>;
  };
}

export interface SyncSpaceSummary {
  spaceId: string;
  displayName: string;
  role: "viewer" | "editor" | "admin" | "owner";
  canRead: true;
  canPublish: boolean;
  currentRevision: string;
  pageCount: string;
  revisionManifestByteLength: string;
  revisionBodyBytes: string;
}

export interface SyncSpaceListResponse {
  protocolVersion: "1";
  spaces: SyncSpaceSummary[];
}
