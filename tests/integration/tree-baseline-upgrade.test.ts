import { describe, expect, it } from "vitest";

import { contentHash } from "../../src/agentwiki/protocol";
import type {
  TreeAttachment,
  TreeFolder,
  TreeSnapshot,
  TreeSnapshotV3,
} from "../../src/core/tree-model";
import { BaselineRepository } from "../../src/storage/baseline";
import { MutableControlRepository } from "../../src/storage/envelope";
import {
  isCurrentPointerPayload,
  type CurrentPointerPayload,
} from "../../src/storage/pointer";
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

function snapshotV3(overrides: Partial<TreeSnapshotV3> = {}): TreeSnapshotV3 {
  return {
    protocolVersion: "3",
    spaceId: "space-1",
    revision: "rev-3",
    revisionContentHash: "0".repeat(64),
    folders: [],
    pages: [],
    attachments: [],
    ...overrides,
  };
}

function attachment(): TreeAttachment {
  return {
    attachmentId: "a1",
    path: "assets/a.png",
    mimeType: "image/png",
    sizeBytes: "4",
    width: 1,
    height: 1,
    contentHash: "a".repeat(64),
    updatedAt: "2026-09-04T00:00:00Z",
  };
}

describe("v2 tree baseline upgrade", () => {
  it("does not require a newer protocol before a tree baseline exists", async () => {
    const repository = new TreeBaselineRepository(
      new MemoryControlStore(),
      ROOT,
      "space-1",
      "Wiki/Nested",
    );

    await expect(repository.requiredProtocolVersion()).resolves.toBe("1");
  });

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
      JSON.stringify({ schemaVersion: 4 }),
    );
    await expect(repository.read()).rejects.toThrow(/schema|版本/);
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

  it("keeps the verified v2 pointer when a confirmed v3 pull is interrupted", async () => {
    const store = new MemoryControlStore();
    const repository = new TreeBaselineRepository(
      store,
      ROOT,
      "space-1",
      "Wiki",
    );
    await repository.prepare(snapshot(), "initialize");
    await repository.commit();
    const old = await repository.read();

    const v3 = snapshotV3();
    v3.revisionContentHash = await repository.revisionContentHashV3(v3);
    await repository.prepare(v3, "pull");
    expect((await repository.read()).generationId).toBe(old.generationId);
    await repository.recover(null);
    expect((await repository.read()).generationId).toBe(old.generationId);
    expect(await repository.requiredProtocolVersion()).toBe("2");
  });

  it("ignores a higher new pointer while the committing checkpoint is unverified", async () => {
    const store = new MemoryControlStore();
    const repository = new TreeBaselineRepository(
      store,
      ROOT,
      "space-1",
      "Wiki",
    );
    await repository.prepare(snapshot({ revision: "rev-old" }), "initialize");
    await repository.commit();
    const old = await repository.read();
    const prepared = await repository.prepare(
      snapshot({ revision: "rev-new" }),
      "pull",
    );
    await repository.setPhase("committing");
    const manifestRaw = await store.read(
      `${ROOT}/tree-v2/generations/${prepared.newGenerationId}/manifest.json`,
    );
    const pointer = new MutableControlRepository<CurrentPointerPayload>(
      store,
      `${ROOT}/tree-v2/current.json`,
      isCurrentPointerPayload,
    );
    await pointer.write({
      schemaVersion: 1,
      active: true,
      generationId: prepared.newGenerationId,
      manifestHash: await contentHash(manifestRaw ?? ""),
    });

    expect((await repository.read()).generationId).toBe(old.generationId);
    expect((await pointer.candidates()).length).toBeGreaterThan(1);
  });

  it("switches to v3 only after verification and then requires protocol 3", async () => {
    const store = new MemoryControlStore();
    const repository = new TreeBaselineRepository(
      store,
      ROOT,
      "space-1",
      "Wiki",
    );
    await repository.prepare(snapshot(), "initialize");
    await repository.commit();
    const image = attachment();
    const body = "# image\n\n![[assets/a.png]]";
    const v3 = snapshotV3({
      pages: [
        {
          pageId: "p1",
          folderId: null,
          path: "pages/A.md",
          title: "A",
          body,
          contentHash: await contentHash(body),
          updatedAt: "2026-09-04T00:00:00Z",
          referencedAttachmentIds: ["a1"],
        },
      ],
      attachments: [image],
    });
    v3.revisionContentHash = await repository.revisionContentHashV3(v3);
    await repository.prepare(v3, "pull");
    await repository.commit();
    const current = await repository.read();
    expect(current.protocolVersion).toBe("3");
    expect(
      current.schemaVersion === 3 ? current.baseAttachmentCount : undefined,
    ).toBe(1);
    expect(await repository.requiredProtocolVersion()).toBe("3");
  });

  it("does not bootstrap v3 from an unconfirmed push", async () => {
    const store = new MemoryControlStore();
    const repository = new TreeBaselineRepository(
      store,
      ROOT,
      "space-1",
      "Wiki",
    );
    const v3 = snapshotV3();
    v3.revisionContentHash = await repository.revisionContentHashV3(v3);
    await expect(repository.prepare(v3, "push")).rejects.toThrow(
      /bootstrap|Pull/i,
    );
    await expect(repository.readOptional()).resolves.toBeNull();
  });
});
