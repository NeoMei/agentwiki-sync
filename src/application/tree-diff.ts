import {
  pathKey,
  validatePortableDirectoryPath,
} from "@neomei/agentwiki-sync-protocol";

import {
  mergeFoldersById,
  mergePagesById,
  type FolderConflict,
  type FolderConflictResolution,
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

export type {
  FolderConflict,
  FolderConflictResolution,
  TreePullAction,
} from "../core/merge";

export interface TreePullPreview {
  revision: string;
  actions: TreePullAction[];
  folderConflicts: FolderConflict[];
  folderConflictResolutions: Record<string, FolderConflictResolution>;
  pageConflicts: StructuredConflict[];
  /** @internal recompute state */
  readonly base: TreeSnapshot;
  readonly local: LocalTreeScan;
  readonly remote: TreeSnapshot;
  readonly pagePlan: PageMergePlan;
  resolvedFolders: TreeFolder[];
  resolvedPages: TreePage[];
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
  const byId = new Map(resolved.map((item) => [item.folderId, item]));

  for (const item of resolved) {
    if (item.manualPath) continue;
    if (item.parentFolderId !== null && !byId.has(item.parentFolderId))
      throw new TypeError("UNKNOWN_PARENT: 目录缺少父目录");
  }

  const pathById = new Map<string, string>();
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string): string => {
    const existing = pathById.get(id);
    if (existing !== undefined) return existing;
    const item = byId.get(id);
    if (!item) throw new TypeError("UNKNOWN_PARENT: 目录缺少父目录");
    if (item.manualPath) {
      pathById.set(id, item.manualPath);
      return item.manualPath;
    }
    if (state.get(id) === "visiting")
      throw new TypeError("FOLDER_CYCLE: 目录层级存在循环");
    state.set(id, "visiting");
    const path =
      item.parentFolderId === null
        ? `pages/${item.name}`
        : `${visit(item.parentFolderId)}/${item.name}`;
    state.set(id, "done");
    pathById.set(id, path);
    return path;
  };

  for (const item of resolved) visit(item.folderId);

  for (const item of resolved) {
    if (!item.manualPath) continue;
    const parent = parentPathOf(item.manualPath);
    if (parent === null) {
      item.parentFolderId = null;
      continue;
    }
    const parentFolder = resolved.find(
      (candidate) =>
        candidate.folderId !== item.folderId &&
        pathKey(pathById.get(candidate.folderId)!) === pathKey(parent),
    );
    if (!parentFolder) throw new TypeError("UNKNOWN_PARENT: 目录缺少父目录");
    item.parentFolderId = parentFolder.folderId;
  }

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
): {
  resolved: ResolvedTree;
  folderConflicts: FolderConflict[];
  pageConflicts: StructuredConflict[];
} {
  const resolvedFolders = [...folderPlan.resolved];
  const keptIds = new Set(resolvedFolders.map((f) => f.folderId));
  const deletedById = new Map(
    folderPlan.deleted.map((item) => [item.folderId, item]),
  );
  const folderConflicts = [...folderPlan.conflicts];

  const promote = (folderId: string): void => {
    if (keptIds.has(folderId)) return;
    const info = deletedById.get(folderId);
    if (!info || !info.local)
      throw new TypeError("UNKNOWN_PARENT: 目录缺少父目录");
    resolvedFolders.push(info.local);
    keptIds.add(folderId);
    folderConflicts.push({
      conflictId: `folder:${folderId}`,
      objectType: "folder",
      folderId,
      baseParentPath: info.baseParentPath,
      localParentPath: info.localParentPath,
      remoteParentPath: info.remoteParentPath,
      basePath: info.basePath,
      localPath: info.localPath,
      remotePath: info.remotePath,
    });
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const page of pagePlan.resolved) {
      if (page.folderId !== null && !keptIds.has(page.folderId)) {
        promote(page.folderId);
        changed = true;
      }
    }
    for (const folder of resolvedFolders) {
      if (
        folder.parentFolderId !== null &&
        !keptIds.has(folder.parentFolderId)
      ) {
        promote(folder.parentFolderId);
        changed = true;
      }
    }
  }

  const folders = materializeFolderPaths(resolvedFolders);
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
  return {
    resolved: { folders: validated.folders, pages: validated.pages },
    folderConflicts,
    pageConflicts: pagePlan.conflicts,
  };
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

function computePreview(
  base: TreeSnapshot,
  local: LocalTreeScan,
  remote: TreeSnapshot,
  pagePlan: PageMergePlan,
  folderConflictResolutions: Record<string, FolderConflictResolution>,
): TreePullPreview {
  const resolutions = new Map<string, FolderConflictResolution>();
  for (const [conflictId, resolution] of Object.entries(
    folderConflictResolutions,
  ))
    resolutions.set(conflictId.slice("folder:".length), resolution);

  const folderPlan = mergeFoldersById(
    base.folders,
    local.folders,
    remote.folders,
    resolutions,
  );
  const { resolved, folderConflicts, pageConflicts } = validateResolvedTree(
    folderPlan,
    pagePlan,
  );
  const actions = computeActions(
    base,
    resolved,
    folderConflicts,
    pageConflicts,
  );
  const candidate: PreviewCandidate = {
    base,
    local,
    remote,
    resolved,
    actions,
    folderConflicts,
    pageConflicts,
    folderConflictResolutions,
    pagePlan,
  };
  return orderPreviewActions(candidate);
}

export async function buildTreePullPreview(
  base: TreeSnapshot,
  local: LocalTreeScan,
  remote: TreeSnapshot,
): Promise<TreePullPreview> {
  const pagePlan = await mergePagesById(base.pages, local.pages, remote.pages);
  return computePreview(base, local, remote, pagePlan, {});
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
    if (!validated.path.startsWith("pages/"))
      throw new TypeError("MANAGED_ROOT: 目录必须位于 pages/ 下");

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
    if (current && parent !== null) {
      const currentKey = pathKey(current.path);
      const parentKey = pathKey(parent);
      if (parentKey === currentKey || parentKey.startsWith(`${currentKey}/`))
        throw new TypeError("FOLDER_CYCLE: 目录层级存在循环");
    }

    resolution = { choice: "manual", manualPath: validated.path };
  }

  const nextResolutions = {
    ...preview.folderConflictResolutions,
    [conflictId]: resolution,
  };
  const next = computePreview(
    preview.base,
    preview.local,
    preview.remote,
    preview.pagePlan,
    nextResolutions,
  );
  preview.folderConflictResolutions = nextResolutions;
  preview.actions = next.actions;
  preview.folderConflicts = next.folderConflicts;
  preview.pageConflicts = next.pageConflicts;
  preview.resolvedFolders = next.resolvedFolders;
  preview.resolvedPages = next.resolvedPages;
}

export function pendingTreeDecisionCount(preview: TreePullPreview): number {
  const unresolvedFolders = preview.folderConflicts.filter(
    (conflict) => !preview.folderConflictResolutions[conflict.conflictId],
  ).length;
  return unresolvedFolders + preview.pageConflicts.length;
}
