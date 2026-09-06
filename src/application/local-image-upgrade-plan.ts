import {
  treeRevisionContentHashV2,
  treeRevisionContentHashV3,
} from "@neomei/agentwiki-sync-protocol";

import { parseAttachmentReferences } from "../core/attachment-reference";
import type { TreeSnapshot, TreeSnapshotV3 } from "../core/tree-model";
import { validateTreeSnapshot } from "../core/tree-validation";
import { contentHash } from "../agentwiki/protocol";

export type UpgradeTree = Pick<
  TreeSnapshotV3,
  "protocolVersion" | "spaceId" | "folders" | "pages" | "attachments"
>;

export interface LegacyUpgradeBase {
  sourceProtocolVersion: "2";
  sourceRevision: string;
  sourceV2RevisionHash: string;
  source: TreeSnapshot & { protocolVersion: "2" };
  projected: UpgradeTree;
  projectedV3BaseHash: string;
}

export async function projectLegacyBase(
  input: TreeSnapshot & { protocolVersion: "2" },
): Promise<LegacyUpgradeBase> {
  const source = validateTreeSnapshot(input) as TreeSnapshot & {
    protocolVersion: "2";
  };
  for (const page of source.pages) {
    if ((await contentHash(page.body)) !== page.contentHash)
      throw new Error("快照页面内容哈希不匹配");
  }
  const sourceHash = await treeRevisionContentHashV2({
    protocolVersion: "2",
    spaceId: source.spaceId,
    folders: source.folders,
    pages: source.pages,
  });
  const strictEmptyGenesis =
    source.revision === "0" &&
    source.revisionContentHash ===
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" &&
    source.folders.length === 0 &&
    source.pages.length === 0;
  if (!strictEmptyGenesis && sourceHash !== source.revisionContentHash)
    throw new Error("快照完整性不匹配");
  for (const page of source.pages) {
    const references = parseAttachmentReferences(page.body, page.path);
    if (references.some((reference) => reference.classification === "invalid"))
      throw new Error("LEGACY_IMAGE_REFERENCE_INVALID");
    if (
      references.some(
        (reference) =>
          reference.classification === "local" ||
          reference.classification === "legacy",
      )
    )
      throw new Error("LEGACY_IMAGE_CANDIDATE_REQUIRES_MODE_REFRESH");
  }
  const projected: UpgradeTree = {
    protocolVersion: "3",
    spaceId: source.spaceId,
    folders: source.folders.map((folder) => ({ ...folder })),
    pages: source.pages.map((page) => ({
      ...page,
      referencedAttachmentIds: [],
    })),
    attachments: [],
  };
  return {
    sourceProtocolVersion: "2",
    sourceRevision: source.revision,
    sourceV2RevisionHash: source.revisionContentHash,
    source: structuredClone(source),
    projected,
    projectedV3BaseHash: await treeRevisionContentHashV3(projected),
  };
}
