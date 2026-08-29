import { describe, expect, it } from "vitest";

import {
  buildTreePullPreview,
  pendingTreeDecisionCount,
  resolveFolderConflict,
} from "../../src/application/tree-diff";
import type { TreePullPreview } from "../../src/application/tree-diff";
import type {
  TreeFolder,
  TreePage,
  TreeSnapshot,
} from "../../src/core/tree-model";
import type { LocalTreeScan } from "../../src/core/tree-scan";

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

function page(
  pageId: string,
  folderId: string | null,
  path: string,
  overrides: Partial<TreePage> = {},
): TreePage {
  const name = path.split("/").at(-1) ?? "Page.md";
  return {
    pageId,
    folderId,
    path,
    title: name.slice(0, name.lastIndexOf(".")),
    body: "",
    contentHash: "0".repeat(64),
    updatedAt: "2026-08-29T00:00:00Z",
    ...overrides,
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

describe("buildTreePullPreview", () => {
  it("keeps one folder identity when local and remote agree on a move", async () => {
    const base = snapshot({
      folders: [folder("f1", null, "pages/A")],
    });
    const localMoved = localScan([folder("f1", null, "pages/B")], []);
    const remoteMoved = snapshot({
      folders: [folder("f1", null, "pages/B")],
    });

    const preview = await buildTreePullPreview(base, localMoved, remoteMoved);

    expect(preview.actions).toContainEqual(
      expect.objectContaining({
        kind: "move_directory",
        folderId: "f1",
        fromPath: "pages/A",
        path: "pages/B",
      }),
    );
  });

  it("blocks different local and remote parents for the same folder", async () => {
    const base = snapshot({
      folders: [
        folder("pa", null, "pages/A"),
        folder("pb", null, "pages/B"),
        folder("f1", null, "pages/X"),
      ],
    });
    const localToA = localScan(
      [
        folder("pa", null, "pages/A"),
        folder("pb", null, "pages/B"),
        folder("f1", "pa", "pages/A/X"),
      ],
      [],
    );
    const remoteToB = snapshot({
      folders: [
        folder("pa", null, "pages/A"),
        folder("pb", null, "pages/B"),
        folder("f1", "pb", "pages/B/X"),
      ],
    });

    const preview = await buildTreePullPreview(base, localToA, remoteToB);

    expect(preview.folderConflicts).toHaveLength(1);
    expect(preview.folderConflicts[0]).toMatchObject({
      folderId: "f1",
      basePath: "pages/X",
      localPath: "pages/A/X",
      remotePath: "pages/B/X",
      baseParentPath: null,
      localParentPath: "pages/A",
      remoteParentPath: "pages/B",
    });
    expect(pendingTreeDecisionCount(preview)).toBe(1);
  });

  it("creates an empty remote folder as a directory action", async () => {
    const base = snapshot();
    const local = localScan([], []);
    const remote = snapshot({
      folders: [folder("empty", null, "pages/Empty")],
    });

    const preview = await buildTreePullPreview(base, local, remote);

    expect(preview.actions).toContainEqual({
      kind: "create_directory",
      folderId: "empty",
      path: "pages/Empty",
    });
  });

  it("orders trashes child-first and creates parent-first before pages", async () => {
    const base = snapshot({
      folders: [
        folder("root", null, "pages/A"),
        folder("child", "root", "pages/A/B"),
      ],
      pages: [
        page("p0", "root", "pages/A/C.md"),
        page("p1", "child", "pages/A/B/P.md"),
      ],
    });
    const local = localScan(
      [folder("root", null, "pages/A"), folder("child", "root", "pages/A/B")],
      [
        page("p0", "root", "pages/A/C.md"),
        page("p1", "child", "pages/A/B/P.md"),
      ],
    );
    const remote = snapshot({
      folders: [folder("nr", null, "pages/X"), folder("nc", "nr", "pages/X/Y")],
      pages: [page("q", "nc", "pages/X/Y/Q.md")],
    });

    const preview = await buildTreePullPreview(base, local, remote);

    expect(preview.actions.map((action) => action.kind)).toEqual([
      "trash_page",
      "trash_page",
      "trash_directory",
      "trash_directory",
      "create_directory",
      "create_directory",
      "create_page",
    ]);

    const childTrash = preview.actions.findIndex(
      (action) =>
        action.kind === "trash_directory" && action.path === "pages/A/B",
    );
    const rootTrash = preview.actions.findIndex(
      (action) =>
        action.kind === "trash_directory" && action.path === "pages/A",
    );
    expect(childTrash).toBeGreaterThanOrEqual(0);
    expect(childTrash).toBeLessThan(rootTrash);

    const nrCreate = preview.actions.findIndex(
      (action) =>
        action.kind === "create_directory" && action.path === "pages/X",
    );
    const ncCreate = preview.actions.findIndex(
      (action) =>
        action.kind === "create_directory" && action.path === "pages/X/Y",
    );
    expect(nrCreate).toBeGreaterThanOrEqual(0);
    expect(nrCreate).toBeLessThan(ncCreate);
  });

  it("blocks a resolved folder cycle", async () => {
    const base = snapshot({
      folders: [folder("f1", null, "pages/A"), folder("f2", null, "pages/B")],
    });
    const local = localScan(
      [folder("f1", "f2", "pages/B/A"), folder("f2", null, "pages/B")],
      [],
    );
    const remote = snapshot({
      folders: [folder("f1", null, "pages/A"), folder("f2", "f1", "pages/A/B")],
    });

    await expect(buildTreePullPreview(base, local, remote)).rejects.toThrow(
      /FOLDER_CYCLE/,
    );
  });

  it("moves a page with its body when its folder changes", async () => {
    const base = snapshot({
      folders: [folder("f1", null, "pages/A")],
      pages: [
        page("p1", "f1", "pages/A/P.md", {
          body: "before",
          contentHash: "0".repeat(64),
        }),
      ],
    });
    const local = localScan(
      [folder("f1", null, "pages/B")],
      [
        page("p1", "f1", "pages/B/P.md", {
          body: "before",
          contentHash: "0".repeat(64),
        }),
      ],
    );
    const remote = snapshot({
      folders: [folder("f1", null, "pages/B")],
      pages: [
        page("p1", "f1", "pages/B/P.md", {
          body: "after",
          contentHash: "0".repeat(64),
        }),
      ],
    });

    const preview = await buildTreePullPreview(base, local, remote);

    expect(preview.actions).toContainEqual(
      expect.objectContaining({
        kind: "move_page",
        pageId: "p1",
        fromPath: "pages/A/P.md",
        path: "pages/B/P.md",
      }),
    );
  });

  it("writes a page body in place when only its content changed", async () => {
    const base = snapshot({
      pages: [page("p1", null, "pages/P.md", { body: "before" })],
    });
    const local = localScan(
      [],
      [page("p1", null, "pages/P.md", { body: "before" })],
    );
    const remote = snapshot({
      pages: [page("p1", null, "pages/P.md", { body: "after" })],
    });

    const preview = await buildTreePullPreview(base, local, remote);

    expect(preview.actions).toContainEqual(
      expect.objectContaining({
        kind: "write_page",
        pageId: "p1",
        path: "pages/P.md",
      }),
    );
  });

  it("surfaces a page body conflict and counts it as a pending decision", async () => {
    const base = snapshot({
      pages: [
        page("p1", null, "pages/P.md", {
          body: "abc",
          contentHash: "0".repeat(64),
        }),
      ],
    });
    const local = localScan(
      [],
      [
        page("p1", null, "pages/P.md", {
          body: "a",
          contentHash: "0".repeat(64),
        }),
      ],
    );
    const remote = snapshot({
      pages: [
        page("p1", null, "pages/P.md", {
          body: "ab",
          contentHash: "0".repeat(64),
        }),
      ],
    });

    const preview = await buildTreePullPreview(base, local, remote);

    expect(preview.pageConflicts).toHaveLength(1);
    expect(pendingTreeDecisionCount(preview)).toBe(1);
  });
});

describe("resolveFolderConflict", () => {
  async function conflictingPreview(): Promise<TreePullPreview> {
    const base = snapshot({
      folders: [
        folder("pa", null, "pages/A"),
        folder("pb", null, "pages/B"),
        folder("f1", null, "pages/X"),
      ],
    });
    const local = localScan(
      [
        folder("pa", null, "pages/A"),
        folder("pb", null, "pages/B"),
        folder("f1", "pa", "pages/A/X"),
      ],
      [],
    );
    const remote = snapshot({
      folders: [
        folder("pa", null, "pages/A"),
        folder("pb", null, "pages/B"),
        folder("f1", "pb", "pages/B/X"),
      ],
    });
    return buildTreePullPreview(base, local, remote);
  }

  it("records a valid manual resolution and clears the pending decision", async () => {
    const preview = await conflictingPreview();
    const conflictId = preview.folderConflicts[0]!.conflictId;

    resolveFolderConflict(preview, conflictId, {
      choice: "manual",
      manualPath: "pages/B/X",
    });

    expect(preview.folderConflictResolutions[conflictId]).toEqual({
      choice: "manual",
      manualPath: "pages/B/X",
    });
    expect(pendingTreeDecisionCount(preview)).toBe(0);
  });

  it("rejects a manual path whose parent folder is missing", async () => {
    const preview = await conflictingPreview();
    const conflictId = preview.folderConflicts[0]!.conflictId;

    expect(() =>
      resolveFolderConflict(preview, conflictId, {
        choice: "manual",
        manualPath: "pages/Missing/X",
      }),
    ).toThrow(/父目录|parent|缺少/);
  });

  it("rejects a manual path that collides with an existing folder", async () => {
    const preview = await conflictingPreview();
    const conflictId = preview.folderConflicts[0]!.conflictId;

    expect(() =>
      resolveFolderConflict(preview, conflictId, {
        choice: "manual",
        manualPath: "pages/A",
      }),
    ).toThrow(/冲突|占用|collision/i);
  });
});
