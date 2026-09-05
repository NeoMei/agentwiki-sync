import {
  FlatAttachmentPathSchema,
  pathKey,
  validatePortableDirectoryPath,
  validatePortableMarkdownPath,
} from "@neomei/agentwiki-sync-protocol";

import { contentHash, sha256Hex } from "../agentwiki/protocol";
import type { VaultPort, VaultTreeEntry } from "../ports/vault";
import type { TreeIdentityState } from "../storage/tree-identities";
import {
  parseAttachmentReferences,
  type AttachmentReference,
} from "./attachment-reference";
import {
  inspectImageMetadata,
  type ImageMetadataLimits,
  type ImageMimeType,
} from "./image-metadata";
import { decodeVaultMarkdown } from "./markdown";
import { titleFromPath } from "./portable-path";
import type {
  TreeAttachment,
  TreeFolder,
  TreePage,
  TreePageV3,
  TreeSnapshot,
  TreeSnapshotV3,
} from "./tree-model";

export interface TreeScanLimits {
  maxFolders: number;
  maxPages: number;
  maxPageBytes: number;
}

export interface TreeScanLimitsV3 extends TreeScanLimits {
  maxAttachmentBytes?: number;
  maxRevisionAttachments?: number;
  maxTransferBlobBytes?: number;
  maxImageDimension?: number;
  maxDecodedPixels?: number;
  allowedMimeTypes?: readonly ImageMimeType[];
}

interface EffectiveTreeScanLimitsV3
  extends TreeScanLimits, ImageMetadataLimits {
  maxAttachmentBytes: number;
  maxRevisionAttachments: number;
  maxTransferBlobBytes: number;
}

const LOCAL_TREE_SCAN_LIMITS_V3 = Object.freeze({
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxRevisionAttachments: 1_000,
  maxTransferBlobBytes: 100 * 1024 * 1024,
  maxImageDimension: 10_000,
  maxDecodedPixels: 40_000_000,
  allowedMimeTypes: [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
  ] as const,
});

function boundedPositiveInteger(
  advertised: number | undefined,
  localMaximum: number,
  name: string,
): number {
  if (advertised === undefined) return localMaximum;
  if (!Number.isSafeInteger(advertised) || advertised <= 0)
    throw new TypeError(`invalid v3 scan limit: ${name}`);
  return Math.min(advertised, localMaximum);
}

export function deriveEffectiveTreeScanLimitsV3(
  limits: TreeScanLimitsV3 | TreeScanLimits,
): EffectiveTreeScanLimitsV3 {
  const advertised = limits as TreeScanLimitsV3;
  return {
    ...limits,
    maxAttachmentBytes: boundedPositiveInteger(
      advertised.maxAttachmentBytes,
      LOCAL_TREE_SCAN_LIMITS_V3.maxAttachmentBytes,
      "maxAttachmentBytes",
    ),
    maxRevisionAttachments: boundedPositiveInteger(
      advertised.maxRevisionAttachments,
      LOCAL_TREE_SCAN_LIMITS_V3.maxRevisionAttachments,
      "maxRevisionAttachments",
    ),
    maxTransferBlobBytes: boundedPositiveInteger(
      advertised.maxTransferBlobBytes,
      LOCAL_TREE_SCAN_LIMITS_V3.maxTransferBlobBytes,
      "maxTransferBlobBytes",
    ),
    maxImageDimension: boundedPositiveInteger(
      advertised.maxImageDimension,
      LOCAL_TREE_SCAN_LIMITS_V3.maxImageDimension,
      "maxImageDimension",
    ),
    maxDecodedPixels: boundedPositiveInteger(
      advertised.maxDecodedPixels,
      LOCAL_TREE_SCAN_LIMITS_V3.maxDecodedPixels,
      "maxDecodedPixels",
    ),
    allowedMimeTypes:
      advertised.allowedMimeTypes ?? LOCAL_TREE_SCAN_LIMITS_V3.allowedMimeTypes,
  };
}

export interface LocalTreeScan {
  rootPath: string;
  folders: TreeFolder[];
  pages: TreePage[];
}

export interface AttachmentScanBlocker {
  code:
    | "ATTACHMENT_REFERENCE_INVALID"
    | "ATTACHMENT_MISSING"
    | "ATTACHMENT_CONTENT_INVALID"
    | "ATTACHMENT_NAME_CONFLICT"
    | "ATTACHMENT_QUOTA_EXCEEDED";
  pagePath?: string;
  target?: string;
  targetStart?: number;
  targetEnd?: number;
  path?: string;
  detail: string;
}

