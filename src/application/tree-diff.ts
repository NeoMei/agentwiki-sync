import {
  pathKey,
  validatePortableDirectoryPath,
} from "@neomei/agentwiki-sync-protocol";

import {
  mergeFoldersById,
  mergePagesById,
  type FolderConflict,
  type FolderMergePlan,
  type PageMergePlan,
  type ResolvedFolderLocation,
  type ResolvedPageLocation,
  type StructuredConflict,
  type TreePullAction,
} from "../core/merge";
import type { LocalTreeScan } from "../core/tree-scan";
import type { TreeFolder, TreePage, TreeSnapshot } from "../core/tree-model";
import { validateTreeSnapshot } from "../core/tree-validation";
import { orderPreviewActions, type PreviewCandidate } from "./tree-preview";

export type { FolderConflict, TreePullAction } from "../core/merge";

export interface FolderConflictResolution {
  choice: "local" | "remote" | "manual";
  manualPath?: string;
}

export interface TreePullPreview {
  revision: string;
  actions: TreePullAction[];
  folderConflicts: FolderConflict[];
  folderConflictResolutions: Record<string, FolderConflictResolution>;
  pageConflicts: StructuredConflict[];
  /** @internal resolved tree used to validate manual folder resolutions. */
  readonly resolvedFolders: TreeFolder[];
  readonly resolvedPages: TreePage[];
}

export interface ResolvedTree {
  folders: TreeFolder[];
  pages: TreePage[];
}

function parentPathOf(path: string): string | null {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return null;
  const parent = path.slice(0, slash);
  return parent === "pages" ? null : parent;
}

