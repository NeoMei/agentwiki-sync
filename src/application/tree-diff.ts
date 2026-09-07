import {
  pathKey,
  validatePortableDirectoryPath,
  validatePortableMarkdownPath,
} from "@neomei/agentwiki-sync-protocol";

import { contentHash } from "../agentwiki/protocol";

import { parseAttachmentReferences } from "../core/attachment-reference";
import {
  mergeAttachmentsById,
  rewriteAttachmentPageReferences,
  type AttachmentConflict,
  type AttachmentConflictResolution,
  type AttachmentMergePlan,
  type AttachmentRewriteBlocker,
} from "../core/attachment-merge";
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
  type TreePullActionV3,
} from "../core/merge";
import type {
  AttachmentScanBlocker,
  LocalTreeScan,
  LocalTreeScanV3,
} from "../core/tree-scan";
import type {
  TreeAttachment,
  TreeFolder,
  TreePage,
  TreePageV3,
  TreeSnapshot,
  TreeSnapshotV3,
} from "../core/tree-model";
import {
  validateTreeSnapshot,
  validateTreeContentV3,
  type TreeContentV3,
} from "../core/tree-validation";
import { sortTreePullActions } from "./tree-preview";
import { retainNormalizedPageWrites } from "./normalized-push-plan";

export type {
  AttachmentConflict,
  AttachmentConflictResolution,
  FolderConflict,
  FolderConflictResolution,
  TreePullAction,
  TreePullActionV3,
} from "../core/merge";

type TreeContentV2 = Pick<
  TreeSnapshot,
  "protocolVersion" | "spaceId" | "folders" | "pages"
>;

export interface TreePullPreview<TTree extends TreeContentV2 = TreeSnapshot> {
  revision: string;
  actions: TreePullAction[];
  folderConflicts: FolderConflict[];
  folderConflictResolutions: Record<string, FolderConflictResolution>;
  pageConflicts: StructuredConflict[];
  pageConflictResolutions: Record<string, PageConflictResolution>;
  /** @internal recompute state */
  readonly base: TTree;
  readonly local: LocalTreeScan;
  readonly remote: TTree;
  pagePlan: PageMergePlan;
  resolvedFolders: TreeFolder[];
  resolvedPages: TreePage[];
}

export interface TreePullPreviewV3<
  TTree extends TreeContentV3 = TreeSnapshotV3,
> {
  revision: string;
  actions: TreePullActionV3[];
  blockers: Array<AttachmentScanBlocker | AttachmentRewriteBlocker>;
  attachmentConflicts: AttachmentConflict[];
  attachmentConflictResolutions: Record<string, AttachmentConflictResolution>;
  folderConflicts: FolderConflict[];
  folderConflictResolutions: Record<string, FolderConflictResolution>;
  pageConflicts: StructuredConflict[];
  pageConflictResolutions: Record<string, PageConflictResolution>;
  readonly base: TTree;
  readonly local: LocalTreeScanV3;
  readonly remote: TTree;
  pagePlan: PageMergePlan;
  attachmentPlan: AttachmentMergePlan;
  resolvedFolders: TreeFolder[];
  resolvedPages: TreePageV3[];
  resolvedAttachments: TreeAttachment[];
}