export interface LocalTreeScanV3 {
  rootPath: string;
  folders: TreeFolder[];
  pages: TreePageV3[];
  attachments: TreeAttachment[];
  blockers: AttachmentScanBlocker[];
  /** Exact raw Vault state observed before Markdown normalization. */
  rawPathStates: Record<
    string,
    { kind: "directory" | "file" | "missing"; hash: string | null }
  >;
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

function joinRoot(rootPath: string, path: string): string {
  return rootPath ? `${rootPath}/${path}` : path;
}

function extensionMatches(path: string, mimeType: ImageMimeType): boolean {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return mimeType === "image/jpeg"
    ? extension === "jpg" || extension === "jpeg"
    : extension === mimeType.slice("image/".length);
}

function referenceBlocker(
  reference: AttachmentReference,
  pagePath: string,
  code: AttachmentScanBlocker["code"],
  detail: string,
  path?: string,
): AttachmentScanBlocker {
  return {
    code,
    pagePath,
    target: reference.target,
    targetStart: reference.targetStart,
    targetEnd: reference.targetEnd,
    path,
    detail,
  };
}

function errorCode(error: unknown): AttachmentScanBlocker["code"] {
  return error instanceof RangeError
    ? "ATTACHMENT_QUOTA_EXCEEDED"
    : "ATTACHMENT_CONTENT_INVALID";
}

interface IdentityCandidate {
  id: string;
  key: string;
  path: string;
  precedence: number;
}

function attachmentIdentityCandidates(
  identities: TreeIdentityState,
  base: TreeSnapshotV3,
): IdentityCandidate[] {
  const candidates: IdentityCandidate[] = [];
  for (const identity of Object.values(identities.attachments ?? {}))
    if (identity.active)
      candidates.push({
        id: identity.attachmentId,
        key: identity.pathKey,
        path: identity.path,
        precedence: 0,
      });
  for (const identity of Object.values(identities.pendingAttachments ?? {}))
    candidates.push({
      id: identity.attachmentId,
      key: identity.pathKey,
      path: identity.path,
      precedence: 1,
    });
  for (const attachment of base.attachments)
    candidates.push({
      id: attachment.attachmentId,
      key: pathKey(attachment.path),
      path: attachment.path,
      precedence: 2,
    });
  return candidates;
}

function collisionKeys(candidates: IdentityCandidate[]): Set<string> {
  const idsByKey = new Map<string, Set<string>>();
  const keysById = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const ids = idsByKey.get(candidate.key) ?? new Set<string>();
    ids.add(candidate.id);
    idsByKey.set(candidate.key, ids);
    const keys = keysById.get(candidate.id) ?? new Set<string>();
    keys.add(candidate.key);
    keysById.set(candidate.id, keys);
  }
  const collisions = new Set<string>();
  for (const [key, ids] of idsByKey) if (ids.size > 1) collisions.add(key);
  for (const keys of keysById.values())
    if (keys.size > 1) for (const key of keys) collisions.add(key);
  return collisions;
}

function resolveKnownAttachmentId(
  key: string,
  candidates: IdentityCandidate[],
): string | undefined {
  return candidates
    .filter((candidate) => candidate.key === key)
    .sort((left, right) => left.precedence - right.precedence)[0]?.id;
}

export function scanLocalTree(
  vault: VaultPort,
  rootPath: string,
  base: TreeSnapshotV3,
  identities: TreeIdentityState,
  limits: TreeScanLimitsV3,
  onProgress?: (completed: number) => Promise<void>,
): Promise<LocalTreeScanV3>;
export function scanLocalTree(
  vault: VaultPort,
  rootPath: string,
  base: TreeSnapshot,
  identities: TreeIdentityState,
  limits: TreeScanLimits,
  onProgress?: (completed: number) => Promise<void>,
): Promise<LocalTreeScan>;

