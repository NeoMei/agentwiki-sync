import { diff3Merge } from "node-diff3";
import { contentHash, sha256Hex } from "../agentwiki/protocol";
import type { TreeAttachment, TreeFolder, TreePage } from "./tree-model";

export type {
  AttachmentConflict,
  AttachmentConflictResolution,
  AttachmentMergeClassification,
  AttachmentMergePlan,
} from "./attachment-merge";

export interface StructuredConflict {
  conflictId: string;
  pageId: string;
  field: "path" | "title" | "body" | "archive" | "delete";
  base: string;
  local: string;
  remote: string;
  wholeDocument: boolean;
}

export function mergeField<T>(
  base: T,
  local: T,
  remote: T,
): { value: T; conflict: boolean } {
  if (Object.is(local, remote)) return { value: local, conflict: false };
  if (Object.is(local, base)) return { value: remote, conflict: false };
  if (Object.is(remote, base)) return { value: local, conflict: false };
  return { value: local, conflict: true };
}

function lineCount(text: string): number {
  let count = 1;
  for (let index = 0; index < text.length; index += 1)
    if (text.charCodeAt(index) === 10) count += 1;
  return count;
}

async function conflict(
  pageId: string,
  base: string,
  local: string,
  remote: string,
  wholeDocument: boolean,
): Promise<StructuredConflict> {
  const conflictId = await sha256Hex(
    new TextEncoder().encode(`${pageId}\0${base}\0${local}\0${remote}`),
  );
  return {
    conflictId,
    pageId,
    field: "body",
    base,
    local,
    remote,
    wholeDocument,
  };
}

export async function mergeBody(
  base: string,
  local: string,
  remote: string,
  pageId: string,
): Promise<{ body: string; conflicts: StructuredConflict[] }> {
  const direct = mergeField(base, local, remote);
  if (!direct.conflict) return { body: direct.value, conflicts: [] };
  if (local.startsWith(remote) && remote.startsWith(base))
    return { body: local, conflicts: [] };
  if (remote.startsWith(local) && local.startsWith(base))
    return { body: remote, conflicts: [] };
  if ([base, local, remote].some((text) => lineCount(text) > 10_000))
    return {
      body: local,
      conflicts: [await conflict(pageId, base, local, remote, true)],
    };
  const baseLines = base.split("\n");
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");
  const regions = diff3Merge(localLines, baseLines, remoteLines, {
    excludeFalseConflicts: true,
  });
  const localOutput: string[] = [];
  const remoteOutput: string[] = [];
  let hasConflict = false;
  for (const region of regions) {
    if (region.ok) {
      localOutput.push(...region.ok);
      remoteOutput.push(...region.ok);
    } else if (region.conflict) {
      hasConflict = true;
      localOutput.push(...region.conflict.a);
      remoteOutput.push(...region.conflict.b);
    }
  }
  const localBody = localOutput.join("\n");
  if (!hasConflict) return { body: localBody, conflicts: [] };
  const remoteBody = remoteOutput.join("\n");
  if (localBody.startsWith(remoteBody) && remoteBody.startsWith(base))
    return { body: localBody, conflicts: [] };
  if (remoteBody.startsWith(localBody) && localBody.startsWith(base))
    return { body: remoteBody, conflicts: [] };
  return {
    body: localBody,
    conflicts: [await conflict(pageId, base, localBody, remoteBody, true)],
  };
}

/**
 * A structured conflict for a single Folder. `*Path` fields carry the folder's
 * absolute path (null when the folder is absent in that side) while
 * `*ParentPath` carry its parent folder path (null when top-level or absent).
 * Presence divergences (delete-vs-modify, modify-vs-delete, create-vs-create)
 * are represented by a null path on the absent side.
 */
export interface FolderConflict {
  conflictId: string;
  objectType: "folder";
  folderId: string;
  baseParentPath: string | null;
  localParentPath: string | null;
  remoteParentPath: string | null;
  basePath: string | null;
  localPath: string | null;
  remotePath: string | null;
}

export interface FolderConflictResolution {
  choice: "local" | "remote" | "manual";
  manualPath?: string;
}

