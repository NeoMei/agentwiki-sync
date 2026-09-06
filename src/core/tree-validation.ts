import {
  FlatAttachmentPathSchema,
  pathKey,
  validatePortableDirectoryPath,
  validatePortableMarkdownPath,
} from "@neomei/agentwiki-sync-protocol";

import type {
  TreeAttachment,
  TreeFolder,
  TreePage,
  TreePageV3,
  TreePushChange,
  TreeSnapshot,
  TreeSnapshotV3,
} from "./tree-model";
import { parseAttachmentReferences } from "./attachment-reference";

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
  const content = validateTreeContent(input);
  return { ...input, folders: content.folders, pages: content.pages };
}

type TreeContent = Pick<
  TreeSnapshot,
  "protocolVersion" | "spaceId" | "folders" | "pages"
>;

function validateTreeContent(input: TreeContent): TreeContent {
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

function validateAttachmentReferences(
  pages: TreePageV3[],
  attachments: TreeAttachment[],
): void {
  const attachmentIds = new Set(attachments.map((item) => item.attachmentId));
  const referenced = new Set<string>();
  const idByPath = new Map(
    attachments.map((item) => [pathKey(item.path), item.attachmentId]),
  );
  for (const page of pages) {
    const declared = page.referencedAttachmentIds;
    if (
      declared.some((id, index) =>
        index === 0
          ? !attachmentIds.has(id)
          : !attachmentIds.has(id) || declared[index - 1]! >= id,
      )
    )
      throw new TypeError(
        `ATTACHMENT_REFERENCES_INVALID: Page ${page.pageId} manifest`,
      );
    const parsed = new Set<string>();
    for (const reference of parseAttachmentReferences(page.body, page.path)) {
      if (reference.classification === "invalid")
        throw new TypeError(
          `ATTACHMENT_REFERENCES_INVALID: Page ${page.pageId} contains an invalid local image reference`,
        );
      if (
        reference.classification !== "local" &&
        reference.classification !== "legacy"
      )
        continue;
      const resolved =
        reference.classification === "legacy"
          ? `assets/${reference.target}`
          : reference.resolvedPath!;
      const id = idByPath.get(pathKey(resolved));
      if (!id)
        throw new TypeError(
          `ATTACHMENT_REFERENCES_INVALID: Page ${page.pageId} references a missing managed attachment`,
        );
      parsed.add(id);
    }
    const parsedIds = [...parsed].sort();
    if (
      parsedIds.length !== declared.length ||
      parsedIds.some((id, index) => id !== declared[index])
    )
      throw new TypeError(
        `ATTACHMENT_REFERENCES_INVALID: Page ${page.pageId} Markdown mismatch`,
      );
    for (const id of declared) referenced.add(id);
  }
  if (attachments.some((item) => !referenced.has(item.attachmentId)))
    throw new TypeError(
      "ATTACHMENT_REFERENCES_INVALID: unreferenced attachment",
    );
}

export function validateTreeSnapshotV3(input: TreeSnapshotV3): TreeSnapshotV3 {
  const content = validateTreeContentV3(input);
  return {
    ...input,
    folders: content.folders,
    pages: content.pages,
    attachments: content.attachments,
  };
}

export type TreeContentV3 = Pick<
  TreeSnapshotV3,
  "protocolVersion" | "spaceId" | "folders" | "pages" | "attachments"
>;

export function validateTreeContentV3(input: TreeContentV3): TreeContentV3 {
  if (input.protocolVersion !== "3")
    throw new TypeError(
      `Unknown protocol version: ${String(input.protocolVersion)}`,
    );
  const legacy = validateTreeContent({
    protocolVersion: "2",
    spaceId: input.spaceId,
    folders: input.folders,
    pages: input.pages,
  });
  const attachmentIds = new Set<string>();
  const attachmentPathKeys = new Set<string>();
  const attachments = input.attachments.map((attachment) => {
    if (attachmentIds.has(attachment.attachmentId))
      throw new TypeError(
        `DUPLICATE_ATTACHMENT_ID: ${attachment.attachmentId}`,
      );
    attachmentIds.add(attachment.attachmentId);
    const parsed = FlatAttachmentPathSchema.parse(attachment.path);
    const key = pathKey(parsed);
    if (attachmentPathKeys.has(key))
      throw new TypeError(`ATTACHMENT_PATH_COLLISION: ${attachment.path}`);
    attachmentPathKeys.add(key);
    return { ...attachment, path: parsed };
  });
  const pages = legacy.pages.map((page, index) => ({
    ...page,
    referencedAttachmentIds: [...input.pages[index]!.referencedAttachmentIds],
  }));
  validateAttachmentReferences(pages, attachments);
  return { ...input, folders: legacy.folders, pages, attachments };
}

export function sortTreeChanges<T extends TreePushChange>(changes: T[]): T[] {
  return [...changes].sort(compareTreeChanges);
}
