import {
  TreeSyncSpaceListResponseV3Schema,
  canonicalBytes,
  treeRevisionContentHashV3,
} from "@neomei/agentwiki-sync-protocol";

import type { UpgradeTree } from "../src/application/local-image-upgrade-plan";
import type { TreeSnapshotV3 } from "../src/core/tree-model";

export interface ExpectedLegacySpace {
  spaceId: string;
  currentRevision: string;
  role: "viewer" | "editor" | "admin" | "owner";
  canRead: true;
  canPublish: boolean;
}

export function parseOwnedLegacySpaces(
  json: unknown,
  expected: ExpectedLegacySpace[],
): ReturnType<typeof TreeSyncSpaceListResponseV3Schema.parse>["spaces"] {
  const rows = TreeSyncSpaceListResponseV3Schema.parse(json).spaces;
  for (const item of expected) {
    const row = rows.find((candidate) => candidate.spaceId === item.spaceId);
    if (!row) throw new Error("OWNED_LEGACY_SPACE_MISSING");
    if (
      row.syncMode !== "legacy_v2" ||
      row.currentRevision !== item.currentRevision ||
      row.role !== item.role ||
      row.canRead !== item.canRead ||
      row.canPublish !== item.canPublish
    )
      throw new Error("OWNED_LEGACY_SPACE_CONTRACT_MISMATCH");
  }
  return rows;
}

export async function verifyPublishedCandidate(
  candidate: UpgradeTree,
  candidateHash: string,
  published: TreeSnapshotV3,
): Promise<void> {
  const publishedTree: UpgradeTree = {
    protocolVersion: "3",
    spaceId: published.spaceId,
    folders: published.folders,
    pages: published.pages,
    attachments: published.attachments,
  };
  if (
    (await treeRevisionContentHashV3(publishedTree)) !==
    published.revisionContentHash
  )
    throw new Error("PUBLISHED_TREE_HASH_MISMATCH");
  if (published.revisionContentHash !== candidateHash)
    throw new Error("PUBLISHED_CANDIDATE_HASH_MISMATCH");
  const candidateBytes = canonicalBytes(candidate);
  const publishedBytes = canonicalBytes(publishedTree);
  if (
    candidateBytes.byteLength !== publishedBytes.byteLength ||
    candidateBytes.some((byte, index) => byte !== publishedBytes[index])
  )
    throw new Error("PUBLISHED_CANDIDATE_TREE_MISMATCH");
}
