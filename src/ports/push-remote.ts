import type {
  PushBatch,
  SnapshotPage,
  SyncCapabilities,
  SyncPage,
} from "../agentwiki/protocol";

export interface FinalizeResult {
  status: "published" | "noop";
  revision: string;
  sequence: number;
  publishedAt: string | null;
  revisionContentHash: string;
  pageCount: string;
  revisionManifestByteLength: string;
  revisionBodyBytes: string;
  changeSetId: string | null;
}
export interface PushSessionInfo {
  sessionId: string;
  status:
    "uploading" | "ready_to_finalize" | "published" | "aborted" | "expired";
  expiresAt: string;
  capabilities: SyncCapabilities;
  result: FinalizeResult | null;
}
export interface PushSessionStatusInfo {
  sessionId: string;
  status: PushSessionInfo["status"];
  expiresAt: string;
  receivedBatchIndexes: number[];
  result: FinalizeResult | null;
}
export interface SnapshotResult {
  revision: string;
  revisionContentHash: string;
  pageCount: string;
  revisionManifestByteLength: string;
  revisionBodyBytes: string;
  items: SyncPage[];
}
export interface PushRemotePort {
  getHead(spaceId: string): Promise<{ revision: string; pageCount?: string }>;
  createSession(input: {
    baseRevision: string;
    idempotencyKey: string;
    capabilitiesHash: string;
    confirmationHash: string;
    confirmationByteLength: number;
    changeCount: number;
    totalBodyBytes: number;
  }): Promise<PushSessionInfo>;
  uploadBatch(
    sessionId: string,
    batch: PushBatch,
  ): Promise<{ receipt: string }>;
  finalize(
    sessionId: string,
    confirmationHash: string,
  ): Promise<FinalizeResult>;
  getSession(sessionId: string): Promise<PushSessionStatusInfo>;
  snapshotPages?(revision?: string): AsyncIterable<{
    metadata: Omit<SnapshotPage, "items" | "nextCursor">;
    items: SyncPage[];
  }>;
}
