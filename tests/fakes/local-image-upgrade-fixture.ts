import {
  canonicalBytes,
  canonicalTreeRevisionManifestV2,
  treeRevisionContentHashV2,
} from "@neomei/agentwiki-sync-protocol";

import { contentHash } from "../../src/agentwiki/protocol";
import type { TreeSnapshot } from "../../src/core/tree-model";

export const UPGRADE_SPACE_ID = "11111111-1111-4111-8111-111111111111";
export const UPGRADE_FOLDER_ID = "22222222-2222-4222-8222-222222222222";
export const UPGRADE_PAGE_ID = "33333333-3333-4333-8333-333333333333";
export const UPGRADE_REVISION = "44444444-4444-4444-8444-444444444444";
export const UPGRADE_TIME = "2026-09-06T00:00:00.000Z";

export async function makeLegacySource(): Promise<
  TreeSnapshot & { protocolVersion: "2" }
> {
  const body = "纯文字\n";
  const manifest = {
    protocolVersion: "2" as const,
    spaceId: UPGRADE_SPACE_ID,
    folders: [
      {
        folderId: UPGRADE_FOLDER_ID,
        parentFolderId: null,
        name: "notes",
        path: "pages/notes",
        sortOrder: 0,
        updatedAt: UPGRADE_TIME,
      },
    ],
    pages: [
      {
        pageId: UPGRADE_PAGE_ID,
        folderId: UPGRADE_FOLDER_ID,
        path: "pages/notes/text.md",
        title: "text",
        body,
        contentHash: await contentHash(body),
        updatedAt: UPGRADE_TIME,
      },
    ],
  };
  return {
    ...manifest,
    revision: UPGRADE_REVISION,
    revisionContentHash: await treeRevisionContentHashV2(manifest),
  };
}

export function legacySnapshotMetrics(
  source: TreeSnapshot & { protocolVersion: "2" },
) {
  const manifest = {
    protocolVersion: "2" as const,
    spaceId: source.spaceId,
    folders: source.folders,
    pages: source.pages,
  };
  return {
    folderCount: String(source.folders.length),
    pageCount: String(source.pages.length),
    revisionManifestByteLength: String(
      canonicalBytes(canonicalTreeRevisionManifestV2(manifest)).byteLength,
    ),
    revisionBodyBytes: String(
      source.pages.reduce(
        (total, page) => total + new TextEncoder().encode(page.body).byteLength,
        0,
      ),
    ),
  };
}
