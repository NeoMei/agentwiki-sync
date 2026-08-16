import type {
  InitialBindingChoice,
  PullPreview,
} from "../application/sync-runtime";

export const PREVIEW_PAGE_SIZE = 100;

export interface LocalCandidate {
  path: string;
  vaultByteHash: string;
}

export function pageCount(total: number, pageSize = PREVIEW_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}

export function clampPage(
  page: number,
  total: number,
  pageSize = PREVIEW_PAGE_SIZE,
): number {
  const count = pageCount(total, pageSize);
  return page < 0 ? 0 : page >= count ? count - 1 : page;
}

export function pageSlice<T>(
  items: readonly T[],
  page: number,
  pageSize = PREVIEW_PAGE_SIZE,
): T[] {
  const start = clampPage(page, items.length, pageSize) * pageSize;
  return items.slice(start, start + pageSize);
}

export function matchCandidates(
  candidates: readonly LocalCandidate[],
  query: string,
  limit = 20,
): LocalCandidate[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];
  return candidates
    .filter((candidate) =>
      candidate.path.toLocaleLowerCase().includes(normalized),
    )
    .slice(0, limit);
}

export function applyBindingPath(
  binding: InitialBindingChoice,
  candidates: readonly LocalCandidate[],
  path: string,
): void {
  const candidate = candidates.find((item) => item.path === path) ?? null;
  binding.localPath = candidate?.path ?? null;
  binding.localBody = null;
  binding.localVaultByteHash = candidate?.vaultByteHash ?? null;
  binding.resolution = candidate ? null : "remote";
}

export function applyBindingSearch(
  binding: InitialBindingChoice,
  candidates: readonly LocalCandidate[],
  query: string,
  limit = 20,
): string[] {
  const trimmed = query.trim();
  if (!trimmed) {
    applyBindingPath(binding, candidates, "");
    return [];
  }
  if (candidates.some((candidate) => candidate.path === trimmed)) {
    applyBindingPath(binding, candidates, trimmed);
  }
  return matchCandidates(candidates, trimmed, limit).map(
    (candidate) => candidate.path,
  );
}

export function applyBindingMode(
  binding: InitialBindingChoice,
  mode: string,
): void {
  binding.resolution =
    mode === "local" || mode === "remote" || mode === "manual" ? mode : null;
}

export function applyConflictResolution(
  preview: PullPreview,
  conflictId: string,
  mode: string,
  manualValue?: string,
): void {
  if (mode === "local" || mode === "remote" || mode === "manual") {
    preview.conflictResolutions[conflictId] =
      mode === "manual" ? { choice: "manual", manualValue } : { choice: mode };
  } else {
    delete preview.conflictResolutions[conflictId];
  }
}

export function conflictManualValue(
  preview: PullPreview,
  conflictId: string,
): string {
  const resolution = preview.conflictResolutions[conflictId];
  return resolution?.choice === "manual" ? (resolution.manualValue ?? "") : "";
}
