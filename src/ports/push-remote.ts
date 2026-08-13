import type { PushBatch, SyncCapabilities } from "../agentwiki/protocol";

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
export interface PushSessionInfo { sessionId: string; status: "uploading" | "ready_to_finalize" | "published" | "aborted" | "expired"; expiresAt: string; capabilities: SyncCapabilities; result: FinalizeResult | null }
export interface PushRemotePort {
  getHead(spaceId: string): Promise<{ revision: string }>;
  createSession(input: { spaceId: string; baseRevision: string; idempotencyKey: string; capabilitiesHash: string; confirmationHash: string; confirmationByteLength: number; changeCount: number; totalBodyBytes: number }): Promise<PushSessionInfo>;
  uploadBatch(sessionId: string, batch: PushBatch): Promise<{ receipt: string }>;
  finalize(sessionId: string, confirmationHash: string): Promise<FinalizeResult>;
  getSession(sessionId: string): Promise<PushSessionInfo>;
}
