import {
  canonicalBytes,
  canonicalTreeRevisionManifestV2,
  treeRevisionContentHashV2,
  treeRevisionContentHashV3,
} from "@neomei/agentwiki-sync-protocol";

import {
  contentHash,
  decimalWithinLimit,
  revisionContentHash,
} from "../agentwiki/protocol";
import type { TreeSnapshot, TreeSnapshotV3 } from "../core/tree-model";
import {
  validateTreeSnapshot,
  validateTreeSnapshotV3,
} from "../core/tree-validation";
import type { TreeRemotePort, TreeRemotePortV3 } from "../ports/tree-remote";
import {
  cancellationCheckpoint,
  progressCheckpoint,
  type SyncOperationOptions,
} from "./progress";

function legacyManifestBytes(
  snapshot: Pick<
    TreeSnapshot,
    "protocolVersion" | "spaceId" | "folders" | "pages"
  >,
): number {
  if (snapshot.protocolVersion === "1")
    return canonicalBytes({
      protocolVersion: "1",
      spaceId: snapshot.spaceId,
      pages: snapshot.pages.map(({ pageId, path, title, contentHash }) => ({
        pageId,
        path,
        title,
        contentHash,
      })),
    }).byteLength;
  return canonicalBytes(
    canonicalTreeRevisionManifestV2({
      protocolVersion: "2",
      spaceId: snapshot.spaceId,
      folders: snapshot.folders,
      pages: snapshot.pages,
    }),
  ).byteLength;
}