function materializeFolderPaths(
  resolved: ResolvedFolderLocation[],
): TreeFolder[] {
  const locationById = new Map(resolved.map((item) => [item.folderId, item]));

  for (const item of resolved) {
    if (item.parentFolderId !== null && !locationById.has(item.parentFolderId))
      throw new TypeError("UNKNOWN_PARENT: 目录缺少父目录");
  }

  const children = new Map<string | null, string[]>();
  for (const item of resolved) {
    const list = children.get(item.parentFolderId);
    if (list) list.push(item.folderId);
    else children.set(item.parentFolderId, [item.folderId]);
  }

  const pathById = new Map<string, string>();
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, parentPath: string | null): void => {
    const current = state.get(id);
    if (current === "done") return;
    if (current === "visiting")
      throw new TypeError("FOLDER_CYCLE: 目录层级存在循环");
    state.set(id, "visiting");
    const location = locationById.get(id)!;
    const path =
      parentPath === null
        ? `pages/${location.name}`
        : `${parentPath}/${location.name}`;
    pathById.set(id, path);
    for (const child of children.get(id) ?? []) visit(child, path);
    state.set(id, "done");
  };
  for (const root of children.get(null) ?? []) visit(root, null);

  for (const id of resolved.map((item) => item.folderId))
    if (!pathById.has(id))
      throw new TypeError("FOLDER_CYCLE: 目录层级存在循环");

  const sorted = [...resolved].sort((left, right) => {
    const leftKey = pathKey(pathById.get(left.folderId)!);
    const rightKey = pathKey(pathById.get(right.folderId)!);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  return sorted.map((item) => ({
    folderId: item.folderId,
    parentFolderId: item.parentFolderId,
    name: item.name,
    path: pathById.get(item.folderId)!,
    sortOrder: item.sortOrder,
    updatedAt: item.updatedAt,
  }));
}

function materializePagePaths(
  resolved: ResolvedPageLocation[],
  folderPathById: Map<string, string>,
): TreePage[] {
  const pages: TreePage[] = [];
  for (const item of resolved) {
    let folderPath: string | null = null;
    if (item.folderId !== null) {
      folderPath = folderPathById.get(item.folderId) ?? null;
      if (folderPath === null)
        throw new TypeError("UNKNOWN_PARENT: 页面缺少父目录");
    }
    const path =
      folderPath === null
        ? `pages/${item.filename}`
        : `${folderPath}/${item.filename}`;
    pages.push({
      pageId: item.pageId,
      folderId: item.folderId,
      path,
      title: item.title,
      body: item.body,
      contentHash: item.contentHash,
      updatedAt: item.updatedAt,
    });
  }
  return pages;
}

export function validateResolvedTree(
  folderPlan: FolderMergePlan,
  pagePlan: PageMergePlan,
): ResolvedTree {
  const folders = materializeFolderPaths(folderPlan.resolved);
  const folderPathById = new Map(folders.map((f) => [f.folderId, f.path]));
  const pages = materializePagePaths(pagePlan.resolved, folderPathById);

  const validated = validateTreeSnapshot({
    protocolVersion: "2",
    spaceId: "",
    revision: "",
    revisionContentHash: "",
    folders,
    pages,
  });
  return { folders: validated.folders, pages: validated.pages };
}

function bodyPathFor(pageId: string): string {
  return `tree-preview-body/${pageId}.md`;
}

function computeActions(
  base: TreeSnapshot,
  resolved: ResolvedTree,
  folderConflicts: FolderConflict[],
  pageConflicts: StructuredConflict[],
): TreePullAction[] {
  const actions: TreePullAction[] = [];

  const conflictedFolders = new Set(folderConflicts.map((c) => c.folderId));
  const baseFolders = new Map(base.folders.map((f) => [f.folderId, f]));
  const resolvedFolders = new Map(resolved.folders.map((f) => [f.folderId, f]));

  for (const folder of resolved.folders) {
    if (conflictedFolders.has(folder.folderId)) continue;
    const before = baseFolders.get(folder.folderId);
    if (!before)
      actions.push({
        kind: "create_directory",
        folderId: folder.folderId,
        path: folder.path,
      });
    else if (pathKey(before.path) !== pathKey(folder.path))
      actions.push({
        kind: "move_directory",
        folderId: folder.folderId,
        fromPath: before.path,
        path: folder.path,
      });
  }
  for (const before of base.folders) {
    if (conflictedFolders.has(before.folderId)) continue;
    if (!resolvedFolders.has(before.folderId))
      actions.push({
        kind: "trash_directory",
        folderId: before.folderId,
        path: before.path,
      });
  }

  const conflictedPages = new Set(pageConflicts.map((c) => c.pageId));
  const basePages = new Map(base.pages.map((p) => [p.pageId, p]));
  const resolvedPages = new Map(resolved.pages.map((p) => [p.pageId, p]));

  for (const page of resolved.pages) {
    if (conflictedPages.has(page.pageId)) continue;
    const before = basePages.get(page.pageId);
    if (!before)
      actions.push({
        kind: "create_page",
        pageId: page.pageId,
        path: page.path,
        bodyPath: bodyPathFor(page.pageId),
      });
    else if (pathKey(before.path) !== pathKey(page.path))
      actions.push({
        kind: "move_page",
        pageId: page.pageId,
        fromPath: before.path,
        path: page.path,
        bodyPath: bodyPathFor(page.pageId),
      });
    else if (before.contentHash !== page.contentHash)
      actions.push({
        kind: "write_page",
        pageId: page.pageId,
        path: page.path,
        bodyPath: bodyPathFor(page.pageId),
      });
  }
  for (const before of base.pages) {
    if (conflictedPages.has(before.pageId)) continue;
    if (!resolvedPages.has(before.pageId))
      actions.push({
        kind: "trash_page",
        pageId: before.pageId,
        path: before.path,
      });
  }

  return actions;
}

export async function buildTreePullPreview(
  base: TreeSnapshot,
  local: LocalTreeScan,
  remote: TreeSnapshot,
): Promise<TreePullPreview> {
  const folderPlan = mergeFoldersById(
    base.folders,
    local.folders,
    remote.folders,
  );
  const pagePlan = await mergePagesById(base.pages, local.pages, remote.pages);
  const resolved = validateResolvedTree(folderPlan, pagePlan);
  const actions = computeActions(
    base,
    resolved,
    folderPlan.conflicts,
    pagePlan.conflicts,
  );
  const candidate: PreviewCandidate = {
    base,
    local,
    remote,
    resolved,
    actions,
    folderConflicts: folderPlan.conflicts,
    pageConflicts: pagePlan.conflicts,
  };
  return orderPreviewActions(candidate);
}

export function resolveFolderConflict(
  preview: TreePullPreview,
  conflictId: string,
  resolution: FolderConflictResolution,
): void {
  const conflict = preview.folderConflicts.find(
    (item) => item.conflictId === conflictId,
  );
  if (!conflict)
    throw new TypeError("FOLDER_CONFLICT_NOT_FOUND: 目录冲突不存在");

  if (resolution.choice === "manual") {
    const manualPath = resolution.manualPath;
    if (!manualPath)
      throw new TypeError("MANUAL_PATH_REQUIRED: 请填写目标路径");
    const validated = validatePortableDirectoryPath(manualPath);

    const parent = parentPathOf(validated.path);
    if (parent !== null) {
      const parentExists = preview.resolvedFolders.some(
        (folder) => pathKey(folder.path) === pathKey(parent),
      );
      if (!parentExists) throw new TypeError("UNKNOWN_PARENT: 目录缺少父目录");
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
    if (collides) throw new TypeError("PATH_COLLISION: 目标路径已被占用");

    const current = preview.resolvedFolders.find(
      (folder) => folder.folderId === conflict.folderId,
    );
    if (
      current &&
      parent !== null &&
      (parent === current.path || parent.startsWith(`${current.path}/`))
    )
      throw new TypeError("FOLDER_CYCLE: 目录层级存在循环");

    resolution = { choice: "manual", manualPath: validated.path };
  }

  preview.folderConflictResolutions[conflictId] = resolution;
}

export function pendingTreeDecisionCount(preview: TreePullPreview): number {
  const unresolvedFolders = preview.folderConflicts.filter(
    (conflict) => !preview.folderConflictResolutions[conflict.conflictId],
  ).length;
  return unresolvedFolders + preview.pageConflicts.length;
}
