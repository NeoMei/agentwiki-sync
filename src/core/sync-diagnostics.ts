import { TREE_SYNC_V3_HARD_LIMITS } from "@neomei/agentwiki-sync-protocol";

type Limits = { [K in keyof typeof TREE_SYNC_V3_HARD_LIMITS]: number };
export type BlobLimitKind =
  | "attachmentBytes"
  | "chunkCount"
  | "imageDimension"
  | "decodedPixels"
  | "attachmentCount"
  | "transferBytes";
export interface BlobLimitDetail {
  kind: BlobLimitKind;
  actual: number;
  limit: number;
  path?: string;
}
export class BlobLimitError extends RangeError {
  readonly retryable = false;
  constructor(readonly detail: BlobLimitDetail) {
    super("BLOB_LIMIT_EXCEEDED");
  }
}
export function assertLimit(
  kind: BlobLimitKind,
  actual: number,
  limit: number,
  path?: string,
): void {
  if (Number.isFinite(actual) && actual > limit)
    throw new BlobLimitError({
      kind,
      actual,
      limit,
      ...(path ? { path } : {}),
    });
}
export function assertBlobLimits(
  blob: { sizeBytes: string; width: number; height: number },
  caps: Omit<Limits, "maxConcurrentBlobs">,
  path?: string,
): void {
  const size = Number(blob.sizeBytes);
  assertLimit(
    "attachmentBytes",
    size,
    Math.min(
      caps.maxAttachmentBytes,
      TREE_SYNC_V3_HARD_LIMITS.maxAttachmentBytes,
    ),
    path,
  );
  assertLimit(
    "chunkCount",
    Math.ceil(
      size /
        Math.min(caps.blobChunkBytes, TREE_SYNC_V3_HARD_LIMITS.blobChunkBytes),
    ),
    Math.min(caps.maxBlobChunks, TREE_SYNC_V3_HARD_LIMITS.maxBlobChunks),
    path,
  );
  assertLimit(
    "imageDimension",
    Math.max(blob.width, blob.height),
    Math.min(
      caps.maxImageDimension,
      TREE_SYNC_V3_HARD_LIMITS.maxImageDimension,
    ),
    path,
  );
  assertLimit(
    "decodedPixels",
    blob.width * blob.height,
    Math.min(caps.maxDecodedPixels, TREE_SYNC_V3_HARD_LIMITS.maxDecodedPixels),
    path,
  );
}
const labels: Record<BlobLimitKind, string> = {
  attachmentBytes: "单附件大小（字节）",
  chunkCount: "单附件分块数",
  imageDimension: "图片边长（像素）",
  decodedPixels: "图片总像素",
  attachmentCount: "附件数量",
  transferBytes: "本次传输总量（字节）",
};
export function blobLimitMessage(detail: BlobLimitDetail): string {
  return `${labels[detail.kind]}超限${detail.path ? `：${detail.path}` : "（未提供具体附件路径）"}。实际 ${detail.actual}，上限 ${detail.limit}。请压缩图片、缩小尺寸或减少本次附件数量后重试。`;
}

export interface RecoveryEvidence {
  spaceId?: string;
  transactionId?: string;
  sessionId?: string;
  remoteStatus?: string;
  localPhase?: string;
  publishedRevision?: string;
}
/** Keeps the original message so existing recovery code comparisons stay valid. */
export class RecoveryDiagnosticError extends Error {
  constructor(
    message: string,
    readonly evidence: RecoveryEvidence,
    readonly original?: unknown,
  ) {
    super(message);
  }
}
export interface SafeSyncDiagnostic {
  formatVersion: 1;
  spaceId: string;
  transactionId?: string;
  sessionId?: string;
  remoteStatus: string;
  remoteCommit: string;
  localPhase: string;
  publishedRevision?: string;
}
export function recoveryDiagnostic(
  error: unknown,
  spaceId: string,
): SafeSyncDiagnostic {
  const evidence =
    error instanceof RecoveryDiagnosticError ? error.evidence : {};
  return {
    formatVersion: 1,
    spaceId,
    ...(evidence.transactionId
      ? { transactionId: evidence.transactionId }
      : {}),
    ...(evidence.sessionId ? { sessionId: evidence.sessionId } : {}),
    remoteStatus: evidence.remoteStatus ?? "unknown",
    remoteCommit: evidence.publishedRevision
      ? "已确认远端发布"
      : "远端提交状态未确认；请勿重新发起推送",
    localPhase: evidence.localPhase ?? "unknown",
    ...(evidence.publishedRevision
      ? { publishedRevision: evidence.publishedRevision }
      : {}),
  };
}
/** Explicitly re-project at export, never serialize an Error, journal or HTTP body. */
export async function exportDiagnostic(
  value: SafeSyncDiagnostic,
  write: (json: string) => Promise<void>,
): Promise<void> {
  const safe = recoveryDiagnostic(
    new RecoveryDiagnosticError("", {
      transactionId: value.transactionId,
      sessionId: value.sessionId,
      remoteStatus: value.remoteStatus,
      localPhase: value.localPhase,
      publishedRevision: value.publishedRevision,
    }),
    value.spaceId,
  );
  await write(JSON.stringify(safe, null, 2));
}

const recoveryStateLabels: Record<string, string> = {
  unknown: "未知",
  expired: "已过期",
  aborted: "已终止",
  published: "已发布",
  uploading: "上传中",
  ready_to_finalize: "待提交",
  finalizing: "提交核对中",
  not_created: "尚未创建",
  not_started: "尚未确认完成",
  verified: "已核对完成",
  superseded: "已终结",
  confirmed: "已确认，等待处理",
  remote_pending: "远端操作待核对",
  local_pending: "本地应用待完成",
  complete: "已完成",
};
export function recoveryStateLabel(state: string): string {
  return Object.hasOwn(recoveryStateLabels, state)
    ? recoveryStateLabels[state]!
    : "未知";
}
