import { describe, expect, it } from "vitest";

import {
  canonicalBytes,
  contentHash,
  sha256Hex,
} from "../../src/agentwiki/protocol";
import { buildTreePullPreview } from "../../src/application/tree-diff";
import { TreeTransaction } from "../../src/application/tree-transaction";
import { sortTreePullActions } from "../../src/application/tree-preview";
import type { TreePullAction, TreePullActionV3 } from "../../src/core/merge";
import type {
  TreeFolder,
  TreePage,
  TreeSnapshot,
} from "../../src/core/tree-model";
import type { LocalTreeScan } from "../../src/core/tree-scan";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { MemoryVault } from "../fakes/memory-vault";

const IMAGE_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function attachmentAction(
  kind: "create_attachment" | "write_attachment",
  path: string,
): Promise<Extract<TreePullActionV3, { kind: typeof kind }>> {
  return {
    kind,
    attachment: {
      attachmentId: "11111111-1111-4111-8111-111111111111",
      path,
      mimeType: "image/png",
      sizeBytes: String(IMAGE_BYTES.byteLength),
      width: 1,
      height: 1,
      contentHash: await sha256Hex(IMAGE_BYTES),
      updatedAt: "2026-09-05T00:00:00.000Z",
    },
    source: "remote",
  };
}

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

