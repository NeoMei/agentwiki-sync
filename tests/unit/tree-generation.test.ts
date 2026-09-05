import { describe, expect, it } from "vitest";

import { canonicalBytes, contentHash } from "../../src/agentwiki/protocol";
import type {
  TreeAttachment,
  TreeFolder,
  TreePage,
  TreePageV3,
} from "../../src/core/tree-model";
import {
  TreeGenerationRepository,
  type TreeGenerationManifestV2,
  type TreeGenerationManifestV3,
} from "../../src/storage/tree-generation";
import { StorageMigration } from "../../src/storage/migration";
import { MemoryControlStore } from "../fakes/memory-control-store";

function folder(
  folderId: string,
  parentFolderId: string | null,
  path: string,
): TreeFolder {
  return {
    folderId,
    parentFolderId,
    name: path.split("/").at(-1) ?? "Folder",
    path,
    sortOrder: 0,
    updatedAt: "2026-08-29T00:00:00Z",
  };
}

type PageMetadata = Omit<TreePage, "body">;
type PageMetadataV3 = Omit<TreePageV3, "body">;

function page(
  pageId: string,
  folderId: string | null,
  path: string,
): PageMetadata {
  const name = path.split("/").at(-1) ?? "Page";
  return {
    pageId,
    folderId,
    path,
    title: name.slice(0, name.lastIndexOf(".")),
    contentHash: "0".repeat(64),
    updatedAt: "2026-08-29T00:00:00Z",
  };
}

function pageV3(
  pageId: string,
  folderId: string | null,
  path: string,
  attachmentIds: string[],
): PageMetadataV3 {
  return {
    ...page(pageId, folderId, path),
    referencedAttachmentIds: attachmentIds,
  };
}

function attachment(
  attachmentId: string,
  path: string,
  sizeBytes = "4",
): TreeAttachment {
  return {
    attachmentId,
    path,
    mimeType: "image/png",
    sizeBytes,
    width: 1,
    height: 1,
    contentHash: "a".repeat(64),
    updatedAt: "2026-08-29T00:00:00Z",
  };
}

function makeManifest(
  overrides: Partial<TreeGenerationManifestV2> = {},
): TreeGenerationManifestV2 {
  return {
    schemaVersion: 2,
    protocolVersion: "2",
    generationId: "g1",
    spaceId: "space-1",
    rootPath: "Wiki",
    baseRevision: "rev-1",
    baseRevisionContentHash: "",
    baseFolderCount: 0,
    basePageCount: 0,
    baseRevisionManifestByteLength: 0,
    baseRevisionBodyBytes: 0,
    lastSuccessfulSyncAt: "2026-08-29T00:00:00.000Z",
    folders: {},
    pages: {},
    ...overrides,
  };
}

function makeManifestV3(
  overrides: Partial<TreeGenerationManifestV3> = {},
): TreeGenerationManifestV3 {
  return {
    schemaVersion: 3,
    protocolVersion: "3",
    generationId: "g3",
    spaceId: "space-1",
    rootPath: "Wiki",
    baseRevision: "rev-3",
    baseRevisionContentHash: "0".repeat(64),
    baseFolderCount: 0,
    basePageCount: 0,
    baseAttachmentCount: 0,
    baseRevisionManifestByteLength: canonicalBytes({
      protocolVersion: "3",
      spaceId: "space-1",
      folders: [],
      pages: [],
      attachments: [],
    }).byteLength,
    baseRevisionBodyBytes: 0,
    baseRevisionAttachmentBytes: 0,
    lastSuccessfulSyncAt: "2026-08-29T00:00:00.000Z",
    folders: {},
    pages: {},
    attachments: {},
    ...overrides,
  };
}

