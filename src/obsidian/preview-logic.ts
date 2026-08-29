import type {
  InitialBindingChoice,
  PullPreview,
} from "../application/sync-runtime";
import {
  pathKey,
  validatePortableDirectoryPath,
} from "@neomei/agentwiki-sync-protocol";
import { userErrorMessage } from "../core/user-errors";

export const PREVIEW_PAGE_SIZE = 100;

export type SyncProtocolLabel = "Sync v2" | "Legacy v1";

export function protocolLabel(version: "1" | "2"): SyncProtocolLabel {
  return version === "2" ? "Sync v2" : "Legacy v1";
}

export function canRunSyncStrategy(
  canPublish: boolean,
  strategy: "auto" | "local" | "server",
): boolean {
  return strategy === "server" || canPublish;
}

export function preferLocalPull(preview: PullPreview): void {
  for (const conflict of preview.conflicts)
    preview.conflictResolutions[conflict.conflictId] = { choice: "local" };
  for (const conflict of preview.folderConflicts)
    preview.folderConflictResolutions[conflict.conflictId] = {
      choice: "local",
    };
  for (const binding of preview.initialBindings)
    if (binding.resolution === null)
      binding.resolution = binding.localPath ? "local" : "remote";
}

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

export function bindingsRequiringInput(
  bindings: readonly InitialBindingChoice[],
): InitialBindingChoice[] {
  return bindings.filter((binding) => binding.resolution === null);
}

export function pendingPreviewDecisionCount(
  bindings: readonly InitialBindingChoice[],
  preview: PullPreview | null,
): number {
  const pendingConflicts =
    preview?.conflicts.filter(
      (conflict) => !preview.conflictResolutions[conflict.conflictId],
    ).length ?? 0;
  const pendingFolderConflicts =
    preview?.folderConflicts.filter(
      (conflict) => !preview.folderConflictResolutions[conflict.conflictId],
    ).length ?? 0;
  return (
    bindingsRequiringInput(bindings).length +
    pendingConflicts +
    pendingFolderConflicts
  );
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

function folderParentPathOf(path: string): string | null {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return null;
  const parent = path.slice(0, slash);
  return parent === "pages" ? null : parent;
}

export function folderConflictValidationError(
  preview: PullPreview,
  conflictId: string,
  manualPath: string,
): string | null {
  const conflict = preview.folderConflicts.find(
    (item) => item.conflictId === conflictId,
  );
  if (!conflict) return "目录冲突不存在。请重新预览。";
  const trimmed = manualPath.trim();
  if (!trimmed) return "请填写目标路径。";
  let validated;
  try {
    validated = validatePortableDirectoryPath(trimmed);
  } catch (error) {
    return userErrorMessage(error);
  }
  if (!validated.path.startsWith("pages/")) return "目录必须位于 pages/ 下。";

  const parent = folderParentPathOf(validated.path);
  if (parent !== null) {
    const parentExists = preview.resolvedFolders.some(
      (folder) => pathKey(folder.path) === pathKey(parent),
    );
    if (!parentExists) return "父目录不存在。请选择已有目录作为父级。";
  }

  const collides =
    preview.resolvedFolders.some(
      (folder) =>
        folder.folderId !== conflict.folderId &&
        pathKey(folder.path) === pathKey(validated.path),
    ) ||
    preview.resolvedPages.some(
      (page) => pathKey(page.path) === pathKey(validated.path),
    );
  if (collides) return "目标路径已被占用。请选择其他路径。";

  const current = preview.resolvedFolders.find(
    (folder) => folder.folderId === conflict.folderId,
  );
  if (current && parent !== null) {
    const currentKey = pathKey(current.path);
    const parentKey = pathKey(parent);
    if (parentKey === currentKey || parentKey.startsWith(`${currentKey}/`))
      return "目录层级存在循环。请选择其他目标路径。";
  }

  return null;
}

export function applyFolderConflictResolution(
  preview: PullPreview,
  conflictId: string,
  mode: string,
  manualPath?: string,
): void {
  if (mode === "local" || mode === "remote") {
    preview.folderConflictResolutions[conflictId] = { choice: mode };
    return;
  }
  if (mode === "manual") {
    const trimmed = (manualPath ?? "").trim();
    if (!folderConflictValidationError(preview, conflictId, trimmed)) {
      const validated = validatePortableDirectoryPath(trimmed);
      preview.folderConflictResolutions[conflictId] = {
        choice: "manual",
        manualPath: validated.path,
      };
      return;
    }
    delete preview.folderConflictResolutions[conflictId];
    return;
  }
  delete preview.folderConflictResolutions[conflictId];
}

export function folderConflictManualValue(
  preview: PullPreview,
  conflictId: string,
): string {
  const resolution = preview.folderConflictResolutions[conflictId];
  return resolution?.choice === "manual" ? (resolution.manualPath ?? "") : "";
}