export async function scanLocalTree(
  vault: VaultPort,
  rootPath: string,
  base: TreeSnapshot | TreeSnapshotV3,
  identities: TreeIdentityState,
  limits: TreeScanLimits,
  onProgress?: (completed: number) => Promise<void>,
): Promise<LocalTreeScan | LocalTreeScanV3> {
  const directories: string[] = [];
  const markdown = new Map<string, Uint8Array>();
  const files = new Map<string, VaultTreeEntry>();
  const rawPathStates: LocalTreeScanV3["rawPathStates"] = {};
  let scanned = 0;
  for await (const entry of vault.listTree(rootPath)) {
    scanned += 1;
    if (scanned % 50 === 0) await onProgress?.(scanned);
    if (entry.kind === "file") {
      files.set(entry.relativePath, entry);
      if (entry.relativePath.startsWith(MANAGED_PREFIX)) {
        const involvedBytes =
          entry.bytes ??
          (await vault.read(joinRoot(rootPath, entry.relativePath)));
        rawPathStates[entry.relativePath] = {
          kind: "file",
          hash: involvedBytes ? await sha256Hex(involvedBytes) : null,
        };
      }
      continue;
    }
    if (entry.relativePath === MANAGED_ROOT) continue;
    if (!entry.relativePath.startsWith(MANAGED_PREFIX)) continue;
    if (entry.kind === "directory") {
      directories.push(entry.relativePath);
      rawPathStates[entry.relativePath] = { kind: "directory", hash: null };
    } else {
      const bytes = entry.bytes ?? new Uint8Array();
      markdown.set(entry.relativePath, bytes);
      rawPathStates[entry.relativePath] = {
        kind: "file",
        hash: await sha256Hex(bytes),
      };
    }
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
  const pageReferences = new Map<string, AttachmentReference[]>();
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
    if (base.protocolVersion === "3")
      pageReferences.set(path, parseAttachmentReferences(body, path));
  }

  if (base.protocolVersion !== "3") return { rootPath, folders, pages };

  const v3Limits = deriveEffectiveTreeScanLimitsV3(limits);
  const blockers: AttachmentScanBlocker[] = [];
  const assetEntriesByKey = new Map<string, VaultTreeEntry[]>();
  for (const [relativePath, entry] of files) {
    if (!relativePath.startsWith("assets/")) continue;
    const parsed = FlatAttachmentPathSchema.safeParse(relativePath);
    if (!parsed.success) continue;
    const key = pathKey(parsed.data);
    const entries = assetEntriesByKey.get(key) ?? [];
    entries.push({ ...entry, relativePath: parsed.data });
    assetEntriesByKey.set(key, entries);
  }

  const candidates = attachmentIdentityCandidates(identities, base);
  const identityCollisionKeys = collisionKeys(candidates);
  const resolvedPathByPage = new Map<string, Map<number, string>>();
  const referencedPaths = new Map<string, string>();
  for (const page of pages) {
    const resolvedByIndex = new Map<number, string>();
    resolvedPathByPage.set(page.path, resolvedByIndex);
    for (const [index, reference] of (
      pageReferences.get(page.path) ?? []
    ).entries()) {
      if (
        reference.classification === "external" ||
        reference.classification === "page_embed"
      )
        continue;
      if (reference.classification === "invalid") {
        blockers.push(
          referenceBlocker(
            reference,
            page.path,
            "ATTACHMENT_REFERENCE_INVALID",
            reference.reason ?? "invalid local image reference",
          ),
        );
        continue;
      }
      let key: string;
      if (reference.classification === "legacy") {
        key = pathKey(`assets/${reference.target}`);
        const matches = assetEntriesByKey.get(key) ?? [];
        if (matches.length !== 1) {
          blockers.push(
            referenceBlocker(
              reference,
              page.path,
              matches.length === 0
                ? "ATTACHMENT_MISSING"
                : "ATTACHMENT_NAME_CONFLICT",
              matches.length === 0
                ? "historical bare-name image is missing"
                : "historical bare-name image is ambiguous",
            ),
          );
          continue;
        }
      } else key = pathKey(reference.resolvedPath!);

      const entries = assetEntriesByKey.get(key) ?? [];
      if (entries.length === 0) {
        blockers.push(
          referenceBlocker(
            reference,
            page.path,
            "ATTACHMENT_MISSING",
            "referenced image is missing",
            reference.resolvedPath,
          ),
        );
        continue;
      }
      if (entries.length > 1 || identityCollisionKeys.has(key)) {
        blockers.push(
          referenceBlocker(
            reference,
            page.path,
            "ATTACHMENT_NAME_CONFLICT",
            entries.length > 1
              ? "multiple asset paths share one portable path key"
              : "attachment identity collision",
            entries[0]?.relativePath,
          ),
        );
        continue;
      }
      const resolvedPath = entries[0]!.relativePath;
      resolvedByIndex.set(index, resolvedPath);
      referencedPaths.set(key, resolvedPath);
    }
  }

  if (referencedPaths.size > v3Limits.maxRevisionAttachments) {
    blockers.push({
      code: "ATTACHMENT_QUOTA_EXCEEDED",
      detail: "attachment count exceeds the revision limit",
    });
    referencedPaths.clear();
  }

  const attachments: TreeAttachment[] = [];
  const attachmentIdByKey = new Map<string, string>();
  const baseContentHashes = new Set(
    base.attachments.map((attachment) => attachment.contentHash),
  );
  const chargedContentHashes = new Set<string>();
  let transferBlobBytes = 0;
  for (const [key, path] of [...referencedPaths].sort((left, right) =>
    comparePathKeys(left[1], right[1]),
  )) {
    const entry = assetEntriesByKey.get(key)?.[0];
    if (!entry) continue;
    if (
      entry.byteLength !== undefined &&
      entry.byteLength > v3Limits.maxAttachmentBytes
    ) {
      blockers.push({
        code: "ATTACHMENT_QUOTA_EXCEEDED",
        path,
        detail: "listed attachment bytes exceed the per-image limit",
      });
      continue;
    }
    const bytes = await vault.read(joinRoot(rootPath, path));
    if (bytes === null) {
      blockers.push({
        code: "ATTACHMENT_MISSING",
        path,
        detail: "referenced image disappeared during scan",
      });
      continue;
    }
    if (bytes.byteLength > v3Limits.maxAttachmentBytes) {
      blockers.push({
        code: "ATTACHMENT_QUOTA_EXCEEDED",
        path,
        detail: "actual attachment bytes exceed the per-image limit",
      });
      continue;
    }
    let metadata;
    try {
      metadata = inspectImageMetadata(bytes, v3Limits);
    } catch (error) {
      blockers.push({
        code: errorCode(error),
        path,
        detail: error instanceof Error ? error.message : "invalid image",
      });
      continue;
    }
    if (!extensionMatches(path, metadata.mimeType)) {
      blockers.push({
        code: "ATTACHMENT_CONTENT_INVALID",
        path,
        detail: "image magic does not match its path extension",
      });
      continue;
    }
    const hash = await sha256Hex(bytes);
    rawPathStates[path] = { kind: "file", hash };
    const needsTransfer =
      !baseContentHashes.has(hash) && !chargedContentHashes.has(hash);
    if (
      needsTransfer &&
      transferBlobBytes + bytes.byteLength > v3Limits.maxTransferBlobBytes
    ) {
      blockers.push({
        code: "ATTACHMENT_QUOTA_EXCEEDED",
        path,
        detail: "new attachment blob bytes exceed the transfer limit",
      });
      continue;
    }
    if (needsTransfer) {
      chargedContentHashes.add(hash);
      transferBlobBytes += bytes.byteLength;
    }
    let attachmentId = resolveKnownAttachmentId(key, candidates);
    if (attachmentId === undefined) {
      const detachedMatches = Object.values(
        identities.attachments ?? {},
      ).filter(
        (identity) =>
          !identity.active &&
          identity.pathKey === key &&
          identity.baseContentHash === hash,
      );
      if (
        new Set(detachedMatches.map((identity) => identity.attachmentId)).size >
        1
      ) {
        blockers.push({
          code: "ATTACHMENT_NAME_CONFLICT",
          path,
          detail: "multiple detached identities exactly match the image",
        });
        continue;
      }
      const detachedMatch = detachedMatches[0];
      if (detachedMatch) {
        const keysForId = new Set([
          detachedMatch.pathKey,
          ...candidates
            .filter((candidate) => candidate.id === detachedMatch.attachmentId)
            .map((candidate) => candidate.key),
        ]);
        if (keysForId.size > 1) {
          blockers.push({
            code: "ATTACHMENT_NAME_CONFLICT",
            path,
            detail: "detached attachment ID is bound to another path",
          });
          continue;
        }
        attachmentId = detachedMatch.attachmentId;
        detachedMatch.active = true;
      }
    }
    if (attachmentId === undefined) {
      attachmentId = crypto.randomUUID();
      const pendingAttachments = (identities.pendingAttachments ??= {});
      pendingAttachments[attachmentId] = {
        attachmentId,
        path,
        pathKey: key,
        contentHash: hash,
      };
    }
    attachmentIdByKey.set(key, attachmentId);
    attachments.push({
      attachmentId,
      path,
      mimeType: metadata.mimeType,
      sizeBytes: String(bytes.byteLength),
      width: metadata.width,
      height: metadata.height,
      contentHash: hash,
      updatedAt: entry.updatedAt ?? now,
    });
  }

  const v3Pages: TreePageV3[] = pages.map((page) => {
    const ids = new Set<string>();
    for (const path of resolvedPathByPage.get(page.path)?.values() ?? []) {
      const id = attachmentIdByKey.get(pathKey(path));
      if (id) ids.add(id);
    }
    return { ...page, referencedAttachmentIds: [...ids].sort() };
  });
  attachments.sort((left, right) => comparePathKeys(left.path, right.path));
  blockers.sort((left, right) =>
    [left.pagePath ?? "", left.targetStart ?? -1, left.path ?? "", left.code]
      .join("\0")
      .localeCompare(
        [
          right.pagePath ?? "",
          right.targetStart ?? -1,
          right.path ?? "",
          right.code,
        ].join("\0"),
      ),
  );
  return {
    rootPath,
    folders,
    pages: v3Pages,
    attachments,
    blockers,
    rawPathStates,
  };
}