/** The pull-side operation surface consumed by the tree transaction layer. */
export type TreePullAction =
  | { kind: "create_directory"; folderId: string; path: string }
  | {
      kind: "move_directory";
      folderId: string;
      fromPath: string;
      path: string;
      beforePath?: string;
    }
  | { kind: "trash_directory"; folderId: string; path: string }
  | {
      kind: "create_page";
      pageId: string;
      path: string;
      bodyPath: string;
    }
  | {
      kind: "write_page";
      pageId: string;
      path: string;
      bodyPath: string;
      beforePath?: string;
    }
  | {
      kind: "move_page";
      pageId: string;
      fromPath: string;
      path: string;
      bodyPath: string;
      beforePath?: string;
    }
  | { kind: "trash_page"; pageId: string; path: string };

/**
 * Attachment actions are intentionally separate from the legacy transaction
 * union. Task 16/17 own the journaled runtime consumer for this v3 surface.
 */
export type AttachmentPullAction =
  | {
      kind: "create_attachment";
      attachment: TreeAttachment;
      source: "base" | "local" | "remote";
    }
  | {
      kind: "write_attachment";
      attachment: TreeAttachment;
      source: "base" | "local" | "remote";
    }
  | {
      kind: "remove_attachment_path";
      attachmentId: string;
      path: string;
    }
  | { kind: "detach_attachment"; attachmentId: string };

export type TreePullActionV3 = TreePullAction | AttachmentPullAction;

export interface ResolvedFolderLocation {
  folderId: string;
  parentFolderId: string | null;
  name: string;
  sortOrder: number;
  updatedAt: string;
  /** When set, the folder's final path is fixed by a manual resolution. */
  manualPath?: string;
}

export interface ResolvedPageLocation {
  pageId: string;
  folderId: string | null;
  filename: string;
  title: string;
  body: string;
  contentHash: string;
  updatedAt: string;
}

export interface DeletedFolderInfo {
  folderId: string;
  basePath: string | null;
  localPath: string | null;
  remotePath: string | null;
  baseParentPath: string | null;
  localParentPath: string | null;
  remoteParentPath: string | null;
  local: ResolvedFolderLocation | null;
}

export interface FolderMergePlan {
  resolved: ResolvedFolderLocation[];
  deleted: DeletedFolderInfo[];
  conflicts: FolderConflict[];
}

export interface PageMergePlan {
  resolved: ResolvedPageLocation[];
  conflicts: StructuredConflict[];
}

interface FolderLocation {
  parentFolderId: string | null;
  name: string;
}

interface PageLocation {
  folderId: string | null;
  filename: string;
}

function folderLocation(folder: TreeFolder): FolderLocation {
  return { parentFolderId: folder.parentFolderId, name: folder.name };
}

function pageLocation(page: TreePage): PageLocation {
  const segments = page.path.split("/");
  return { folderId: page.folderId, filename: segments.at(-1) ?? "" };
}

function folderLocationEquals(
  left: FolderLocation,
  right: FolderLocation,
): boolean {
  return (
    left.parentFolderId === right.parentFolderId && left.name === right.name
  );
}

function pageLocationEquals(left: PageLocation, right: PageLocation): boolean {
  return left.folderId === right.folderId && left.filename === right.filename;
}

function mergeLocation<T>(
  base: T | null,
  local: T | null,
  remote: T | null,
  equals: (left: T, right: T) => boolean,
): { value: T | null; conflict: boolean } {
  const same = (left: T | null, right: T | null): boolean =>
    (left === null && right === null) ||
    (left !== null && right !== null && equals(left, right));
  if (same(local, remote)) return { value: local, conflict: false };
  if (same(local, base)) return { value: remote, conflict: false };
  if (same(remote, base)) return { value: local, conflict: false };
  return { value: local, conflict: true };
}

function folderParentPath(folder: TreeFolder): string | null {
  if (folder.parentFolderId === null) return null;
  const slash = folder.path.lastIndexOf("/");
  return slash > 0 ? folder.path.slice(0, slash) : null;
}

function localFolderLocation(
  id: string,
  folder: TreeFolder,
): ResolvedFolderLocation {
  return {
    folderId: id,
    parentFolderId: folder.parentFolderId,
    name: folder.name,
    sortOrder: folder.sortOrder,
    updatedAt: folder.updatedAt,
  };
}