export async function readTreeSnapshot(
  remote: TreeRemotePort,
  spaceId: string,
  revision: string,
  options?: SyncOperationOptions,
): Promise<TreeSnapshot> {
  const folders: TreeSnapshot["folders"] = [];
  const pages: TreeSnapshot["pages"] = [];
  let totalBodyBytes = 0;
  let pinned: Omit<
    Awaited<ReturnType<TreeRemotePort["head"]>>,
    "publishedAt"
  > | null = null;
  const capabilities = await remote.capabilities();
  for await (const segment of remote.snapshotPages(revision)) {
    const current = {
      protocolVersion: segment.protocolVersion,
      spaceId: segment.spaceId,
      revision: segment.revision,
      sequence: segment.sequence,
      revisionContentHash: segment.revisionContentHash,
      folderCount: segment.folderCount,
      pageCount: segment.pageCount,
      revisionManifestByteLength: segment.revisionManifestByteLength,
      revisionBodyBytes: segment.revisionBodyBytes,
    };
    if (pinned && JSON.stringify(pinned) !== JSON.stringify(current))
      throw new Error("快照分页元数据已变更");
    pinned = current;
    if (segment.spaceId !== spaceId) throw new Error("SNAPSHOT_SPACE_MISMATCH");
    if (segment.protocolVersion !== remote.protocolVersion)
      throw new Error("SNAPSHOT_PROTOCOL_MISMATCH");
    folders.push(...segment.folders);
    for (const page of segment.pages) {
      if ((await contentHash(page.body)) !== page.contentHash)
        throw new Error("快照页面内容哈希不匹配");
      const bodyBytes = new TextEncoder().encode(page.body).byteLength;
      if (bodyBytes > capabilities.maxPageBytes)
        throw new Error("PAGE_TOO_LARGE");
      totalBodyBytes += bodyBytes;
      if (totalBodyBytes > capabilities.maxClientTotalBodyBytes)
        throw new Error("SPACE_TOO_LARGE");
    }
    pages.push(...segment.pages);
    await progressCheckpoint(options, {
      phase: "download",
      completed: pages.length + folders.length,
      cancellable: true,
    });
  }
  if (!pinned) throw new Error("快照未返回元数据");
  if (revision !== "current" && pinned.revision !== revision)
    throw new Error("快照修订不匹配");
  decimalWithinLimit(pinned.pageCount, capabilities.maxClientSpacePages);
  decimalWithinLimit(
    pinned.folderCount,
    capabilities.maxClientSpaceFolders ?? 10_000,
  );
  if (
    String(folders.length) !== pinned.folderCount ||
    String(pages.length) !== pinned.pageCount
  )
    throw new Error("快照对象数量不匹配");
  decimalWithinLimit(
    pinned.revisionBodyBytes,
    capabilities.maxClientTotalBodyBytes,
  );
  if (totalBodyBytes !== Number(pinned.revisionBodyBytes))
    throw new Error("快照字节数不匹配");
  const candidate = validateTreeSnapshot({
    protocolVersion: pinned.protocolVersion,
    spaceId: pinned.spaceId,
    revision: pinned.revision,
    revisionContentHash: pinned.revisionContentHash,
    folders,
    pages,
  });
  if (
    pinned.revision === "0" &&
    (pinned.sequence !== 0 ||
      folders.length !== 0 ||
      pages.length !== 0 ||
      pinned.folderCount !== "0" ||
      pinned.pageCount !== "0" ||
      pinned.revisionBodyBytes !== "0" ||
      pinned.revisionManifestByteLength !== "0" ||
      pinned.revisionContentHash !==
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  )
    throw new Error("REVISION_ZERO_NOT_EMPTY");
  if (pinned.revision === "0") return candidate;
  const manifestBytes = legacyManifestBytes(candidate);
  decimalWithinLimit(
    pinned.revisionManifestByteLength,
    capabilities.maxClientManifestBytes,
  );
  if (manifestBytes !== Number(pinned.revisionManifestByteLength))
    throw new Error("快照 manifest 字节数不匹配");
  const expectedHash =
    candidate.protocolVersion === "2"
      ? await treeRevisionContentHashV2({
          protocolVersion: "2",
          spaceId: candidate.spaceId,
          folders: candidate.folders,
          pages: candidate.pages,
        })
      : await revisionContentHash({
          protocolVersion: "1",
          spaceId: candidate.spaceId,
          pages: candidate.pages.map(
            ({ pageId, path, title, contentHash }) => ({
              pageId,
              path,
              title,
              contentHash,
            }),
          ),
        });
  if (expectedHash !== pinned.revisionContentHash)
    throw new Error("快照完整性不匹配");
  return candidate;
}

export async function readTreeSnapshotV3(
  remote: TreeRemotePortV3,
  spaceId: string,
  revision: string,
  options?: SyncOperationOptions,
): Promise<TreeSnapshotV3> {
  const capabilities = await remote.capabilities();
  const folders: TreeSnapshotV3["folders"] = [];
  const pages: TreeSnapshotV3["pages"] = [];
  const attachments: TreeSnapshotV3["attachments"] = [];
  let pinned: Omit<
    Awaited<ReturnType<TreeRemotePortV3["head"]>>,
    "publishedAt"
  > | null = null;
  for await (const segment of remote.snapshotPages(revision)) {
    const current = {
      protocolVersion: segment.protocolVersion,
      spaceId: segment.spaceId,
      revision: segment.revision,
      sequence: segment.sequence,
      revisionContentHash: segment.revisionContentHash,
      folderCount: segment.folderCount,
      pageCount: segment.pageCount,
      attachmentCount: segment.attachmentCount,
      revisionManifestByteLength: segment.revisionManifestByteLength,
      revisionBodyBytes: segment.revisionBodyBytes,
      revisionAttachmentBytes: segment.revisionAttachmentBytes,
    };
    if (pinned && JSON.stringify(pinned) !== JSON.stringify(current))
      throw new Error("快照分页元数据已变更");
    pinned = current;
    if (segment.spaceId !== spaceId) throw new Error("SNAPSHOT_SPACE_MISMATCH");
    folders.push(...segment.folders);
    pages.push(...segment.pages);
    attachments.push(...segment.attachments);
    cancellationCheckpoint(options, true);
  }
  if (!pinned) throw new Error("快照未返回元数据");
  if (revision !== "current" && pinned.revision !== revision)
    throw new Error("快照修订不匹配");
  decimalWithinLimit(pinned.folderCount, capabilities.maxClientSpaceFolders);
  decimalWithinLimit(pinned.pageCount, capabilities.maxClientSpacePages);
  decimalWithinLimit(
    pinned.attachmentCount,
    capabilities.maxRevisionAttachments,
  );
  if (
    String(folders.length) !== pinned.folderCount ||
    String(pages.length) !== pinned.pageCount ||
    String(attachments.length) !== pinned.attachmentCount
  )
    throw new Error("快照对象数量不匹配");
  const snapshot = validateTreeSnapshotV3({
    protocolVersion: "3",
    spaceId: pinned.spaceId,
    revision: pinned.revision,
    revisionContentHash: pinned.revisionContentHash,
    folders,
    pages,
    attachments,
  });
  const manifest = {
    protocolVersion: "3" as const,
    spaceId: snapshot.spaceId,
    folders: snapshot.folders,
    pages: snapshot.pages,
    attachments: snapshot.attachments,
  };
  const bodyBytes = pages.reduce(
    (sum, page) => sum + new TextEncoder().encode(page.body).byteLength,
    0,
  );
  const attachmentBytes = attachments.reduce(
    (sum, item) => sum + Number(item.sizeBytes),
    0,
  );
  if (
    String(bodyBytes) !== pinned.revisionBodyBytes ||
    String(attachmentBytes) !== pinned.revisionAttachmentBytes ||
    String(canonicalBytes(manifest).byteLength) !==
      pinned.revisionManifestByteLength ||
    (await treeRevisionContentHashV3(manifest)) !== pinned.revisionContentHash
  )
    throw new Error("快照完整性不匹配");
  if (
    pinned.revision === "0" &&
    (pinned.sequence !== 0 ||
      folders.length ||
      pages.length ||
      attachments.length)
  )
    throw new Error("REVISION_ZERO_NOT_EMPTY");
  const completed = folders.length + pages.length + attachments.length;
  await progressCheckpoint(options, {
    phase: "download",
    completed,
    total: completed,
    cancellable: true,
  });
  return snapshot;
}
