import { describe, expect, it } from "vitest";
import {
  canonicalBytes,
  treeCapabilitiesHashV3,
  treeRevisionContentHashV2,
  treeRevisionContentHashV3,
  type TreeSyncCapabilitiesV3,
} from "@neomei/agentwiki-sync-protocol";
import { AgentWikiClient } from "../../src/agentwiki/client";
import { contentHash } from "../../src/agentwiki/protocol";
import { V2TreeRemote } from "../../src/agentwiki/v2-tree-remote";
import { V3TreeRemote } from "../../src/agentwiki/v3-tree-remote";
import { projectLegacyBase } from "../../src/application/local-image-upgrade-plan";
import {
  readTreeSnapshot,
  readTreeSnapshotV3,
} from "../../src/application/tree-snapshot-reader";
import type { TreeSnapshot } from "../../src/core/tree-model";
import { FakeHttp } from "../fakes/fake-http";
import {
  UPGRADE_SPACE_ID,
  legacySnapshotMetrics,
  makeLegacySource,
} from "../fakes/local-image-upgrade-fixture";

const V2_CAPABILITIES = {
  maxPageBytes: 1_048_576,
  maxBatchBytes: 4_194_304,
  maxBatchItems: 100,
  maxChangeCount: 100,
  maxConfirmationBytes: 4_194_304,
  maxClientSpacePages: 5_000,
  maxClientSpaceFolders: 10_000,
  maxSnapshotObjects: 15_000,
  maxClientManifestBytes: 4_194_304,
  maxClientTotalBodyBytes: 2_097_152,
  maxDeltaItems: 15_000,
  maxResponseBytes: 4_194_304,
  maxPageItems: 200,
  pushSessionTtlSeconds: 900,
};
const V3_CAPABILITIES: TreeSyncCapabilitiesV3 = {
  ...V2_CAPABILITIES,
  maxClientSpaceFolders: 5_000,
  maxSnapshotObjects: 10_000,
  maxAttachmentBytes: 10 * 1_048_576,
  maxRevisionAttachments: 1_000,
  maxTransferBlobBytes: 100 * 1_048_576,
  blobChunkBytes: 1_048_576,
  maxBlobChunks: 10,
  maxConcurrentBlobs: 2,
  maxImageDimension: 10_000,
  maxDecodedPixels: 40_000_000,
  allowedMimeTypes: ["image/gif", "image/jpeg", "image/png", "image/webp"],
  blobStagingTtlSeconds: 900,
  downloadAuthorizationTtlSeconds: 300,
};

function v2Remote(
  http: FakeHttp,
  overrides: Partial<typeof V2_CAPABILITIES> = {},
) {
  return new V2TreeRemote(
    new AgentWikiClient("https://wiki.example.com", http, () => "test"),
    UPGRADE_SPACE_ID,
    {
      version: "2",
      capabilities: { ...V2_CAPABILITIES, ...overrides },
      capabilitiesHash: "c".repeat(64),
    },
  );
}
function response(
  source: TreeSnapshot & { protocolVersion: "2" },
  overrides: Record<string, unknown> = {},
) {
  return {
    ...source,
    sequence: source.revision === "0" ? 0 : 1,
    ...legacySnapshotMetrics(source),
    folders: source.folders,
    pages: source.pages,
    nextCursor: null,
    ...overrides,
  };
}