function applyFolderResolution(
  localFolder: TreeFolder | undefined,
  remoteFolder: TreeFolder | undefined,
  resolution: FolderConflictResolution,
): { location: FolderLocation | null; manualPath?: string } {
  if (resolution.choice === "local")
    return { location: localFolder ? folderLocation(localFolder) : null };
  if (resolution.choice === "remote")
    return { location: remoteFolder ? folderLocation(remoteFolder) : null };
  const path = resolution.manualPath ?? "";
  const name = path.split("/").at(-1) ?? "";
  return { location: { parentFolderId: null, name }, manualPath: path };
}

/**
 * ID-first three-way comparison of folders. Each folder's stable identity is
 * its `folderId`; its location is `(parentFolderId, name)`. Comparing the
 * parent reference (instead of the absolute path) keeps a subtree from being
 * misread as independent moves when only the ancestor folder moved.
 */
export function mergeFoldersById(
  base: TreeFolder[],
  local: TreeFolder[],
  remote: TreeFolder[],
  resolutions?: ReadonlyMap<string, FolderConflictResolution>,
): FolderMergePlan {
  const byBase = new Map(base.map((item) => [item.folderId, item]));
  const byLocal = new Map(local.map((item) => [item.folderId, item]));
  const byRemote = new Map(remote.map((item) => [item.folderId, item]));
  const ids = new Set([
    ...byBase.keys(),
    ...byLocal.keys(),
    ...byRemote.keys(),
  ]);

  const resolved: ResolvedFolderLocation[] = [];
  const deleted: DeletedFolderInfo[] = [];
  const conflicts: FolderConflict[] = [];

  for (const id of ids) {
    const baseFolder = byBase.get(id);
    const localFolder = byLocal.get(id);
    const remoteFolder = byRemote.get(id);
    const merged = mergeLocation(
      baseFolder ? folderLocation(baseFolder) : null,
      localFolder ? folderLocation(localFolder) : null,
      remoteFolder ? folderLocation(remoteFolder) : null,
      folderLocationEquals,
    );

    let location = merged.value;
    let conflict = merged.conflict;
    let manualPath: string | undefined;
    if (merged.conflict && resolutions?.has(id)) {
      const applied = applyFolderResolution(
        localFolder,
        remoteFolder,
        resolutions.get(id)!,
      );
      location = applied.location;
      manualPath = applied.manualPath;
      conflict = false;
    }

    if (conflict) {
      conflicts.push({
        conflictId: `folder:${id}`,
        objectType: "folder",
        folderId: id,
        baseParentPath: baseFolder ? folderParentPath(baseFolder) : null,
        localParentPath: localFolder ? folderParentPath(localFolder) : null,
        remoteParentPath: remoteFolder ? folderParentPath(remoteFolder) : null,
        basePath: baseFolder?.path ?? null,
        localPath: localFolder?.path ?? null,
        remotePath: remoteFolder?.path ?? null,
      });
    }

    if (location === null) {
      if (localFolder)
        deleted.push({
          folderId: id,
          basePath: baseFolder?.path ?? null,
          localPath: localFolder.path,
          remotePath: remoteFolder?.path ?? null,
          baseParentPath: baseFolder ? folderParentPath(baseFolder) : null,
          localParentPath: folderParentPath(localFolder),
          remoteParentPath: remoteFolder
            ? folderParentPath(remoteFolder)
            : null,
          local: localFolderLocation(id, localFolder),
        });
      continue;
    }

    const source = localFolder ?? remoteFolder ?? baseFolder;
    const item: ResolvedFolderLocation = {
      folderId: id,
      parentFolderId: location.parentFolderId,
      name: location.name,
      sortOrder: source?.sortOrder ?? 0,
      updatedAt: source?.updatedAt ?? "",
    };
    if (manualPath !== undefined) item.manualPath = manualPath;
    resolved.push(item);
  }

  return { resolved, deleted, conflicts };
}

/**
 * ID-first three-way comparison of pages. Location is `(folderId, filename)`
 * and body/title are merged independently, mirroring the v1 page semantics.
 */
