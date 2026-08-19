import { yieldToUi } from "./sync-coordinator";

export interface SyncProgress {
  phase: "scan" | "download" | "merge" | "upload" | "finalize" | "apply";
  completed: number;
  total?: number;
  cancellable: boolean;
}

export interface SyncOperationOptions {
  signal?: AbortSignal;
  onProgress?: (progress: SyncProgress) => void;
}

export class SyncCancelledError extends Error {
  constructor() {
    super("同步已取消");
  }
}

export function progressLabel(progress: SyncProgress): string {
  const phases: Record<SyncProgress["phase"], string> = {
    scan: "扫描",
    download: "下载",
    merge: "合并",
    upload: "上传批次",
    finalize: "服务器原子发布",
    apply: "本地原子应用",
  };
  return `${phases[progress.phase]} ${progress.completed}${progress.total === undefined ? "" : ` / ${progress.total}`}`;
}

export function cancellationCheckpoint(
  options: SyncOperationOptions | undefined,
  cancellable: boolean,
): void {
  if (cancellable && options?.signal?.aborted) throw new SyncCancelledError();
}

export function reportProgress(
  options: SyncOperationOptions | undefined,
  progress: SyncProgress,
): void {
  cancellationCheckpoint(options, progress.cancellable);
  options?.onProgress?.(progress);
}

export async function progressCheckpoint(
  options: SyncOperationOptions | undefined,
  progress: SyncProgress,
): Promise<void> {
  if (!options) return;
  reportProgress(options, progress);
  await yieldToUi();
  cancellationCheckpoint(options, progress.cancellable);
}
