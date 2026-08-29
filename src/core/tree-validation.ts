import {
  pathKey,
  validatePortableDirectoryPath,
  validatePortableMarkdownPath,
} from "@neomei/agentwiki-sync-protocol";

import type {
  TreeFolder,
  TreePage,
  TreePushChange,
  TreeSnapshot,
} from "./tree-model";

function assertManagedRoot(
  folders: TreeFolder[],
  pages: TreePage[],
  root: string,
): void {
  for (const folder of folders)
    if (!folder.path.startsWith(root))
      throw new TypeError(`Folder path must be under ${root}`);
  for (const page of pages)
    if (!page.path.startsWith(root))
      throw new TypeError(`Page path must be under ${root}`);
}

function assertUniqueIdsAndPathKeys(
  folders: TreeFolder[],
  pages: TreePage[],
): void {
  const folderIds = new Set<string>();
  for (const folder of folders) {
    if (folderIds.has(folder.folderId))
      throw new TypeError(`DUPLICATE_FOLDER_ID: ${folder.folderId}`);
    folderIds.add(folder.folderId);
  }

  const pageIds = new Set<string>();
  for (const page of pages) {
    if (pageIds.has(page.pageId))
      throw new TypeError(`DUPLICATE_PAGE_ID: ${page.pageId}`);
    pageIds.add(page.pageId);
  }

  const pathKeys = new Set<string>();
  for (const entry of [...folders, ...pages]) {
    const key = pathKey(entry.path);
    if (pathKeys.has(key))
      throw new TypeError(
        `PATH_COLLISION: multiple entries map to ${entry.path}`,
      );
    pathKeys.add(key);
  }
}

function assertParentsAndNoCycles(
  folders: TreeFolder[],
  pages: TreePage[],
): void {
  const byId = new Map(folders.map((folder) => [folder.folderId, folder]));

  for (const folder of folders) {
    if (folder.parentFolderId !== null && !byId.has(folder.parentFolderId))
      throw new TypeError(
        `UNKNOWN_PARENT: folder ${folder.folderId} references ${folder.parentFolderId}`,
      );
  }

  for (const page of pages) {
    if (page.folderId !== null && !byId.has(page.folderId))
      throw new TypeError(
        `UNKNOWN_PARENT: page ${page.pageId} references ${page.folderId}`,
      );
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (folderId: string): void => {
    if (visiting.has(folderId))
      throw new TypeError("Folder hierarchy contains a cycle");
    if (visited.has(folderId)) return;
    const folder = byId.get(folderId);
    if (!folder) return;
    visiting.add(folderId);
    if (folder.parentFolderId !== null) visit(folder.parentFolderId);
    visiting.delete(folderId);
    visited.add(folderId);
  };
  for (const folder of folders) visit(folder.folderId);
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (char) => char.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (char) => char.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index] ?? 0;
    const rightPoint = rightPoints[index] ?? 0;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}

function changeRank(change: TreePushChange): number {
  switch (change.operation) {
    case "archive_page":
      return 0;
    case "archive_folder":
      return 1;
    case "upsert_folder":
      return 2;
    case "upsert_page":
      return 3;
  }
}

function changePath(change: TreePushChange): string {
  switch (change.operation) {
    case "upsert_folder":
      return change.folder.path;
    case "archive_folder":
      return change.previousPath;
    case "upsert_page":
      return change.page.path;
    case "archive_page":
      return change.previousPath;
  }
}

function changeId(change: TreePushChange): string {
  switch (change.operation) {
    case "upsert_folder":
      return change.folder.folderId;
    case "archive_folder":
      return change.folderId;
    case "upsert_page":
      return change.page.pageId;
    case "archive_page":
      return change.pageId;
  }
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function compareTreeChanges(
  left: TreePushChange,
  right: TreePushChange,
): number {
  const rankDelta = changeRank(left) - changeRank(right);
  if (rankDelta !== 0) return rankDelta;

  const isFolderOperation =
    left.operation === "archive_folder" || left.operation === "upsert_folder";
  if (isFolderOperation) {
    const childFirst = left.operation === "archive_folder";
    const depthDelta =
      pathDepth(changePath(left)) - pathDepth(changePath(right));
    if (depthDelta !== 0) return childFirst ? -depthDelta : depthDelta;
  }

  const keyDelta = compareCodePoints(
    pathKey(changePath(left)),
    pathKey(changePath(right)),
  );
  if (keyDelta !== 0) return keyDelta;

  const idDelta = compareCodePoints(changeId(left), changeId(right));
  if (idDelta !== 0) return idDelta;

  return compareCodePoints(left.operation, right.operation);
}

export function validateTreeSnapshot(input: TreeSnapshot): TreeSnapshot {
  const protocolVersion: string = input.protocolVersion;
  if (protocolVersion !== "1" && protocolVersion !== "2")
    throw new TypeError(`Unknown protocol version: ${protocolVersion}`);

  const folders = input.folders.map((folder) => ({
    ...folder,
    path: validatePortableDirectoryPath(folder.path).path,
  }));
  const pages = input.pages.map((page) => ({
    ...page,
    // v1 legacy pages and v2 pages share the markdown-path validator; the
    // published validatePortablePath is a deprecated alias of it.
    path: validatePortableMarkdownPath(page.path).path,
  }));

  if (protocolVersion === "2") assertManagedRoot(folders, pages, "pages/");
  else if (folders.length > 0)
    throw new TypeError("Sync v1 cannot contain folders");

  assertUniqueIdsAndPathKeys(folders, pages);
  assertParentsAndNoCycles(folders, pages);
  return { ...input, folders, pages };
}

export function sortTreeChanges<T extends TreePushChange>(changes: T[]): T[] {
  return [...changes].sort(compareTreeChanges);
}