describe("v2 tree generations", () => {
  it("round-trips an empty folder in a v2 generation", async () => {
    const store = new MemoryControlStore();
    const repository = new TreeGenerationRepository(
      store,
      ".agentwiki/device/tree-v2",
    );
    await repository.write(
      makeManifest({ folders: { f1: folder("f1", null, "pages/Empty") } }),
      {},
    );

    const manifest = await repository.readManifest("g1");
    expect(manifest.folders.f1?.path).toBe("pages/Empty");
    expect(manifest.baseFolderCount).toBe(1);
    expect(manifest.basePageCount).toBe(0);
  });

  it("keeps page bodies in separate readable control files", async () => {
    const store = new MemoryControlStore();
    const repository = new TreeGenerationRepository(
      store,
      ".agentwiki/device/tree-v2",
    );
    const body = "# hello";
    await repository.write(
      makeManifest({
        folders: { f1: folder("f1", null, "pages/Guide") },
        pages: { p1: page("p1", "f1", "pages/Guide/A.md") },
      }),
      { p1: body },
    );

    const manifest = await repository.readManifest("g1");
    expect(manifest.pages.p1).not.toHaveProperty("body");
    await expect(
      store.read(
        ".agentwiki/device/tree-v2/generations/g1/base/pages/Guide/A.md",
      ),
    ).resolves.toBe(body);
    await expect(
      repository.readBody("g1", "p1", await contentHash(body)),
    ).resolves.toBe(body);
  });

  it("rejects a future manifest schema", async () => {
    const store = new MemoryControlStore();
    const repository = new TreeGenerationRepository(
      store,
      ".agentwiki/device/tree-v2",
    );
    await store.write(
      ".agentwiki/device/tree-v2/generations/g-future/manifest.json",
      JSON.stringify({ schemaVersion: 4 }),
    );
    await expect(repository.verify("g-future")).rejects.toThrow(/schema|版本/);
  });

  it("rejects a tampered page body", async () => {
    const store = new MemoryControlStore();
    const repository = new TreeGenerationRepository(
      store,
      ".agentwiki/device/tree-v2",
    );
    await repository.write(
      makeManifest({ pages: { p1: page("p1", null, "pages/A.md") } }),
      { p1: "# original" },
    );
    await store.write(
      ".agentwiki/device/tree-v2/generations/g1/base/pages/A.md",
      "# tampered",
    );
    await expect(repository.verify("g1")).rejects.toThrow(/损坏/);
  });
});

describe("v3 tree generations", () => {
  it("rejects a future v3 generation schema", async () => {
    const store = new MemoryControlStore();
    const repository = new TreeGenerationRepository(
      store,
      ".agentwiki/device/tree-v2",
    );
    await store.write(
      ".agentwiki/device/tree-v2/generations/g-future/manifest.json",
      JSON.stringify({ schemaVersion: 4 }),
    );
    await expect(repository.verify("g-future")).rejects.toThrow(
      "Unknown tree generation schema version",
    );
  });

  it("does not let startup migration reinterpret a future generation", async () => {
    const store = new MemoryControlStore();
    await store.write(
      ".agentwiki/device/tree-v2/generations/g-future/manifest.json",
      JSON.stringify({ schemaVersion: 4, pages: {} }),
    );
    const result = await new StorageMigration(store).migrateGeneration(
      ".agentwiki/device/tree-v2",
      "g-future",
    );
    expect(result.errors).toEqual([
      "Unknown tree generation schema version: 4",
    ]);
  });

  it("persists only v3 metadata and verifies the caller authority hash and metrics", async () => {
    const store = new MemoryControlStore();
    const repository = new TreeGenerationRepository(
      store,
      ".agentwiki/device/tree-v2",
    );
    const body = "# image\n\n![[assets/a.png]]";
    const image = attachment("a1", "assets/a.png");
    const pageMetadata = {
      ...pageV3("p1", null, "pages/A.md", ["a1"]),
      contentHash: await contentHash(body),
    };
    const authoritative = await repository.metricsV3({
      spaceId: "space-1",
      folders: {},
      pages: { p1: pageMetadata },
      attachments: { a1: image },
      bodies: { p1: body },
    });
    const manifest = await repository.write(
      makeManifestV3({
        pages: { p1: pageMetadata },
        attachments: { a1: image },
        baseRevisionContentHash: authoritative.contentHash,
        baseFolderCount: authoritative.folderCount,
        basePageCount: authoritative.pageCount,
        baseAttachmentCount: authoritative.attachmentCount,
        baseRevisionManifestByteLength: authoritative.manifestByteLength,
        baseRevisionBodyBytes: authoritative.bodyBytes,
        baseRevisionAttachmentBytes: authoritative.attachmentBytes,
      }),
      { p1: body },
    );

    expect(manifest.protocolVersion).toBe("3");
    expect(manifest.pages.p1).not.toHaveProperty("body");
    expect(manifest.attachments.a1).toEqual(image);
    expect(
      [...store.binaryFiles.keys()].filter((path) => path.includes("g3")),
    ).toEqual([]);

    await expect(
      repository.write(
        {
          ...manifest,
          generationId: "g-tampered",
          baseRevisionContentHash: "f".repeat(64),
        },
        { p1: body },
      ),
    ).rejects.toThrow(/authority|hash|metrics/i);
  });

  it("rejects an attachment identity mismatch and a missing page reference", async () => {
    const store = new MemoryControlStore();
    const repository = new TreeGenerationRepository(
      store,
      ".agentwiki/device/tree-v2",
    );
    const body = "# image";
    const image = attachment("a1", "assets/a.png");
    const metadata = {
      ...pageV3("p1", null, "pages/A.md", ["missing"]),
      contentHash: await contentHash(body),
    };
    const metrics = await repository
      .metricsV3({
        spaceId: "space-1",
        folders: {},
        pages: { p1: metadata },
        attachments: { a1: image },
        bodies: { p1: body },
      })
      .catch(() => null);
    expect(metrics).toBeNull();
  });
});
