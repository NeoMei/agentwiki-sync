import {
  pathKey,
  validatePortableDirectoryPath,
  validatePortableMarkdownPath,
} from "@neomei/agentwiki-sync-protocol";

import { contentHash } from "../agentwiki/protocol";
import type { VaultPort } from "../ports/vault";
import type { TreeIdentityState } from "../storage/tree-identities";
import { decodeVaultMarkdown } from "./markdown";
import { titleFromPath } from "./portable-path";
import type { TreeFolder, TreePage, TreeSnapshot } from "./tree-model";

export interface TreeScanLimits {
  maxFolders: number;
  maxPages: number;
  maxPageBytes: number;
}

export interface LocalTreeScan {
  rootPath: string;
  folders: TreeFolder[];
  pages: TreePage[];
}

const MANAGED_ROOT = "pages";
const MANAGED_PREFIX = `${MANAGED_ROOT}/`;

function comparePathKeys(left: string, right: string): number {
  const leftKey = pathKey(left);
  const rightKey = pathKey(right);
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return 0;
}

export async function scanLocalTree(
  vault: VaultPort,
  rootPath: string,
  base: TreeSnapshot,
  identities: TreeIdentityState,
  limits: TreeScanLimits,
): Promise<LocalTreeScan> {
  const directories: string[] = [];
  const markdown = new Map<string, Uint8Array>();
  for await (const entry of vault.listTree(rootPath)) {
    if (entry.relativePath === MANAGED_ROOT) continue;
    if (!entry.relativePath.startsWith(MANAGED_PREFIX)) continue;
    if (entry.kind === "directory") directories.push(entry.relativePath);
    else if (entry.kind === "markdown")
      markdown.set(entry.relativePath, entry.bytes ?? new Uint8Array());
  }

  // Stable ID resolution is pathKey-first. Committed local identity wins, then
  // pending local identity, then the base (remote) tree.
  const folderIdByPathKey = new Map<string, string>();
  for (const identity of Object.values(identities.folders))
    folderIdByPathKey.set(identity.pathKey, identity.folderId);
  for (const identity of Object.values(identities.pendingFolders))
    if (!folderIdByPathKey.has(identity.pathKey))
      folderIdByPathKey.set(identity.pathKey, identity.folderId);
  for (const folder of base.folders) {
    const key = pathKey(folder.path);
    if (!folderIdByPathKey.has(key))
      folderIdByPathKey.set(key, folder.folderId);
  }

  const pageIdByPathKey = new Map<string, string>();
  for (const identity of Object.values(identities.pendingPages))
    if (!pageIdByPathKey.has(pathKey(identity.path)))
      pageIdByPathKey.set(pathKey(identity.path), identity.pageId);
  for (const page of base.pages) {
    const key = pathKey(page.path);
    if (!pageIdByPathKey.has(key)) pageIdByPathKey.set(key, page.pageId);
  }

  // A directory and a markdown page occupying the same folded path must not
  // silently alias; reject before constructing the tree.
  const seenKeys = new Set<string>();
  for (const path of [...directories, ...markdown.keys()]) {
    const key = pathKey(path);
    if (seenKeys.has(key)) throw new TypeError("PATH_COLLISION");
    seenKeys.add(key);
  }

  const now = new Date().toISOString();

  const sortedDirectories = [...directories].sort(comparePathKeys);
  if (sortedDirectories.length > limits.maxFolders)
    throw new RangeError("SPACE_TOO_LARGE: folder count");

  const resolvedFolders: Array<{
    folderId: string;
    path: string;
    parentPath: string | null;
    name: string;
  }> = [];
  const folderIdByPath = new Map<string, string>();
  for (const rawPath of sortedDirectories) {
    const { path, key } = validatePortableDirectoryPath(rawPath);
    let folderId = folderIdByPathKey.get(key);
    if (folderId === undefined) {
      folderId = crypto.randomUUID();
      identities.pendingFolders[folderId] = { folderId, path, pathKey: key };
    }
    const segments = path.split("/");
    const name = segments.at(-1) ?? "";
    const parentPath =
      segments.length > 1 ? segments.slice(0, -1).join("/") : null;
    resolvedFolders.push({ folderId, path, parentPath, name });
    folderIdByPath.set(path, folderId);
  }

  const sortOrderByParent = new Map<string, number>();
  const folders: TreeFolder[] = resolvedFolders.map((item) => {
    const parentKey = item.parentPath ?? MANAGED_ROOT;
    const sortOrder = sortOrderByParent.get(parentKey) ?? 0;
    sortOrderByParent.set(parentKey, sortOrder + 1);
    const parentFolderId =
      item.parentPath === null || item.parentPath === MANAGED_ROOT
        ? null
        : (folderIdByPath.get(item.parentPath) ?? null);
    return {
      folderId: item.folderId,
      parentFolderId,
      name: item.name,
      path: item.path,
      sortOrder,
      updatedAt: now,
    };
  });

  const sortedPages = [...markdown.keys()].sort(comparePathKeys);
  if (sortedPages.length > limits.maxPages)
    throw new RangeError("SPACE_TOO_LARGE: page count");

  const pages: TreePage[] = [];
  let totalBodyBytes = 0;
  for (const rawPath of sortedPages) {
    const bytes = markdown.get(rawPath) ?? new Uint8Array();
    const { path, key } = validatePortableMarkdownPath(rawPath);
    const decoded = decodeVaultMarkdown(bytes);
    const body = decoded.normalized;
    const hash = await contentHash(body);
    totalBodyBytes += new TextEncoder().encode(body).byteLength;
    if (totalBodyBytes > limits.maxPageBytes)
      throw new RangeError("SPACE_TOO_LARGE: page bytes");

    let pageId = pageIdByPathKey.get(key);
    if (pageId === undefined) {
      pageId = crypto.randomUUID();
      identities.pendingPages[pageId] = { pageId, path, contentHash: hash };
    }

    const segments = path.split("/");
    segments.pop();
    const parentPath = segments.join("/");
    const folderId =
      parentPath === MANAGED_ROOT
        ? null
        : (folderIdByPath.get(parentPath) ?? null);

    pages.push({
      pageId,
      folderId,
      path,
      title: titleFromPath(path),
      body,
      contentHash: hash,
      updatedAt: now,
    });
  }

  return { rootPath, folders, pages };
}
