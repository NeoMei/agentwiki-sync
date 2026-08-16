import { canonicalBytes, contentHash, sha256Hex } from "../agentwiki/protocol";
import { decodeVaultMarkdown } from "./markdown";
import type {
  LocalStatus,
  ManifestPage,
  MoveHint,
  ResolvedFile,
  ScanResult,
  ScannedFile,
  VaultFile,
} from "./model";
import {
  portablePathKey,
  titleFromPath,
  validatePortablePath,
} from "./portable-path";

export interface ScanOptions {
  complete: boolean;
  scanEpoch: number;
  capabilities: { pages: number; bodyBytes: number; manifestBytes: number };
  retainBodies?: boolean;
}

export async function scanMapping(
  files: Iterable<VaultFile> | AsyncIterable<VaultFile>,
  options: ScanOptions,
): Promise<ScanResult> {
  const scanned: ScannedFile[] = [];
  let bodyBytes = 0;
  const keys = new Set<string>();
  for await (const file of files) {
    if (scanned.length >= options.capabilities.pages)
      throw new RangeError("SPACE_TOO_LARGE: page count");
    const { path, key } = validatePortablePath(file.relativePath);
    if (keys.has(key)) throw new TypeError("PATH_COLLISION");
    keys.add(key);
    const decoded = decodeVaultMarkdown(file.bytes);
    const normalizedBytes = new TextEncoder().encode(
      decoded.normalized,
    ).byteLength;
    bodyBytes += normalizedBytes;
    if (bodyBytes > options.capabilities.bodyBytes)
      throw new RangeError("SPACE_TOO_LARGE: body bytes");
    scanned.push({
      relativePath: path,
      title: titleFromPath(path),
      ...(options.retainBodies === false
        ? {}
        : { normalizedBody: decoded.normalized }),
      contentHash: await contentHash(decoded.normalized),
      vaultByteHash: await sha256Hex(file.bytes),
    });
  }
  const manifestBytes = canonicalBytes({
    pages: scanned.map(
      ({ relativePath: path, title, contentHash: hash }, ordinal) => ({
        ordinal,
        path,
        title,
        contentHash: hash,
      }),
    ),
  }).byteLength;
  if (manifestBytes > options.capabilities.manifestBytes)
    throw new RangeError("SPACE_TOO_LARGE: manifest bytes");
  return {
    complete: options.complete,
    scanEpoch: options.scanEpoch,
    files: scanned,
    bodyBytes,
    manifestBytes,
  };
}

export function resolvePageIdentities(
  manifest: Record<string, ManifestPage>,
  files: ScannedFile[],
  hints: MoveHint[],
): ResolvedFile[] {
  const byPath = new Map(
    Object.values(manifest).map((page) => [
      portablePathKey(page.relativePath),
      page,
    ]),
  );
  const resolvedIds = new Set<string>();
  const result: ResolvedFile[] = [];
  for (const file of files) {
    const page = byPath.get(portablePathKey(file.relativePath));
    if (page) resolvedIds.add(page.pageId);
    result.push({
      ...file,
      pageId: page?.pageId ?? null,
      identityStatus: page ? "resolved" : "new",
    });
  }
  for (const file of result.filter((item) => item.pageId === null)) {
    const hintMatches = hints.filter(
      (hint) =>
        hint.toPath === file.relativePath &&
        manifest[hint.pageId] &&
        !resolvedIds.has(hint.pageId),
    );
    const hashMatches = Object.values(manifest).filter(
      (page) =>
        !resolvedIds.has(page.pageId) && page.contentHash === file.contentHash,
    );
    const candidates =
      hintMatches.length === 1
        ? hintMatches.map((hint) => manifest[hint.pageId]!)
        : hashMatches;
    if (candidates.length === 1) {
      file.pageId = candidates[0]!.pageId;
      file.identityStatus = "resolved";
      resolvedIds.add(candidates[0]!.pageId);
    } else if (candidates.length > 1) {
      file.identityStatus = "ambiguous";
    }
  }
  return result;
}

export function computeStatus(
  manifest: Record<string, ManifestPage>,
  files: ResolvedFile[],
  scan: ScanResult,
): LocalStatus {
  if (!scan.complete) throw new Error("本地扫描不完整");
  const seen = new Set(
    files.flatMap((file) => (file.pageId ? [file.pageId] : [])),
  );
  const added = files.filter((file) => file.identityStatus === "new");
  const ambiguous = files.filter((file) => file.identityStatus === "ambiguous");
  const modified = files.filter(
    (file) =>
      file.pageId !== null &&
      (manifest[file.pageId]?.contentHash !== file.contentHash ||
        manifest[file.pageId]?.title !== file.title),
  );
  const renamed = files.filter(
    (file) =>
      file.pageId !== null &&
      (manifest[file.pageId]?.relativePath ?? "").normalize("NFC") !==
        file.relativePath.normalize("NFC"),
  );
  const deleted = Object.values(manifest).filter(
    (page) => !seen.has(page.pageId),
  );
  return { added, modified, renamed, deleted, ambiguous };
}
