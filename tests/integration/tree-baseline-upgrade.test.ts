import { describe, expect, it } from "vitest";

import { contentHash } from "../../src/agentwiki/protocol";
import type { TreeFolder, TreeSnapshot } from "../../src/core/tree-model";
import { BaselineRepository } from "../../src/storage/baseline";
import { TreeBaselineRepository } from "../../src/storage/tree-baseline";
import { MemoryControlStore } from "../fakes/memory-control-store";

const ROOT = ".agentwiki/devices/d-local/spaces/s-space";

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

function snapshot(overrides: Partial<TreeSnapshot> = {}): TreeSnapshot {
  return {
    protocolVersion: "2",
    spaceId: "space-1",
    revision: "rev-1",
    revisionContentHash: "0".repeat(64),
    folders: [],
    pages: [],
    ...overrides,
  };
}

describe("v2 tree baseline upgrade", () => {
  it("round-trips an empty folder in a v2 generation", async () => {
    const store = new MemoryControlStore();
    const repository = new TreeBaselineRepository(
      store,
      ROOT,
      "space-1",
      "Wiki",
    );
    await repository.prepare(
      snapshot({ folders: [folder("f1", null, "pages/Empty")], pages: [] }),
      "initialize",
    );
    await repository.commit();

    const manifest = await repository.read();
    expect(manifest.folders.f1?.path).toBe("pages/Empty");
    expect(manifest.protocolVersion).toBe("2");
    expect(manifest.baseFolderCount).toBe(1);
    expect(manifest.basePageCount).toBe(0);
  });

  it("rejects a future manifest schema on read", async () => {
    const store = new MemoryControlStore();
    const repository = new TreeBaselineRepository(
      store,
      ROOT,
      "space-1",
      "Wiki",
    );
    const journal = await repository.prepare(
      snapshot({ folders: [folder("f1", null, "pages/Empty")], pages: [] }),
      "initialize",
    );
    await repository.commit();

    await store.write(
      `${ROOT}/tree-v2/generations/${journal.newGenerationId}/manifest.json`,
      JSON.stringify({ schemaVersion: 3 }),
    );
    await expect(repository.read()).rejects.toThrow(/更新|版本/);
  });

  it("returns null legacy evidence for an empty v1 baseline", async () => {
    const store = new MemoryControlStore();
    const legacy = new BaselineRepository(store, ROOT, "space-1", "Wiki");
    const repository = new TreeBaselineRepository(
      store,
      ROOT,
      "space-1",
      "Wiki",
    );

    await expect(repository.readLegacyEvidence(legacy)).resolves.toBeNull();
  });

  it("converts v1 pages into zero-folder legacy evidence without activating the v2 pointer", async () => {
    const store = new MemoryControlStore();
    const legacy = new BaselineRepository(store, ROOT, "space-1", "Wiki");
    const repository = new TreeBaselineRepository(
      store,
      ROOT,
      "space-1",
      "Wiki",
    );
    const body = "# old";
    await legacy.prepare(
      "rev-1",
      [
        {
          pageId: "p1",
          path: "Notes/A.md",
          title: "A",
          body,
          contentHash: await contentHash(body),
          updatedAt: "2026-08-29T00:00:00Z",
        },
      ],
      "pull",
    );
    await legacy.commit();

    const evidence = await repository.readLegacyEvidence(legacy);
    expect(evidence).not.toBeNull();
    expect(evidence?.protocolVersion).toBe("1");
    expect(evidence?.folders).toEqual([]);
    expect(evidence?.pages).toHaveLength(1);
    expect(evidence?.pages[0]?.folderId).toBeNull();
    expect(evidence?.pages[0]?.path).toBe("Notes/A.md");
    expect(evidence?.pages[0]?.body).toBe(body);
    await expect(repository.readOptional()).resolves.toBeNull();
  });

  it("rolls back a prepared but uncommitted transaction", async () => {
    const store = new MemoryControlStore();
    const repository = new TreeBaselineRepository(
      store,
      ROOT,
      "space-1",
      "Wiki",
    );
    await repository.prepare(
      snapshot({ folders: [folder("f1", null, "pages/Empty")], pages: [] }),
      "pull",
    );
    await expect(repository.readOptional()).resolves.toBeNull();

    await repository.recover(null);
    await expect(repository.readOptional()).resolves.toBeNull();
    const raw = await store.read(`${ROOT}/tree-v2/baseline-journal.json`);
    const journal = JSON.parse(raw ?? "{}") as {
      payload?: { phase?: string };
    };
    expect(journal.payload?.phase).toBe("rolled_back");
  });
});
