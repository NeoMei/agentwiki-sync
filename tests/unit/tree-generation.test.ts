import { describe, expect, it } from "vitest";

import { contentHash } from "../../src/agentwiki/protocol";
import type { TreeFolder, TreePage } from "../../src/core/tree-model";
import {
  TreeGenerationRepository,
  type TreeGenerationManifestV2,
} from "../../src/storage/tree-generation";
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
      JSON.stringify({ schemaVersion: 3 }),
    );
    await expect(repository.verify("g-future")).rejects.toThrow(/更新|版本/);
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