export interface PageConflictResolution {
  choice: "local" | "remote" | "manual";
  manualValue?: string;
  manualPath?: string;
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
  base: TreeContentV2,
  local: LocalTreeScan,
  resolved: ResolvedTree,
  folderConflicts: FolderConflict[],
  pageConflicts: StructuredConflict[],
): TreePullAction[] {
  const actions: TreePullAction[] = [];

  const conflictedFolders = new Set(folderConflicts.map((c) => c.folderId));
  const baseFolders = new Map(base.folders.map((f) => [f.folderId, f]));
  const localFolders = new Map(local.folders.map((f) => [f.folderId, f]));
  const resolvedFolders = new Map(resolved.folders.map((f) => [f.folderId, f]));

  const resolvedFolderPath = (folderId: string | null): string | null => {
    if (folderId === null) return null;
    return resolvedFolders.get(folderId)?.path ?? null;
  };

  const filenameOf = (path: string): string => path.split("/").at(-1) ?? "";

  for (const folder of resolved.folders) {
    if (conflictedFolders.has(folder.folderId)) continue;
    const before =
      baseFolders.get(folder.folderId) ?? localFolders.get(folder.folderId);
    if (!before)
      actions.push({
        kind: "create_directory",
        folderId: folder.folderId,
        path: folder.path,
      });
    else if (
      before.parentFolderId !== folder.parentFolderId ||
      before.name !== folder.name
    ) {
      const parentPath = resolvedFolderPath(before.parentFolderId);
      const fromPath =
        before.parentFolderId === null || parentPath === null
          ? before.path
          : `${parentPath}/${before.name}`;
      actions.push({
        kind: "move_directory",
        folderId: folder.folderId,
        fromPath,
        path: folder.path,
        ...(pathKey(fromPath) === pathKey(before.path)
          ? {}
          : { beforePath: before.path }),
      });
    }
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
  const localPages = new Map(local.pages.map((p) => [p.pageId, p]));
  const resolvedPages = new Map(resolved.pages.map((p) => [p.pageId, p]));

  for (const page of resolved.pages) {
    if (conflictedPages.has(page.pageId)) continue;
    const before = basePages.get(page.pageId) ?? localPages.get(page.pageId);
    if (!before)
      actions.push({
        kind: "create_page",
        pageId: page.pageId,
        path: page.path,
        bodyPath: bodyPathFor(page.pageId),
      });
    else {
      const beforeFilename = filenameOf(before.path);
      const locationChanged =
        before.folderId !== page.folderId ||
        beforeFilename !== filenameOf(page.path);
      if (locationChanged) {
        const parentPath = resolvedFolderPath(before.folderId);
        const fromPath =
          before.folderId === null || parentPath === null
            ? before.path
            : `${parentPath}/${beforeFilename}`;
        actions.push({
          kind: "move_page",
          pageId: page.pageId,
          fromPath,
          path: page.path,
          bodyPath: bodyPathFor(page.pageId),
          ...(pathKey(fromPath) === pathKey(before.path)
            ? {}
            : { beforePath: before.path }),
        });
      } else if (before.contentHash !== page.contentHash) {
        actions.push({
          kind: "write_page",
          pageId: page.pageId,
          path: page.path,
          bodyPath: bodyPathFor(page.pageId),
          ...(pathKey(before.path) === pathKey(page.path)
            ? {}
            : { beforePath: before.path }),
        });
      }
    }
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

function computePreview<TTree extends TreeContentV2>(
  base: TTree,
  local: LocalTreeScan,
  remote: TTree,
  revision: string,
  pagePlan: PageMergePlan,
  folderConflictResolutions: Record<string, FolderConflictResolution>,
  pageConflictResolutions: Record<string, PageConflictResolution>,
): TreePullPreview<TTree> {
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
    local,
    resolved,
    folderConflicts,
    pageConflicts,
  );
  return {
    revision,
    actions: sortTreePullActions(actions),
    folderConflicts,
    folderConflictResolutions,
    pageConflicts,
    pageConflictResolutions,
    base,
    local,
    remote,
    pagePlan,
    resolvedFolders: resolved.folders,
    resolvedPages: resolved.pages,
  };
}

async function resolvePagePlan(
  pagePlan: PageMergePlan,
  resolutions: Record<string, PageConflictResolution>,
  base: TreeContentV2,
  local: LocalTreeScan,
  remote: TreeContentV2,
): Promise<PageMergePlan> {
  if (Object.keys(resolutions).length === 0) return pagePlan;
  const basePages = new Map(base.pages.map((page) => [page.pageId, page]));
  const localPages = new Map(local.pages.map((page) => [page.pageId, page]));
  const remotePages = new Map(remote.pages.map((page) => [page.pageId, page]));

  const folderPathById = new Map<string, string>();
  for (const folder of [...base.folders, ...local.folders, ...remote.folders])
    folderPathById.set(folder.folderId, folder.path);
  const folderIdByPath = new Map<string, string>();
  for (const [folderId, path] of folderPathById)
    folderIdByPath.set(pathKey(path), folderId);

  const applyLocation = (page: ResolvedPageLocation, path: string): void => {
    const slash = path.lastIndexOf("/");
    const folderPath = slash > 0 ? path.slice(0, slash) : null;
    const filename = slash >= 0 ? path.slice(slash + 1) : path;
    if (folderPath === "pages" || folderPath === null) {
      page.folderId = null;
      page.filename = filename;
      return;
    }
    const folderId = folderIdByPath.get(pathKey(folderPath)) ?? null;
    if (folderId === null)
      throw new TypeError("UNKNOWN_PARENT: 目录缺少父目录");
    page.folderId = folderId;
    page.filename = filename;
  };

  const toResolved = (
    source: TreePage,
    body: string,
    contentHashValue: string,
  ): ResolvedPageLocation => ({
    pageId: source.pageId,
    folderId: source.folderId,
    filename: source.path.split("/").at(-1) ?? "",
    title: source.title,
    body,
    contentHash: contentHashValue,
    updatedAt: source.updatedAt,
  });

  const resolvedById = new Map(
    pagePlan.resolved.map((page) => [page.pageId, { ...page }]),
  );
  const removedIds = new Set<string>();

  for (const [conflictId, resolution] of Object.entries(resolutions)) {
    const conflict = pagePlan.conflicts.find(
      (item) => item.conflictId === conflictId,
    );
    if (!conflict) continue;
    const basePage = basePages.get(conflict.pageId);
    const localPage = localPages.get(conflict.pageId);
    const remotePage = remotePages.get(conflict.pageId);

    switch (conflict.field) {
      case "body": {
        const value =
          resolution.choice === "manual"
            ? (resolution.manualValue ??
              localPage?.body ??
              remotePage?.body ??
              "")
            : resolution.choice === "local"
              ? (localPage?.body ?? conflict.local)
              : (remotePage?.body ?? conflict.remote);
        const existing = resolvedById.get(conflict.pageId);
        if (existing)
          resolvedById.set(conflict.pageId, {
            ...existing,
            body: value,
            contentHash: await contentHash(value),
          });
        break;
      }
      case "title": {
        const value =
          resolution.choice === "manual"
            ? (resolution.manualValue ??
              localPage?.title ??
              remotePage?.title ??
              "")
            : resolution.choice === "local"
              ? (localPage?.title ?? conflict.local)
              : (remotePage?.title ?? conflict.remote);
        const existing = resolvedById.get(conflict.pageId);
        if (existing)
          resolvedById.set(conflict.pageId, { ...existing, title: value });
        break;
      }
      case "path": {
        const value =
          resolution.choice === "manual"
            ? (resolution.manualPath ?? conflict.local)
            : resolution.choice === "local"
              ? conflict.local
              : conflict.remote;
        const validated = validatePortableMarkdownPath(value);
        const holder: ResolvedPageLocation = {
          pageId: conflict.pageId,
          folderId: null,
          filename: "",
          title: "",
          body: "",
          contentHash: "",
          updatedAt: "",
        };
        applyLocation(holder, validated.path);
        const existing = resolvedById.get(conflict.pageId);
        if (existing)
          resolvedById.set(conflict.pageId, {
            ...existing,
            folderId: holder.folderId,
            filename: holder.filename,
          });
        break;
      }
      case "archive": {
        if (resolution.choice === "remote") {
          removedIds.add(conflict.pageId);
        } else {
          const value =
            resolution.choice === "manual"
              ? (resolution.manualValue ?? localPage?.body ?? conflict.local)
              : (localPage?.body ?? conflict.local);
          const source = localPage ?? basePage;
          if (source)
            resolvedById.set(
              conflict.pageId,
              toResolved(source, value, await contentHash(value)),
            );
        }
        break;
      }
      case "delete": {
        if (resolution.choice === "local") {
          removedIds.add(conflict.pageId);
        } else {
          const value =
            resolution.choice === "manual"
              ? (resolution.manualValue ?? remotePage?.body ?? conflict.remote)
              : (remotePage?.body ?? conflict.remote);
          const source = remotePage ?? basePage;
          if (source)
            resolvedById.set(
              conflict.pageId,
              toResolved(source, value, await contentHash(value)),
            );
        }
        break;
      }
    }
  }

  const resolved = [...resolvedById.values()].filter(
    (page) => !removedIds.has(page.pageId),
  );
  return {
    resolved,
    conflicts: pagePlan.conflicts.filter(
      (conflict) => !resolutions[conflict.conflictId],
    ),
  };
}

export async function buildTreePullPreview(
  base: TreeSnapshot,
  local: LocalTreeScan,
  remote: TreeSnapshot,
): Promise<TreePullPreview> {
  const pagePlan = await mergePagesById(base.pages, local.pages, remote.pages);
  return computePreview(base, local, remote, remote.revision, pagePlan, {}, {});
}

function legacyContent(snapshot: TreeContentV3): TreeContentV2 {
  return {
    protocolVersion: "2",
    spaceId: snapshot.spaceId,
    folders: snapshot.folders,
    pages: snapshot.pages.map(
      ({ referencedAttachmentIds: _ids, ...page }) => page,
    ),
  };
}

function legacyScan(scan: LocalTreeScanV3): LocalTreeScan {
  return {
    rootPath: scan.rootPath,
    folders: scan.folders,
    pages: scan.pages.map(({ referencedAttachmentIds: _ids, ...page }) => page),
  };
}

function sourcePageFor(
  resolved: TreePage,
  base: TreeContentV3,
  local: LocalTreeScanV3,
  remote: TreeContentV3,
): TreePageV3 | undefined {
  const candidates = [local.pages, remote.pages, base.pages]
    .map((pages) => pages.find((page) => page.pageId === resolved.pageId))
    .filter((page): page is TreePageV3 => page !== undefined);
  const exact = candidates.find((page) => page.body === resolved.body);
  if (exact) return exact;

  const idsByPath = new Map<string, Set<string>>();
  for (const attachment of [
    ...local.attachments,
    ...remote.attachments,
    ...base.attachments,
  ]) {
    const key = pathKey(attachment.path);
    const ids = idsByPath.get(key) ?? new Set<string>();
    ids.add(attachment.attachmentId);
    idsByPath.set(key, ids);
  }
  for (const candidate of candidates) {
    const ids = new Set<string>();
    let valid = true;
    for (const reference of parseAttachmentReferences(
      resolved.body,
      candidate.path,
    )) {
      if (reference.classification === "invalid") {
        valid = false;
        break;
      }
      if (
        reference.classification !== "local" &&
        reference.classification !== "legacy"
      )
        continue;
      const referenceKey = pathKey(
        reference.classification === "legacy"
          ? `assets/${reference.target}`
          : reference.resolvedPath!,
      );
      const matchingIds = idsByPath.get(referenceKey);
      if (!matchingIds || matchingIds.size !== 1) {
        valid = false;
        break;
      }
      ids.add([...matchingIds][0]!);
    }
    if (valid)
      return {
        ...candidate,
        body: resolved.body,
        referencedAttachmentIds: [...ids].sort(),
      };
  }
  return candidates[0];
}

function attachmentReferencesByPage(
  pages: TreePage[],
  base: TreeContentV3,
  local: LocalTreeScanV3,
  remote: TreeContentV3,
): Map<string, TreePageV3> {
  const result = new Map<string, TreePageV3>();
  for (const page of pages) {
    const source = sourcePageFor(page, base, local, remote);
    if (source) result.set(page.pageId, source);
  }
  return result;
}

function affectedPagesByAttachment(
  sourcePages: Map<string, TreePageV3>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const page of sourcePages.values())
    for (const attachmentId of page.referencedAttachmentIds)
      (result[attachmentId] ??= []).push(page.pageId);
  for (const pageIds of Object.values(result)) pageIds.sort();
  return result;
}

function resolvedPagePlan(pages: TreePageV3[]): PageMergePlan {
  return {
    resolved: pages.map((page) => ({
      pageId: page.pageId,
      folderId: page.folderId,
      filename: page.path.split("/").at(-1) ?? "",
      title: page.title,
      body: page.body,
      contentHash: page.contentHash,
      updatedAt: page.updatedAt,
    })),
    conflicts: [],
  };
}

function attachmentActions(
  local: LocalTreeScanV3,
  plan: AttachmentMergePlan,
  conflictIds: Set<string>,
): TreePullActionV3[] {
  const actions: TreePullActionV3[] = [];
  const localById = new Map(
    local.attachments.map((attachment) => [
      plan.identityAliases[attachment.attachmentId] ?? attachment.attachmentId,
      {
        ...attachment,
        attachmentId:
          plan.identityAliases[attachment.attachmentId] ??
          attachment.attachmentId,
      },
    ]),
  );
  for (const attachment of plan.attachments) {
    if (conflictIds.has(attachment.attachmentId)) continue;
    const before = localById.get(attachment.attachmentId);
    const source =
      plan.sourceByAttachmentId[attachment.attachmentId] ?? "remote";
    if (!before || pathKey(before.path) !== pathKey(attachment.path))
      actions.push({ kind: "create_attachment", attachment, source });
    else if (before.contentHash !== attachment.contentHash)
      actions.push({ kind: "write_attachment", attachment, source });
    if (before && pathKey(before.path) !== pathKey(attachment.path))
      actions.push({
        kind: "remove_attachment_path",
        attachmentId: attachment.attachmentId,
        path: before.path,
      });
  }
  for (const attachmentId of plan.detachedAttachmentIds)
    actions.push({ kind: "detach_attachment", attachmentId });
  return actions;
}

async function computePreviewV3<TTree extends TreeContentV3>(
  base: TTree,
  local: LocalTreeScanV3,
  remote: TTree,
  revision: string,
  pagePlan: PageMergePlan,
  folderConflictResolutions: Record<string, FolderConflictResolution>,
  pageConflictResolutions: Record<string, PageConflictResolution>,
  attachmentConflictResolutions: Record<string, AttachmentConflictResolution>,
): Promise<TreePullPreviewV3<TTree>> {
  const baseLegacy = legacyContent(base);
  const localLegacy = legacyScan(local);
  const remoteLegacy = legacyContent(remote);
  const appliedPagePlan = await resolvePagePlan(
    pagePlan,
    pageConflictResolutions,
    baseLegacy,
    localLegacy,
    remoteLegacy,
  );
  const legacy = computePreview(
    baseLegacy,
    localLegacy,
    remoteLegacy,
    revision,
    appliedPagePlan,
    folderConflictResolutions,
    pageConflictResolutions,
  );
  const sourcePages = attachmentReferencesByPage(
    legacy.resolvedPages,
    base,
    local,
    remote,
  );
  const attachmentInput = {
    base: base.attachments,
    local: local.attachments,
    remote: remote.attachments,
    affectedPageIdsByAttachment: affectedPagesByAttachment(sourcePages),
  };
  const attachmentPlan = mergeAttachmentsById({
    ...attachmentInput,
    resolutions: attachmentConflictResolutions,
  });
  const displayedAttachmentConflicts = new Map(
    [
      ...mergeAttachmentsById(attachmentInput).conflicts,
      ...attachmentPlan.conflicts,
    ].map((conflict) => [conflict.conflictId, conflict]),
  );
  const aliases = attachmentPlan.identityAliases;
  const sourceAttachments = [
    ...local.attachments,
    ...remote.attachments,
    ...base.attachments,
  ].map((attachment) => ({
    ...attachment,
    attachmentId: aliases[attachment.attachmentId] ?? attachment.attachmentId,
  }));
  const conflictedPages = new Set(
    legacy.pageConflicts.map((conflict) => conflict.pageId),
  );
  const attachmentConflictIds = new Set(
    attachmentPlan.conflicts.map((conflict) => conflict.attachmentId),
  );
  const rewriteBlockers: AttachmentRewriteBlocker[] = [];
  const resolvedPages: TreePageV3[] = [];
  for (const page of legacy.resolvedPages) {
    const source = sourcePages.get(page.pageId);
    const sourceIds = (source?.referencedAttachmentIds ?? []).map(
      (id) => aliases[id] ?? id,
    );
    const candidate: TreePageV3 = {
      ...page,
      referencedAttachmentIds: [...new Set(sourceIds)].sort(),
    };
    if (!source || conflictedPages.has(page.pageId)) {
      resolvedPages.push(candidate);
      continue;
    }
    if (
      candidate.referencedAttachmentIds.some((id) =>
        attachmentConflictIds.has(id),
      )
    ) {
      resolvedPages.push(candidate);
      continue;
    }
    const rewritten = await rewriteAttachmentPageReferences({
      page: candidate,
      sourcePath: source.path,
      sourceAttachments,
      finalPath: page.path,
      finalAttachments: attachmentPlan.attachments,
      redirects: attachmentPlan.pageAttachmentRedirects[page.pageId] ?? {},
    });
    rewriteBlockers.push(...rewritten.blockers);
    resolvedPages.push(rewritten.page);
  }

  const rewrittenLegacy = computePreview(
    baseLegacy,
    localLegacy,
    remoteLegacy,
    revision,
    resolvedPagePlan(resolvedPages),
    folderConflictResolutions,
    {},
  );
  const unresolvedPageIds = new Set(
    legacy.pageConflicts.map((item) => item.pageId),
  );
  if (
    local.blockers.length === 0 &&
    rewriteBlockers.length === 0 &&
    legacy.folderConflicts.length === 0 &&
    legacy.pageConflicts.length === 0 &&
    attachmentPlan.conflicts.length === 0
  )
    validateTreeContentV3({
      protocolVersion: "3",
      spaceId: remote.spaceId,
      folders: legacy.resolvedFolders,
      pages: resolvedPages,
      attachments: attachmentPlan.attachments,
    });
  const localPages = new Map(local.pages.map((page) => [page.pageId, page]));
  const finalPages = new Map(resolvedPages.map((page) => [page.pageId, page]));
  const legacyActions = rewrittenLegacy.actions.filter((action) => {
    if (
      action.kind === "create_page" ||
      action.kind === "write_page" ||
      action.kind === "move_page" ||
      action.kind === "trash_page"
    ) {
      if (unresolvedPageIds.has(action.pageId)) return false;
      if (action.kind !== "trash_page") {
        const localPage = localPages.get(action.pageId);
        const finalPage = finalPages.get(action.pageId);
        if (
          localPage &&
          finalPage &&
          localPage.path === finalPage.path &&
          localPage.contentHash === finalPage.contentHash
        )
          return false;
      }
    }
    return true;
  });
  const attachment = attachmentActions(
    local,
    attachmentPlan,
    attachmentConflictIds,
  );
  return {
    revision,
    actions: retainNormalizedPageWrites({
      actions: [...attachment, ...legacyActions],
      finalPages: resolvedPages.filter(
        (page) => !unresolvedPageIds.has(page.pageId),
      ),
      normalizations: local.normalizations ?? [],
      rawPathStates: local.rawPathStates,
    }),
    blockers: [...local.blockers, ...rewriteBlockers],
    attachmentConflicts: [...displayedAttachmentConflicts.values()].sort(
      (left, right) => left.conflictId.localeCompare(right.conflictId),
    ),
    attachmentConflictResolutions,
    folderConflicts: legacy.folderConflicts,
    folderConflictResolutions,
    pageConflicts: pagePlan.conflicts,
    pageConflictResolutions,
    base,
    local,
    remote,
    pagePlan,
    attachmentPlan,
    resolvedFolders: legacy.resolvedFolders,
    resolvedPages,
    resolvedAttachments: attachmentPlan.attachments,
  };
}

export async function buildTreePullPreviewV3(
  base: TreeSnapshotV3,
  local: LocalTreeScanV3,
  remote: TreeSnapshotV3,
): Promise<TreePullPreviewV3> {
  const pagePlan = await mergePagesById(base.pages, local.pages, remote.pages);
  return computePreviewV3(
    base,
    local,
    remote,
    remote.revision,
    pagePlan,
    {},
    {},
    {},
  );
}

export async function buildTreeCalculationPreviewV3<
  TTree extends TreeContentV3,
>(
  base: TTree,
  local: LocalTreeScanV3,
  remote: TTree,
  revision: string,
): Promise<TreePullPreviewV3<TTree>> {
  const validatedBase = validateTreeContentV3(base) as TTree;
  const validatedRemote = validateTreeContentV3(remote) as TTree;
  const pagePlan = await mergePagesById(
    validatedBase.pages,
    local.pages,
    validatedRemote.pages,
  );
  return computePreviewV3(
    validatedBase,
    local,
    validatedRemote,
    revision,
    pagePlan,
    {},
    {},
    {},
  );
}

export async function rebuildTreeCalculationPreviewV3<
  TTree extends TreeContentV3,
>(preview: TreePullPreviewV3<TTree>): Promise<TreePullPreviewV3<TTree>> {
  const rebuilt = await buildTreeCalculationPreviewV3(
    preview.base,
    preview.local,
    preview.remote,
    preview.revision,
  );
  for (const [conflictId, resolution] of Object.entries(
    preview.folderConflictResolutions,
  ).sort(([left], [right]) => left.localeCompare(right)))
    await resolveFolderConflictV3(rebuilt, conflictId, resolution);
  for (const [conflictId, resolution] of Object.entries(
    preview.pageConflictResolutions,
  ).sort(([left], [right]) => left.localeCompare(right)))
    await resolvePageConflictV3(rebuilt, conflictId, resolution);
  for (const [conflictId, resolution] of Object.entries(
    preview.attachmentConflictResolutions,
  ).sort(([left], [right]) => left.localeCompare(right)))
    await resolveAttachmentConflict(rebuilt, conflictId, resolution);
  return rebuilt;
}

export async function resolveAttachmentConflict<TTree extends TreeContentV3>(
  preview: TreePullPreviewV3<TTree>,
  conflictId: string,
  resolution: AttachmentConflictResolution,
): Promise<void> {
  const conflict = preview.attachmentConflicts.find(
    (item) => item.conflictId === conflictId,
  );
  if (!conflict)
    throw new TypeError(
      "ATTACHMENT_CONFLICT_NOT_FOUND: Attachment conflict does not exist",
    );
  const resolutions = {
    ...preview.attachmentConflictResolutions,
    [conflictId]: resolution,
  };
  const next = await computePreviewV3(
    preview.base,
    preview.local,
    preview.remote,
    preview.revision,
    preview.pagePlan,
    preview.folderConflictResolutions,
    preview.pageConflictResolutions,
    resolutions,
  );
  preview.actions = next.actions;
  preview.blockers = next.blockers;
  preview.attachmentConflicts = next.attachmentConflicts;
  preview.attachmentConflictResolutions = resolutions;
  preview.folderConflicts = next.folderConflicts;
  preview.pageConflicts = next.pageConflicts;
  preview.resolvedFolders = next.resolvedFolders;
  preview.resolvedPages = next.resolvedPages;
  preview.resolvedAttachments = next.resolvedAttachments;
  preview.attachmentPlan = next.attachmentPlan;
}

function applyPreviewV3<TTree extends TreeContentV3>(
  preview: TreePullPreviewV3<TTree>,
  next: TreePullPreviewV3<TTree>,
): void {
  preview.actions = next.actions;
  preview.blockers = next.blockers;
  preview.attachmentConflicts = next.attachmentConflicts;
  preview.attachmentConflictResolutions = next.attachmentConflictResolutions;
  preview.folderConflicts = next.folderConflicts;
  preview.folderConflictResolutions = next.folderConflictResolutions;
  preview.pageConflicts = next.pageConflicts;
  preview.pageConflictResolutions = next.pageConflictResolutions;
  preview.pagePlan = next.pagePlan;
  preview.attachmentPlan = next.attachmentPlan;
  preview.resolvedFolders = next.resolvedFolders;
  preview.resolvedPages = next.resolvedPages;
  preview.resolvedAttachments = next.resolvedAttachments;
}

export async function resolvePageConflictV3<TTree extends TreeContentV3>(
  preview: TreePullPreviewV3<TTree>,
  conflictId: string,
  resolution: PageConflictResolution,
): Promise<void> {
  if (!preview.pageConflicts.some((item) => item.conflictId === conflictId))
    throw new TypeError("PAGE_CONFLICT_NOT_FOUND: 页面冲突不存在");
  const resolutions = {
    ...preview.pageConflictResolutions,
    [conflictId]: resolution,
  };
  const next = await computePreviewV3(
    preview.base,
    preview.local,
    preview.remote,
    preview.revision,
    preview.pagePlan,
    preview.folderConflictResolutions,
    resolutions,
    preview.attachmentConflictResolutions,
  );
  applyPreviewV3(preview, next);
}

export async function resolveFolderConflictV3<TTree extends TreeContentV3>(
  preview: TreePullPreviewV3<TTree>,
  conflictId: string,
  resolution: FolderConflictResolution,
): Promise<void> {
  const legacy = computePreview(
    legacyContent(preview.base),
    legacyScan(preview.local),
    legacyContent(preview.remote),
    preview.revision,
    preview.pagePlan,
    preview.folderConflictResolutions,
    preview.pageConflictResolutions,
  );
  resolveFolderConflict(legacy, conflictId, resolution);
  const next = await computePreviewV3(
    preview.base,
    preview.local,
    preview.remote,
    preview.revision,
    preview.pagePlan,
    legacy.folderConflictResolutions,
    preview.pageConflictResolutions,
    preview.attachmentConflictResolutions,
  );
  applyPreviewV3(preview, next);
}

export async function resolvePageConflict(
  preview: TreePullPreview,
  conflictId: string,
  resolution: PageConflictResolution,
): Promise<void> {
  const conflict = preview.pageConflicts.find(
    (item) => item.conflictId === conflictId,
  );
  if (!conflict) throw new TypeError("PAGE_CONFLICT_NOT_FOUND: 页面冲突不存在");
  const nextResolutions = {
    ...preview.pageConflictResolutions,
    [conflictId]: resolution,
  };
  const pagePlan = await resolvePagePlan(
    preview.pagePlan,
    nextResolutions,
    preview.base,
    preview.local,
    preview.remote,
  );
  const next = computePreview(
    preview.base,
    preview.local,
    preview.remote,
    preview.revision,
    pagePlan,
    preview.folderConflictResolutions,
    nextResolutions,
  );
  preview.pageConflictResolutions = nextResolutions;
  preview.actions = next.actions;
  preview.pageConflicts = next.pageConflicts;
  preview.folderConflicts = next.folderConflicts;
  preview.folderConflictResolutions = next.folderConflictResolutions;
  preview.resolvedFolders = next.resolvedFolders;
  preview.resolvedPages = next.resolvedPages;
  preview.pagePlan = pagePlan;
}

export function resolveFolderConflict(
  preview: TreePullPreview<TreeContentV2>,
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
    preview.revision,
    preview.pagePlan,
    nextResolutions,
    preview.pageConflictResolutions,
  );
  preview.folderConflictResolutions = nextResolutions;
  preview.actions = next.actions;
  preview.folderConflicts = next.folderConflicts;
  preview.pageConflicts = next.pageConflicts;
  preview.resolvedFolders = next.resolvedFolders;
  preview.resolvedPages = next.resolvedPages;
}

export function pendingTreeDecisionCount(
  preview: TreePullPreview<TreeContentV2> | TreePullPreviewV3<TreeContentV3>,
): number {
  const unresolvedFolders = preview.folderConflicts.filter(
    (conflict) => !preview.folderConflictResolutions[conflict.conflictId],
  ).length;
  const unresolvedPages = preview.pageConflicts.filter(
    (conflict) => !preview.pageConflictResolutions[conflict.conflictId],
  ).length;
  if (!("attachmentConflicts" in preview))
    return unresolvedFolders + unresolvedPages;
  const unresolvedAttachments = preview.attachmentConflicts.filter(
    (conflict) => !preview.attachmentConflictResolutions[conflict.conflictId],
  ).length;
  return (
    unresolvedFolders +
    unresolvedPages +
    unresolvedAttachments +
    preview.blockers.length
  );
}
