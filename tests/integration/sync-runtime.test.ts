import { describe, expect, it } from "vitest";
import { SyncRuntime } from "../../src/application/sync-runtime";
import { contentHash } from "../../src/agentwiki/protocol";
import { FakeTreeRemote } from "../fakes/fake-tree-remote";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { MemoryVault } from "../fakes/memory-vault";
import { BaselineRepository } from "../../src/storage/baseline";
import { TreeBaselineRepository } from "../../src/storage/tree-baseline";
import type { TreeFolder, TreePage } from "../../src/core/tree-model";

function folder(
  folderId: string,
  parentFolderId: string | null,
  path: string,
  overrides: Partial<TreeFolder> = {},
): TreeFolder {
  return {
    folderId,
    parentFolderId,
    name: path.split("/").at(-1) ?? "Folder",
    path,
    sortOrder: 0,
    updatedAt: "2026-08-29T00:00:00Z",
    ...overrides,
  };
}

async function page(
  pageId: string,
  path: string,
  body: string,
  overrides: Partial<TreePage> = {},
): Promise<TreePage> {
  const name = path.split("/").at(-1) ?? "Page";
  return {
    pageId,
    folderId: null,
    path,
    title: name.slice(0, name.lastIndexOf(".")),
    body,
    contentHash: await contentHash(body),
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

const mapping = (status: "pending" | "active" = "pending") => ({
  spaceId: "space",
  rootPath: "Wiki",
  status,
});

describe("SyncRuntime", () => {
  it("pulls, moves, pushes, and re-pulls an empty folder tree", async () => {
    const remote = new FakeTreeRemote();
    await remote.seedTree({
      folders: [folder("f1", null, "pages/A")],
      pages: [],
    });
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    expect(vault.hasDirectory("Wiki/pages/A")).toBe(true);
    await vault.rename("Wiki/pages/A", "Wiki/pages/B");
    await runtime.applyPush(await runtime.previewPush());
    expect(remote.tree().folders[0]?.path).toBe("pages/B");
    await runtime.applyPull(await runtime.previewPull());
    expect(remote.tree().folders[0]?.path).toBe("pages/B");
  });

  it("reports remote delta items since the base revision", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/Guide.md", "hello")]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());

    const clean = await runtime.remoteDelta();
    expect(clean.ahead).toBe(false);
    expect(clean.items).toHaveLength(0);

    await remote.replace([await page("p1", "pages/Guide.md", "hello v2")]);
    const ahead = await runtime.remoteDelta();
    expect(ahead.ahead).toBe(true);
    expect(ahead.listed).toBe(true);
    expect(ahead.items).toHaveLength(1);
    expect(ahead.items[0]).toMatchObject({
      operation: "upsert_page",
      page: { path: "pages/Guide.md" },
    });
  });

  it("clones a pending remote mapping, then reports clean", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/Guide.md", "hello")]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    const preview = await runtime.previewPull();
    await runtime.applyPull(preview);
    expect(vault.text("Wiki/pages/Guide.md")).toBe("hello");
    expect((await runtime.status()).local.added).toHaveLength(0);
  });

  it("previews and pushes local edits only after explicit apply", async () => {
    const remote = new FakeTreeRemote();
    const vault = new MemoryVault({ "Wiki/pages/New.md": "new" });
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.establishEmptyBase();
    const preview = await runtime.previewPush();
    expect(preview.changes).toHaveLength(1);
    expect((await remote.snapshot()).items).toHaveLength(0);
    await runtime.applyPush(preview);
    expect((await remote.snapshot()).items[0]?.body).toBe("new");
  });

  it("first-publishes local content from a relation-only nonzero remote head", async () => {
    const remote = new FakeTreeRemote();
    await remote.advanceEmptyRevision();
    const vault = new MemoryVault({ "Wiki/pages/New.md": "new" });
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    const preview = await runtime.previewPush();
    expect(preview.baseRevision).toBe("1");
    expect(preview.changes).toHaveLength(1);
    await runtime.applyPush(preview);
    expect((await remote.snapshot()).items[0]?.body).toBe("new");
  });

  it("requires initial Pull before pending local content can be pushed over remote pages", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/Remote.md", "remote")]);
    const runtime = new SyncRuntime(
      new MemoryVault({ "Wiki/pages/Local.md": "local" }),
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await expect(runtime.previewPush()).rejects.toThrow(
      /INITIAL_PULL_REQUIRED/,
    );
  });

  it("three-way merges non-overlapping local and remote edits", async () => {
    const remote = new FakeTreeRemote();
    const original = "top\nmiddle\nbottom";
    await remote.seed([await page("p1", "pages/Guide.md", original)]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    await vault.write(
      "Wiki/pages/Guide.md",
      new TextEncoder().encode("TOP\nmiddle\nbottom"),
    );
    const remoteEdit = "top\nmiddle\nBOTTOM";
    await remote.replace([await page("p1", "pages/Guide.md", remoteEdit)]);
    const preview = await runtime.previewPull();
    expect(preview.pageConflicts).toHaveLength(0);
    expect(preview.actions[0]).toMatchObject({ kind: "write_page" });
    await runtime.applyPull(preview);
    expect(vault.text("Wiki/pages/Guide.md")).toBe("TOP\nmiddle\nBOTTOM");
    expect((await runtime.status()).local.modified).toHaveLength(1);
  });

  it("blocks Pull application until structured conflicts are resolved", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/A.md", "same")]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    await vault.write("Wiki/pages/A.md", new TextEncoder().encode("local"));
    await remote.replace([await page("p1", "pages/A.md", "remote")]);
    const preview = await runtime.previewPull();
    expect(preview.pageConflicts).toHaveLength(1);
    expect(preview.pageConflicts[0]).toMatchObject({
      base: "same",
      local: "local",
      remote: "remote",
    });
    await expect(runtime.applyPull(preview)).rejects.toThrow(/冲突/);
    preview.pageConflictResolutions[preview.pageConflicts[0]!.conflictId] = {
      choice: "remote",
    };
    await runtime.applyPull(preview);
    expect(vault.text("Wiki/pages/A.md")).toBe("remote");
  });

  it("treats remote archive versus local edit as a conflict", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/A.md", "base")]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    await vault.write(
      "Wiki/pages/A.md",
      new TextEncoder().encode("local edit"),
    );
    await remote.replace([]);
    const preview = await runtime.previewPull();
    expect(preview.pageConflicts).toHaveLength(1);
    expect(preview.actions).toHaveLength(0);
  });

  it("preserves the archived page identity when Local is chosen for an archive conflict", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/A.md", "base")]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    await vault.write("Wiki/pages/A.md", new TextEncoder().encode("local"));
    await remote.replace([]);
    const preview = await runtime.previewPull();
    preview.pageConflictResolutions[preview.pageConflicts[0]!.conflictId] = {
      choice: "local",
    };
    await runtime.applyPull(preview);
    expect(vault.text("Wiki/pages/A.md")).toBe("local");
    expect((await runtime.status()).local.deleted).toHaveLength(0);
  });

  it("keeps the local file with manual content when Manual is chosen for an archive conflict", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/A.md", "base")]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    await vault.write("Wiki/pages/A.md", new TextEncoder().encode("local"));
    await remote.replace([]);
    const preview = await runtime.previewPull();
    preview.pageConflictResolutions[preview.pageConflicts[0]!.conflictId] = {
      choice: "manual",
      manualValue: "manual final",
    };
    await runtime.applyPull(preview);
    expect(vault.text("Wiki/pages/A.md")).toBe("manual final");
  });

  it("moves the existing page when the remote renames the same pageId", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/Old.md", "body")]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    await remote.replace([await page("p1", "pages/New.md", "body")]);
    const preview = await runtime.previewPull();
    expect(preview.actions[0]).toMatchObject({
      kind: "move_page",
      fromPath: "pages/Old.md",
      path: "pages/New.md",
    });
    await runtime.applyPull(preview);
    expect(vault.exists("Wiki/pages/Old.md")).toBe(false);
    expect(vault.text("Wiki/pages/New.md")).toBe("body");
  });

  it("returns clean without creating an empty push session", async () => {
    const remote = new FakeTreeRemote();
    const runtime = new SyncRuntime(
      new MemoryVault({}),
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.establishEmptyBase();
    const preview = await runtime.previewPush();
    expect(preview.changes).toHaveLength(0);
    await runtime.applyPush(preview);
    expect(remote.sessionCount()).toBe(0);
  });

  it("imports the v1 baseline only after confirmation", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/A.md", "base")]);
    const vault = new MemoryVault({ "Wiki/pages/A.md": "base" });
    const control = new MemoryControlStore();
    const root = ".agentwiki/devices/d-local/spaces/s-space";
    const treeBaseline = new TreeBaselineRepository(
      control,
      root,
      "space",
      "Wiki",
    );
    const legacyBaseline = new BaselineRepository(
      control,
      root,
      "space",
      "Wiki",
    );
    await legacyBaseline.prepare(
      "1",
      [await page("p1", "pages/A.md", "base")],
      "pull",
    );
    await legacyBaseline.commit();
    const runtime = new SyncRuntime(vault, control, remote, mapping());
    expect(await treeBaseline.readOptional()).toBeNull();
    const preview = await runtime.previewPull();
    expect(await treeBaseline.readOptional()).toBeNull();
    await runtime.applyPull(preview);
    expect((await treeBaseline.read()).protocolVersion).toBe("2");
    expect((await legacyBaseline.read()).revision).toBe("1");
  });

  it("blocks a missing mapping root without deleting the mapping", async () => {
    const remote = new FakeTreeRemote();
    const vault = new MemoryVault({});
    vault.setRootStatus("missing");
    const m = mapping("active");
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, m);
    await expect(runtime.status()).rejects.toThrow("MAPPING_ROOT_MISSING");
    expect(m).toEqual({ spaceId: "space", rootPath: "Wiki", status: "active" });
  });

  it("blocks a file used as the mapping root without deleting the mapping", async () => {
    const remote = new FakeTreeRemote();
    const vault = new MemoryVault({});
    vault.setRootStatus("file");
    const m = mapping("pending");
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, m);
    await expect(runtime.previewPush()).rejects.toThrow(
      "MAPPING_ROOT_NOT_DIRECTORY",
    );
    expect(m).toEqual({
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
  });
});
