import { describe, expect, it } from "vitest";
import {
  treeRevisionContentHashV3,
  type SyncPageV3,
} from "@neomei/agentwiki-sync-protocol";

import { contentHash } from "../../src/agentwiki/protocol";
import type { UpgradeTree } from "../../src/application/local-image-upgrade-plan";
import {
  parseOwnedLegacySpaces,
  verifyPublishedCandidate,
} from "../../verification/local-image-upgrade-assertions";

function spaceRow(overrides: Record<string, unknown> = {}) {
  return {
    spaceId: "space-populated",
    displayName: "U1 populated",
    role: "owner",
    canRead: true,
    canPublish: true,
    syncMode: "legacy_v2",
    currentRevision: "revision-source",
    folderCount: "2",
    pageCount: "2",
    attachmentCount: "0",
    revisionManifestByteLength: "100",
    revisionBodyBytes: "20",
    revisionAttachmentBytes: "0",
    ...overrides,
  };
}

const expectedSpace = {
  spaceId: "space-populated",
  currentRevision: "revision-source",
  role: "owner" as const,
  canRead: true as const,
  canPublish: true,
};

async function page(body: string): Promise<SyncPageV3> {
  return {
    pageId: "page-1",
    folderId: null,
    path: "pages/start.md",
    title: "start",
    body,
    contentHash: await contentHash(body),
    updatedAt: "2026-09-06T00:00:00.000Z",
    referencedAttachmentIds: [],
  };
}

describe("local image upgrade live assertions", () => {
  it("rejects a published tree whose changed Page differs from candidate C", async () => {
    const candidate: UpgradeTree = {
      protocolVersion: "3",
      spaceId: "space-populated",
      folders: [],
      pages: [await page("candidate body")],
      attachments: [],
    };
    const otherTree: UpgradeTree = {
      ...candidate,
      pages: [await page("different body")],
    };

    await expect(
      verifyPublishedCandidate(
        candidate,
        await treeRevisionContentHashV3(candidate),
        {
          ...otherTree,
          revision: "revision-published",
          revisionContentHash: await treeRevisionContentHashV3(otherTree),
        },
      ),
    ).rejects.toThrow("PUBLISHED_CANDIDATE_HASH_MISMATCH");
  });

  it("rejects a fixed published calculation tree that differs from candidate C", async () => {
    const candidate: UpgradeTree = {
      protocolVersion: "3",
      spaceId: "space-populated",
      folders: [],
      pages: [await page("candidate body")],
      attachments: [],
    };
    const otherTree: UpgradeTree = {
      ...candidate,
      pages: [await page("different body")],
    };

    await expect(
      verifyPublishedCandidate(
        candidate,
        await treeRevisionContentHashV3(otherTree),
        {
          ...otherTree,
          revision: "revision-published",
          revisionContentHash: await treeRevisionContentHashV3(otherTree),
        },
      ),
    ).rejects.toThrow("PUBLISHED_CANDIDATE_TREE_MISMATCH");
  });

  it("strictly parses the public v3 Space-list row", () => {
    expect(() =>
      parseOwnedLegacySpaces(
        {
          protocolVersion: "3",
          spaces: [spaceRow({ canRead: false })],
        },
        [expectedSpace],
      ),
    ).toThrow();
  });

  it("accepts the exact owned legacy Space contract", () => {
    expect(
      parseOwnedLegacySpaces(
        {
          protocolVersion: "3",
          spaces: [spaceRow()],
        },
        [expectedSpace],
      ),
    ).toEqual([spaceRow()]);
  });

  it("binds owned rows to legacy mode, source revision, role, and permissions", () => {
    expect(() =>
      parseOwnedLegacySpaces(
        {
          protocolVersion: "3",
          spaces: [
            spaceRow({
              syncMode: "native_v3",
              currentRevision: "other-revision",
              role: "viewer",
              canPublish: false,
            }),
          ],
        },
        [expectedSpace],
      ),
    ).toThrow("OWNED_LEGACY_SPACE_CONTRACT_MISMATCH");
  });
});
