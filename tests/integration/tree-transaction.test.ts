import { describe, expect, it } from "vitest";

import { TreeTransaction } from "../../src/application/tree-transaction";
import type { TreePullAction } from "../../src/core/merge";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { MemoryVault } from "../fakes/memory-vault";

function folderPlan(): TreePullAction[] {
  return [
    { kind: "create_directory", folderId: "f-new", path: "pages/New" },
    {
      kind: "move_directory",
      folderId: "f-old",
      fromPath: "pages/Old",
      path: "pages/New/Old",
    },
    {
      kind: "create_page",
      pageId: "p-new",
      path: "pages/New/Old/New.md",
      bodyPath: "tree-preview-body/page-new.md",
    },
    {
      kind: "write_page",
      pageId: "p-existing",
      path: "pages/Existing.md",
      bodyPath: "tree-preview-body/page-existing.md",
    },
    { kind: "trash_page", pageId: "p-gone", path: "pages/Gone.md" },
  ];
}

function initialVault(): MemoryVault {
  return new MemoryVault({
    "pages/Old/A.md": "a",
    "pages/Old/Sub/B.md": "b",
    "pages/Existing.md": "old existing",
    "pages/Gone.md": "gone",
  });
}

function seededControl(): MemoryControlStore {
  const control = new MemoryControlStore();
  control.files.set("tree-preview-body/page-new.md", "new page");
  control.files.set("tree-preview-body/page-existing.md", "updated");
  return control;
}

describe("TreeTransaction", () => {
  it.each([0, 1, 2, 3, 4, 5])(
    "recovers a folder/page plan after fault %s",
    async (fault) => {
      const vault = initialVault();
      const control = seededControl();
      const tx = new TreeTransaction(vault, control, ".agentwiki/tx/tree");
      await tx.prepare({
        baseRevision: "base",
        targetRevision: "target",
        targetTreeHash: "0".repeat(64),
        actions: folderPlan(),
      });

      vault.failAfterOperations = fault;
      await expect(tx.apply()).rejects.toThrow();
      vault.failAfterOperations = null;
      await tx.recover();

      expect(["committed", "rolled_back"]).toContain(
        (await tx.inspect())?.state,
      );
      expect(vault.hasUnexpectedTemporaryPaths()).toBe(false);
      expect(vault.text("pages/Old/A.md")).toBe("a");
      expect(vault.text("pages/Old/Sub/B.md")).toBe("b");
      expect(vault.text("pages/Existing.md")).toBe("old existing");
      expect(vault.text("pages/Gone.md")).toBe("gone");
      expect(vault.exists("pages/New/Old/New.md")).toBe(false);
      expect(vault.folders.has("pages/New")).toBe(false);
    },
  );

  it("stops ambiguous instead of overwriting a post-interruption edit", async () => {
    const vault = new MemoryVault({ "pages/Existing.md": "old existing" });
    const control = new MemoryControlStore();
    control.files.set("tree-preview-body/page-existing.md", "updated");
    const tx = new TreeTransaction(vault, control, ".agentwiki/tx/ambiguous");
    await tx.prepare({
      baseRevision: "base",
      targetRevision: "target",
      targetTreeHash: "0".repeat(64),
      actions: [
        {
          kind: "write_page",
          pageId: "p-existing",
          path: "pages/Existing.md",
          bodyPath: "tree-preview-body/page-existing.md",
        },
        { kind: "create_directory", folderId: "f-extra", path: "pages/Extra" },
      ],
    });

    vault.failAfterOperations = 2;
    await expect(tx.apply()).rejects.toThrow();
    vault.failAfterOperations = null;
    await vault.write(
      "pages/Existing.md",
      new TextEncoder().encode("user content"),
    );

    await expect(tx.recover()).rejects.toThrow(/AMBIGUOUS|不明确|未记录/);
    expect((await tx.inspect())?.state).toBe("ambiguous");
    expect(vault.text("pages/Existing.md")).toBe("user content");
  });

  it("applies a page move and a directory trash to the target tree", async () => {
    const vault = new MemoryVault({
      "pages/A.md": "moved",
      "pages/Doomed/Inner.md": "inner",
    });
    const control = new MemoryControlStore();
    control.files.set("tree-preview-body/page-moved.md", "moved-new");
    const tx = new TreeTransaction(vault, control, ".agentwiki/tx/move-trash");
    await tx.prepare({
      baseRevision: "base",
      targetRevision: "target",
      targetTreeHash: "0".repeat(64),
      actions: [
        {
          kind: "move_page",
          pageId: "p-a",
          fromPath: "pages/A.md",
          path: "pages/B.md",
          bodyPath: "tree-preview-body/page-moved.md",
        },
        { kind: "trash_directory", folderId: "f-doomed", path: "pages/Doomed" },
      ],
    });

    await tx.apply();
    expect(vault.text("pages/B.md")).toBe("moved-new");
    expect(vault.exists("pages/A.md")).toBe(false);
    expect(vault.folders.has("pages/Doomed")).toBe(false);
    expect((await tx.inspect())?.state).toBe("committed");
  });

  it("rolls back an applied page move and directory trash from before images", async () => {
    const vault = new MemoryVault({
      "pages/A.md": "moved",
      "pages/Doomed/Inner.md": "inner",
    });
    const control = new MemoryControlStore();
    control.files.set("tree-preview-body/page-moved.md", "moved-new");
    const tx = new TreeTransaction(
      vault,
      control,
      ".agentwiki/tx/move-trash-rollback",
    );
    await tx.prepare({
      baseRevision: "base",
      targetRevision: "target",
      targetTreeHash: "0".repeat(64),
      actions: [
        {
          kind: "move_page",
          pageId: "p-a",
          fromPath: "pages/A.md",
          path: "pages/B.md",
          bodyPath: "tree-preview-body/page-moved.md",
        },
        { kind: "trash_directory", folderId: "f-doomed", path: "pages/Doomed" },
        { kind: "create_directory", folderId: "f-extra", path: "pages/Extra" },
      ],
    });

    vault.failAfterOperations = 4;
    await expect(tx.apply()).rejects.toThrow();
    vault.failAfterOperations = null;
    await tx.recover();

    expect((await tx.inspect())?.state).toBe("rolled_back");
    expect(vault.text("pages/A.md")).toBe("moved");
    expect(vault.exists("pages/B.md")).toBe(false);
    expect(vault.text("pages/Doomed/Inner.md")).toBe("inner");
    expect(vault.folders.has("pages/Extra")).toBe(false);
    expect(vault.hasUnexpectedTemporaryPaths()).toBe(false);
  });
});