describe("fixed legacy snapshot reader", () => {
  it("pins every page request to R and combines a complete real-adapter snapshot", async () => {
    const source = await makeLegacySource();
    const http = new FakeHttp();
    http.responses.push(
      {
        status: 200,
        json: response(source, { pages: [], nextCursor: "next-page" }),
      },
      {
        status: 200,
        json: response(source, { folders: [], nextCursor: null }),
      },
    );
    await expect(
      readTreeSnapshot(v2Remote(http), source.spaceId, source.revision),
    ).resolves.toEqual(source);
    expect(http.calls.map((call) => call.path)).toEqual([
      `/api/sync/v2/spaces/${source.spaceId}/snapshot?revision=${source.revision}`,
      `/api/sync/v2/spaces/${source.spaceId}/snapshot?revision=${source.revision}&cursor=next-page`,
    ]);
  });

  it("rejects cross-Space, mixed-page, missing and repeated entities", async () => {
    const source = await makeLegacySource();
    const foreign = {
      ...source,
      spaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    foreign.revisionContentHash = await treeRevisionContentHashV2({
      protocolVersion: "2",
      spaceId: foreign.spaceId,
      folders: foreign.folders,
      pages: foreign.pages,
    });
    const cross = new FakeHttp();
    cross.enqueue({ status: 200, json: response(foreign) });
    await expect(
      readTreeSnapshot(v2Remote(cross), source.spaceId, source.revision),
    ).rejects.toThrow("SNAPSHOT_SPACE_MISMATCH");

    const mixed = new FakeHttp();
    mixed.responses.push(
      { status: 200, json: response(source, { nextCursor: "next" }) },
      {
        status: 200,
        json: response({
          ...source,
          revision: "55555555-5555-4555-8555-555555555555",
        }),
      },
    );
    await expect(
      readTreeSnapshot(v2Remote(mixed), source.spaceId, source.revision),
    ).rejects.toThrow(/分页元数据/);

    const incomplete = new FakeHttp();
    incomplete.enqueue({
      status: 200,
      json: response(source, { pageCount: "2" }),
    });
    await expect(
      readTreeSnapshot(v2Remote(incomplete), source.spaceId, source.revision),
    ).rejects.toThrow(/数量/);

    const repeated = {
      ...source,
      folders: [source.folders[0]!, { ...source.folders[0]! }],
    };
    const duplicate = new FakeHttp();
    duplicate.enqueue({
      status: 200,
      json: response(source, {
        folders: repeated.folders,
        folderCount: "2",
        revisionContentHash: "f".repeat(64),
      }),
    });
    await expect(
      readTreeSnapshot(v2Remote(duplicate), source.spaceId, source.revision),
    ).rejects.toThrow("DUPLICATE_FOLDER_ID");

    const missing = {
      ...source,
      pages: [{ ...source.pages[0]!, folderId: "missing-folder" }],
    };
    const parent = new FakeHttp();
    parent.enqueue({
      status: 200,
      json: response(source, {
        pages: missing.pages,
        revisionContentHash: "f".repeat(64),
      }),
    });
    await expect(
      readTreeSnapshot(v2Remote(parent), source.spaceId, source.revision),
    ).rejects.toThrow("UNKNOWN_PARENT");
  });

  it("rejects body hash, manifest-byte, revision-hash and cumulative-limit mismatches", async () => {
    const source = await makeLegacySource();
    const badBody = {
      ...source,
      pages: [{ ...source.pages[0]!, body: "tampered\n" }],
    };
    const bodyHttp = new FakeHttp();
    bodyHttp.enqueue({ status: 200, json: response(badBody) });
    await expect(
      readTreeSnapshot(v2Remote(bodyHttp), source.spaceId, source.revision),
    ).rejects.toThrow(/内容哈希/);

    const bytesHttp = new FakeHttp();
    bytesHttp.enqueue({
      status: 200,
      json: response(source, {
        revisionManifestByteLength: String(
          Number(legacySnapshotMetrics(source).revisionManifestByteLength) + 1,
        ),
      }),
    });
    await expect(
      readTreeSnapshot(v2Remote(bytesHttp), source.spaceId, source.revision),
    ).rejects.toThrow(/manifest/);

    const hashHttp = new FakeHttp();
    hashHttp.enqueue({
      status: 200,
      json: response({ ...source, revisionContentHash: "f".repeat(64) }),
    });
    await expect(
      readTreeSnapshot(v2Remote(hashHttp), source.spaceId, source.revision),
    ).rejects.toThrow(/完整性/);

    const over = new FakeHttp();
    over.enqueue({ status: 200, json: response(source) });
    await expect(
      readTreeSnapshot(
        v2Remote(over, { maxClientTotalBodyBytes: 1 }),
        source.spaceId,
        source.revision,
      ),
    ).rejects.toThrow("SPACE_TOO_LARGE");
  });

  it("requires strict revision-0 empty evidence and never converts 404 to empty", async () => {
    const source = await makeLegacySource();
    const emptyManifest = {
      protocolVersion: "2" as const,
      spaceId: source.spaceId,
      folders: [],
      pages: [],
    };
    const empty = {
      ...emptyManifest,
      revision: "0",
      revisionContentHash:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    };
    const emptyHttp = new FakeHttp();
    emptyHttp.enqueue({
      status: 200,
      json: response(empty, { revisionManifestByteLength: "0" }),
    });
    await expect(
      readTreeSnapshot(v2Remote(emptyHttp), source.spaceId, "0"),
    ).resolves.toEqual(empty);

    const dishonest = { ...source, revision: "0" };
    dishonest.revisionContentHash = await treeRevisionContentHashV2({
      protocolVersion: "2",
      spaceId: dishonest.spaceId,
      folders: dishonest.folders,
      pages: dishonest.pages,
    });
    const dishonestHttp = new FakeHttp();
    dishonestHttp.enqueue({
      status: 200,
      json: response(dishonest, { sequence: 0 }),
    });
    await expect(
      readTreeSnapshot(v2Remote(dishonestHttp), source.spaceId, "0"),
    ).rejects.toThrow("REVISION_ZERO_NOT_EMPTY");
    await expect(
      readTreeSnapshot(
        v2Remote(new FakeHttp()),
        source.spaceId,
        source.revision,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("legacy projection", () => {
  it("preserves ids, timestamps and order without giving the calculation tree revision identity", async () => {
    const source = await makeLegacySource();
    const base = await projectLegacyBase(source);
    expect(base.sourceRevision).toBe(source.revision);
    expect(base.sourceV2RevisionHash).toBe(source.revisionContentHash);
    expect(base.projected.folders).toEqual(source.folders);
    expect(base.projected.pages).toEqual(
      source.pages.map((page) => ({ ...page, referencedAttachmentIds: [] })),
    );
    expect(base.projectedV3BaseHash).toBe(
      await treeRevisionContentHashV3(base.projected),
    );
    expect(base.projectedV3BaseHash).not.toBe(base.sourceV2RevisionHash);
    expect("revision" in base.projected).toBe(false);
  });

  it("rejects unverified source content and legacy managed-image candidates", async () => {
    const source = await makeLegacySource();
    await expect(
      projectLegacyBase({
        ...source,
        pages: [{ ...source.pages[0]!, body: "changed\n" }],
      }),
    ).rejects.toThrow(/内容哈希|hash/i);
    const body = "![[photo.png]]\n";
    const withImage = {
      ...source,
      pages: [
        { ...source.pages[0]!, body, contentHash: await contentHash(body) },
      ],
    };
    withImage.revisionContentHash = await treeRevisionContentHashV2({
      protocolVersion: "2",
      spaceId: withImage.spaceId,
      folders: withImage.folders,
      pages: withImage.pages,
    });
    await expect(projectLegacyBase(withImage)).rejects.toThrow(/MODE_REFRESH/);

    const invalidBody = "![[../../../escape.png]]\n";
    const invalid = {
      ...source,
      pages: [
        {
          ...source.pages[0]!,
          body: invalidBody,
          contentHash: await contentHash(invalidBody),
        },
      ],
    };
    invalid.revisionContentHash = await treeRevisionContentHashV2({
      protocolVersion: "2",
      spaceId: invalid.spaceId,
      folders: invalid.folders,
      pages: invalid.pages,
    });
    await expect(projectLegacyBase(invalid)).rejects.toThrow(
      "LEGACY_IMAGE_REFERENCE_INVALID",
    );
  });
});

describe("fixed v3 reader", () => {
  it("reads through the real v3 adapter and verifies the published manifest", async () => {
    const source = await makeLegacySource();
    const projected = (await projectLegacyBase(source)).projected;
    const revision = "66666666-6666-4666-8666-666666666666";
    const metadata = {
      protocolVersion: "3" as const,
      spaceId: source.spaceId,
      revision,
      sequence: 2,
      revisionContentHash: await treeRevisionContentHashV3(projected),
      folderCount: "1",
      pageCount: "1",
      attachmentCount: "0",
      revisionManifestByteLength: String(canonicalBytes(projected).byteLength),
      revisionBodyBytes: String(
        new TextEncoder().encode(projected.pages[0]!.body).byteLength,
      ),
      revisionAttachmentBytes: "0",
    };
    const http = new FakeHttp();
    http.enqueue({
      status: 200,
      json: {
        ...metadata,
        folders: projected.folders,
        pages: projected.pages,
        attachments: [],
        nextCursor: null,
      },
    });
    const remote = new V3TreeRemote(
      new AgentWikiClient("https://wiki.example.com", http, () => "test"),
      source.spaceId,
      {
        version: "3",
        capabilities: V3_CAPABILITIES,
        capabilitiesHash: await treeCapabilitiesHashV3(V3_CAPABILITIES),
      },
      { sleep: async () => undefined },
    );
    await expect(
      readTreeSnapshotV3(remote, source.spaceId, revision),
    ).resolves.toEqual({
      ...projected,
      revision,
      revisionContentHash: metadata.revisionContentHash,
    });
  });
});