async function treePage(
  pageId: string,
  folderId: string | null,
  path: string,
  body: string,
): Promise<TreePage> {
  return {
    pageId,
    folderId,
    path,
    title: path.split("/").at(-1)?.replace(/\.md$/, "") ?? "Page",
    body,
    contentHash: await contentHash(body),
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

function localScan(folders: TreeFolder[], pages: TreePage[]): LocalTreeScan {
  return { rootPath: "Wiki", folders, pages };
}

function seedBodies(control: MemoryControlStore, pages: TreePage[]): void {
  for (const page of pages)
    control.files.set(`tree-preview-body/${page.pageId}.md`, page.body);
}

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
  it("creates the new image before rewriting markdown and removes the old path last", async () => {
    const vault = new MemoryVault({
      "Wiki/pages/note.md": "![[../assets/old.png]]",
      "Wiki/assets/old.png": "old image",
    });
    const control = new MemoryControlStore();
    control.files.set("tree-preview-body/note.md", "![[../assets/new.png]]");
    const tx = new TreeTransaction(
      vault,
      control,
      ".agentwiki/tx/attachment-order",
      async () => IMAGE_BYTES,
    );
    await tx.prepare({
      baseRevision: "base",
      targetRevision: "target",
      targetTreeHash: "0".repeat(64),
      deferCommit: true,
      actions: [
        await attachmentAction("create_attachment", "Wiki/assets/new.png"),
        {
          kind: "write_page",
          pageId: "note",
          path: "Wiki/pages/note.md",
          bodyPath: "tree-preview-body/note.md",
        },
        {
          kind: "remove_attachment_path",
          attachmentId: "11111111-1111-4111-8111-111111111111",
          path: "Wiki/assets/old.png",
        },
      ],
    });

    await tx.apply();

    expect(vault.operationLog).toEqual([
      "write:Wiki/assets/new.png",
      "write:Wiki/pages/note.md",
      "trash:Wiki/assets/old.png",
    ]);
    expect((await tx.inspect())?.state).toBe("applied");
    await tx.markCommitted();
    expect((await tx.inspect())?.state).toBe("committed");
  });

  it("does not overwrite a user edit while recovering an attachment write", async () => {
    const vault = new MemoryVault({ "Wiki/assets/image.png": "before" });
    const control = new MemoryControlStore();
    const tx = new TreeTransaction(
      vault,
      control,
      ".agentwiki/tx/attachment-user-edit",
      async () => IMAGE_BYTES,
    );
    await tx.prepare({
      baseRevision: "base",
      targetRevision: "target",
      targetTreeHash: "0".repeat(64),
      actions: [
        await attachmentAction("write_attachment", "Wiki/assets/image.png"),
        { kind: "create_directory", folderId: "next", path: "Wiki/pages/X" },
      ],
    });
    vault.failAfterOperations = 2;
    await expect(tx.apply()).rejects.toThrow();
    vault.failAfterOperations = null;
    await vault.write(
      "Wiki/assets/image.png",
      new TextEncoder().encode("user edit"),
    );

    await expect(tx.recover()).rejects.toThrow(/TREE_TRANSACTION_AMBIGUOUS/);
    expect(vault.text("Wiki/assets/image.png")).toBe("user edit");
    expect((await tx.inspect())?.state).toBe("ambiguous");
  });

  it("stores attachment before images as private binary sidecars", async () => {
    const vault = new MemoryVault({ "Wiki/assets/image.png": "before" });
    const control = new MemoryControlStore();
    const root = ".agentwiki/tx/attachment-binary-before";
    const tx = new TreeTransaction(
      vault,
      control,
      root,
      async () => IMAGE_BYTES,
    );

    await tx.prepare({
      baseRevision: "base",
      targetRevision: "target",
      targetTreeHash: "0".repeat(64),
      actions: [
        await attachmentAction("write_attachment", "Wiki/assets/image.png"),
      ],
    });

    expect(control.binaryFiles.has(`${root}/before/0-0.bin`)).toBe(true);
    expect(control.files.has(`${root}/before/0-0.bin`)).toBe(false);
  });

  it("rolls back a fully applied deferred transaction in one recovery call when final verification was not recorded", async () => {
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const root = ".agentwiki/tx/deferred-crash-before-verify";
    const tx = new TreeTransaction(
      vault,
      control,
      root,
      async () => IMAGE_BYTES,
    );
    const action = await attachmentAction(
      "create_attachment",
      "Wiki/assets/image.png",
    );
    await tx.prepare({
      baseRevision: "base",
      targetRevision: "target",
      targetTreeHash: "0".repeat(64),
      deferCommit: true,
      actions: [action],
    });
    vault.seedFile("Wiki/assets/image.png", IMAGE_BYTES);

    const journalPath = `${root}/journal.json`;
    const envelope = JSON.parse((await control.read(journalPath))!) as {
      payload: Record<string, unknown>;
      payloadHash: string;
    };
    envelope.payload = {
      ...envelope.payload,
      state: "applying",
      nextOperation: 1,
    };
    envelope.payloadHash = await sha256Hex(canonicalBytes(envelope.payload));
    control.files.set(journalPath, JSON.stringify(envelope));

    await tx.recover();

    expect((await tx.inspect())?.state).toBe("rolled_back");
    expect(vault.exists("Wiki/assets/image.png")).toBe(false);
  });

  it.each([
    ["image write", 2],
    ["Markdown write", 3],
    ["old attachment removal", 4],
  ])(
    "rolls back the full attachment/Page sequence after a fault at %s",
    async (_checkpoint, operation) => {
      const vault = new MemoryVault({
        "Wiki/pages/note.md": "![[assets/old.png]]",
        "Wiki/assets/old.png": "old image",
      });
      const control = new MemoryControlStore();
      control.files.set("tree-preview-body/note.md", "![[assets/new.png]]");
      const tx = new TreeTransaction(
        vault,
        control,
        ".agentwiki/tx/attachment-fault-" + operation,
        async () => IMAGE_BYTES,
      );
      await tx.prepare({
        baseRevision: "base",
        targetRevision: "target",
        targetTreeHash: "0".repeat(64),
        deferCommit: true,
        actions: [
          await attachmentAction("create_attachment", "Wiki/assets/new.png"),
          {
            kind: "write_page",
            pageId: "note",
            path: "Wiki/pages/note.md",
            bodyPath: "tree-preview-body/note.md",
          },
          {
            kind: "remove_attachment_path",
            attachmentId: "11111111-1111-4111-8111-111111111111",
            path: "Wiki/assets/old.png",
          },
          {
            kind: "create_directory",
            folderId: "33333333-3333-4333-8333-333333333333",
            path: "Wiki/pages/after-attachment-sequence",
          },
        ],
      });

      vault.failAfterOperations = operation;
      await expect(tx.apply()).rejects.toThrow(/injected vault failure/);
      vault.failAfterOperations = null;
      await tx.recover();

      expect((await tx.inspect())?.state).toBe("rolled_back");
      expect(vault.exists("Wiki/assets/new.png")).toBe(false);
      expect(vault.text("Wiki/pages/note.md")).toBe("![[assets/old.png]]");
      expect(vault.text("Wiki/assets/old.png")).toBe("old image");
    },
  );
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

  it("refuses to prepare a new plan over an unfinished transaction", async () => {
    const vault = initialVault();
    const control = seededControl();
    const tx = new TreeTransaction(vault, control, ".agentwiki/tx/reprepare");
    await tx.prepare({
      baseRevision: "base",
      targetRevision: "target",
      targetTreeHash: "0".repeat(64),
      actions: folderPlan(),
    });

    vault.failAfterOperations = 1;
    await expect(tx.apply()).rejects.toThrow();
    vault.failAfterOperations = null;

    await expect(
      tx.prepare({
        baseRevision: "base2",
        targetRevision: "target2",
        targetTreeHash: "0".repeat(64),
        actions: folderPlan(),
      }),
    ).rejects.toThrow(/未终结|恢复|recover/);
  });

  it("restores non-markdown files inside a trashed directory", async () => {
    const vault = new MemoryVault({
      "pages/Doomed/Inner.md": "inner",
      "pages/Doomed/image.png": "imagedata",
    });
    const control = new MemoryControlStore();
    const tx = new TreeTransaction(vault, control, ".agentwiki/tx/non-md");
    await tx.prepare({
      baseRevision: "base",
      targetRevision: "target",
      targetTreeHash: "0".repeat(64),
      actions: [
        { kind: "trash_directory", folderId: "f-doomed", path: "pages/Doomed" },
        { kind: "create_directory", folderId: "f-extra", path: "pages/Extra" },
      ],
    });

    vault.failAfterOperations = 2;
    await expect(tx.apply()).rejects.toThrow();
    vault.failAfterOperations = null;
    await tx.recover();

    expect(vault.text("pages/Doomed/Inner.md")).toBe("inner");
    expect(vault.text("pages/Doomed/image.png")).toBe("imagedata");
    expect(vault.folders.has("pages/Doomed")).toBe(true);
    expect(vault.folders.has("pages/Extra")).toBe(false);
  });

  it("orders page evacuation before directory trash", () => {
    const sorted = sortTreePullActions([
      { kind: "trash_directory", folderId: "f", path: "pages/F" },
      {
        kind: "move_page",
        pageId: "p",
        fromPath: "pages/F/P.md",
        path: "pages/G/P.md",
        bodyPath: "tree-preview-body/p.md",
      },
      { kind: "create_directory", folderId: "g", path: "pages/G" },
    ]);
    const kinds = sorted.map((action) => action.kind);
    expect(kinds.indexOf("create_directory")).toBeLessThan(
      kinds.indexOf("move_page"),
    );
    expect(kinds.indexOf("move_page")).toBeLessThan(
      kinds.indexOf("trash_directory"),
    );
  });

  it("orders a directory trash before moving another directory into its path", () => {
    const sorted = sortTreePullActions([
      {
        kind: "move_directory",
        folderId: "a",
        fromPath: "pages/A",
        path: "pages/B",
      },
      { kind: "trash_directory", folderId: "b", path: "pages/B" },
    ]);
    const kinds = sorted.map((action) => action.kind);
    expect(kinds.indexOf("trash_directory")).toBeLessThan(
      kinds.indexOf("move_directory"),
    );
  });

  it("applies and commits a folder-trash-with-page-evacuation plan", async () => {
    const vault = new MemoryVault({ "pages/F/P.md": "p" });
    const control = new MemoryControlStore();
    control.files.set("tree-preview-body/p.md", "p-moved");
    const tx = new TreeTransaction(vault, control, ".agentwiki/tx/evac");
    await tx.prepare({
      baseRevision: "base",
      targetRevision: "target",
      targetTreeHash: "0".repeat(64),
      actions: sortTreePullActions([
        { kind: "trash_directory", folderId: "f", path: "pages/F" },
        {
          kind: "move_page",
          pageId: "p",
          fromPath: "pages/F/P.md",
          path: "pages/G/P.md",
          bodyPath: "tree-preview-body/p.md",
        },
        { kind: "create_directory", folderId: "g", path: "pages/G" },
      ]),
    });

    await tx.apply();
    expect(vault.text("pages/G/P.md")).toBe("p-moved");
    expect(vault.folders.has("pages/F")).toBe(false);
    expect((await tx.inspect())?.state).toBe("committed");
  });

  it("resumes a multi-step rollback after interruption", async () => {
    const vault = new MemoryVault({
      "pages/Doomed/Inner.md": "inner",
      "pages/Doomed/Sub/X.md": "x",
    });
    const control = new MemoryControlStore();
    const tx = new TreeTransaction(
      vault,
      control,
      ".agentwiki/tx/rollback-resume",
    );
    await tx.prepare({
      baseRevision: "base",
      targetRevision: "target",
      targetTreeHash: "0".repeat(64),
      actions: [
        { kind: "trash_directory", folderId: "f-doomed", path: "pages/Doomed" },
        { kind: "create_directory", folderId: "f-extra", path: "pages/A" },
      ],
    });

    vault.failAfterOperations = 2;
    await expect(tx.apply()).rejects.toThrow();

    // Interrupt rollback after recreating the directories but before writing
    // the first file back, then resume without the fault.
    vault.failAfterOperations = 5;
    await expect(tx.recover()).rejects.toThrow();
    vault.failAfterOperations = null;

    await tx.recover();
    expect((await tx.inspect())?.state).toBe("rolled_back");
    expect(vault.text("pages/Doomed/Inner.md")).toBe("inner");
    expect(vault.text("pages/Doomed/Sub/X.md")).toBe("x");
    expect(vault.folders.has("pages/Doomed")).toBe(true);
    expect(vault.folders.has("pages/Doomed/Sub")).toBe(true);
    expect(vault.folders.has("pages/A")).toBe(false);
  });

  it("applies and commits a standard directory delete with pages", async () => {
    const base = snapshot({
      folders: [folder("d", null, "pages/D")],
      pages: [
        await treePage("p1", "d", "pages/D/P1.md", "p1"),
        await treePage("p2", "d", "pages/D/P2.md", "p2"),
      ],
    });
    const preview = await buildTreePullPreview(
      base,
      localScan(base.folders, base.pages),
      snapshot(),
    );

    const vault = new MemoryVault({
      "pages/D/P1.md": "p1",
      "pages/D/P2.md": "p2",
    });
    const control = new MemoryControlStore();
    const tx = new TreeTransaction(vault, control, ".agentwiki/tx/delete-dir");
    await tx.prepare({
      baseRevision: "base",
      targetRevision: "target",
      targetTreeHash: "0".repeat(64),
      actions: preview.actions,
    });
    await tx.apply();

    expect(vault.folders.has("pages/D")).toBe(false);
    expect(vault.exists("pages/D/P1.md")).toBe(false);
    expect(vault.exists("pages/D/P2.md")).toBe(false);
    expect((await tx.inspect())?.state).toBe("committed");
  });

  it("applies a page move and content change under a moved directory", async () => {
    const base = snapshot({
      folders: [folder("d", null, "pages/D")],
      pages: [await treePage("p", "d", "pages/D/P.md", "old")],
    });
    const remote = snapshot({
      folders: [folder("d", null, "pages/E")],
      pages: [await treePage("p", "d", "pages/E/Q.md", "new")],
    });
    const preview = await buildTreePullPreview(
      base,
      localScan(base.folders, base.pages),
      remote,
    );

    const vault = new MemoryVault({ "pages/D/P.md": "old" });
    const control = new MemoryControlStore();
    seedBodies(control, preview.resolvedPages);
    const tx = new TreeTransaction(vault, control, ".agentwiki/tx/nested-move");
    await tx.prepare({
      baseRevision: "base",
      targetRevision: "target",
      targetTreeHash: "0".repeat(64),
      actions: preview.actions,
    });
    await tx.apply();

    expect(vault.text("pages/E/Q.md")).toBe("new");
    expect(vault.exists("pages/E/P.md")).toBe(false);
    expect(vault.exists("pages/D/P.md")).toBe(false);
    expect(vault.folders.has("pages/D")).toBe(false);
    expect((await tx.inspect())?.state).toBe("committed");
  });

  it("applies a moved directory containing a trashed subdirectory", async () => {
    const base = snapshot({
      folders: [folder("d", null, "pages/D"), folder("s", "d", "pages/D/S")],
      pages: [await treePage("p", "s", "pages/D/S/P.md", "p")],
    });
    const remote = snapshot({
      folders: [folder("d", null, "pages/E")],
      pages: [],
    });
    const preview = await buildTreePullPreview(
      base,
      localScan(base.folders, base.pages),
      remote,
    );

    const vault = new MemoryVault({ "pages/D/S/P.md": "p" });
    const control = new MemoryControlStore();
    const tx = new TreeTransaction(
      vault,
      control,
      ".agentwiki/tx/moved-with-trash",
    );
    await tx.prepare({
      baseRevision: "base",
      targetRevision: "target",
      targetTreeHash: "0".repeat(64),
      actions: preview.actions,
    });
    await tx.apply();

    expect(vault.folders.has("pages/E")).toBe(true);
    expect(vault.folders.has("pages/D")).toBe(false);
    expect(vault.folders.has("pages/E/S")).toBe(false);
    expect(vault.exists("pages/D/S/P.md")).toBe(false);
    expect((await tx.inspect())?.state).toBe("committed");
  });

  it("applies a nested folder re-parented out from under a moved ancestor", async () => {
    const base = snapshot({
      folders: [folder("d", null, "pages/D"), folder("c", "d", "pages/D/C")],
      pages: [],
    });
    const remote = snapshot({
      folders: [folder("d", null, "pages/Z"), folder("c", null, "pages/C")],
      pages: [],
    });
    const preview = await buildTreePullPreview(
      base,
      localScan(base.folders, base.pages),
      remote,
    );

    const vault = new MemoryVault({ "pages/D/C/Keep.md": "keep" });
    const control = new MemoryControlStore();
    const tx = new TreeTransaction(
      vault,
      control,
      ".agentwiki/tx/reparent-out",
    );
    await tx.prepare({
      baseRevision: "base",
      targetRevision: "target",
      targetTreeHash: "0".repeat(64),
      actions: preview.actions,
    });
    await tx.apply();

    expect(vault.folders.has("pages/Z")).toBe(true);
    expect(vault.folders.has("pages/C")).toBe(true);
    expect(vault.folders.has("pages/D")).toBe(false);
    expect(vault.folders.has("pages/D/C")).toBe(false);
    expect(vault.text("pages/C/Keep.md")).toBe("keep");
    expect((await tx.inspect())?.state).toBe("committed");
  });
});