export async function mergePagesById(
  base: TreePage[],
  local: TreePage[],
  remote: TreePage[],
): Promise<PageMergePlan> {
  const byBase = new Map(base.map((item) => [item.pageId, item]));
  const byLocal = new Map(local.map((item) => [item.pageId, item]));
  const byRemote = new Map(remote.map((item) => [item.pageId, item]));
  const ids = new Set([
    ...byBase.keys(),
    ...byLocal.keys(),
    ...byRemote.keys(),
  ]);

  const locations = new Map<string, PageLocation | null>();
  const conflicts: StructuredConflict[] = [];

  for (const id of ids) {
    const basePage = byBase.get(id);
    const localPage = byLocal.get(id);
    const remotePage = byRemote.get(id);
    const merged = mergeLocation(
      basePage ? pageLocation(basePage) : null,
      localPage ? pageLocation(localPage) : null,
      remotePage ? pageLocation(remotePage) : null,
      pageLocationEquals,
    );
    locations.set(id, merged.value);

    if (merged.conflict && basePage && localPage && remotePage) {
      conflicts.push({
        conflictId: `path:${id}`,
        pageId: id,
        field: "path",
        base: basePage.path,
        local: localPage.path,
        remote: remotePage.path,
        wholeDocument: true,
      });
    }

    if (basePage && localPage && remotePage) {
      const titleMerge = mergeField(
        basePage.title,
        localPage.title,
        remotePage.title,
      );
      if (titleMerge.conflict)
        conflicts.push({
          conflictId: `title:${id}`,
          pageId: id,
          field: "title",
          base: basePage.title,
          local: localPage.title,
          remote: remotePage.title,
          wholeDocument: false,
        });
      const bodyMerge = await mergeBody(
        basePage.body,
        localPage.body,
        remotePage.body,
        id,
      );
      conflicts.push(...bodyMerge.conflicts);
    } else if (basePage && localPage && !remotePage) {
      const localChanged =
        localPage.body !== basePage.body ||
        localPage.title !== basePage.title ||
        !pageLocationEquals(pageLocation(localPage), pageLocation(basePage));
      if (localChanged)
        conflicts.push({
          conflictId: `archive:${id}`,
          pageId: id,
          field: "archive",
          base: basePage.body,
          local: localPage.body,
          remote: "",
          wholeDocument: true,
        });
    } else if (basePage && remotePage && !localPage) {
      const remoteChanged =
        remotePage.body !== basePage.body ||
        remotePage.title !== basePage.title ||
        !pageLocationEquals(pageLocation(remotePage), pageLocation(basePage));
      if (remoteChanged)
        conflicts.push({
          conflictId: `delete:${id}`,
          pageId: id,
          field: "delete",
          base: basePage.body,
          local: "",
          remote: remotePage.body,
          wholeDocument: true,
        });
    } else if (!basePage && localPage && remotePage) {
      // Both sides independently created the same page id. A location
      // divergence is a path conflict; otherwise title/body may still diverge.
      if (merged.conflict)
        conflicts.push({
          conflictId: `path:${id}`,
          pageId: id,
          field: "path",
          base: "",
          local: localPage.path,
          remote: remotePage.path,
          wholeDocument: true,
        });
      else {
        if (localPage.title !== remotePage.title)
          conflicts.push({
            conflictId: `title:${id}`,
            pageId: id,
            field: "title",
            base: "",
            local: localPage.title,
            remote: remotePage.title,
            wholeDocument: false,
          });
        if (localPage.body !== remotePage.body)
          conflicts.push({
            conflictId: `body:${id}`,
            pageId: id,
            field: "body",
            base: "",
            local: localPage.body,
            remote: remotePage.body,
            wholeDocument: true,
          });
      }
    }
  }

  const resolved: ResolvedPageLocation[] = [];
  for (const id of ids) {
    const loc = locations.get(id);
    if (loc === null || loc === undefined) continue;
    const basePage = byBase.get(id);
    const localPage = byLocal.get(id);
    const remotePage = byRemote.get(id);

    let body = "";
    if (basePage && localPage && remotePage) {
      body = (
        await mergeBody(basePage.body, localPage.body, remotePage.body, id)
      ).body;
    } else {
      body = remotePage?.body ?? localPage?.body ?? basePage?.body ?? "";
    }

    const title =
      basePage && localPage && remotePage
        ? mergeField(basePage.title, localPage.title, remotePage.title).value
        : (remotePage?.title ?? localPage?.title ?? basePage?.title ?? "");

    resolved.push({
      pageId: id,
      folderId: loc.folderId,
      filename: loc.filename,
      title,
      body,
      contentHash: await contentHash(body),
      updatedAt:
        localPage?.updatedAt ??
        remotePage?.updatedAt ??
        basePage?.updatedAt ??
        "",
    });
  }

  return { resolved, conflicts };
}
