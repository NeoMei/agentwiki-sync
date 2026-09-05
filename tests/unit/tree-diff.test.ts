import { describe, expect, it } from "vitest";

import {
  buildTreePullPreview,
  buildTreePullPreviewV3,
  pendingTreeDecisionCount,
  resolveAttachmentConflict,
  resolveFolderConflict,
  resolveFolderConflictV3,
  resolvePageConflictV3,
} from "../../src/application/tree-diff";
import type {
  TreePullPreview,
  TreePullPreviewV3,
} from "../../src/application/tree-diff";
import type {
  TreeAttachment,
  TreeFolder,
  TreePage,
  TreePageV3,
  TreeSnapshot,
  TreeSnapshotV3,
} from "../../src/core/tree-model";
import type { LocalTreeScan, LocalTreeScanV3 } from "../../src/core/tree-scan";

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
    // SHA-256 of the empty body, matching contentHash("").
    contentHash:
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
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

function attachment(
  attachmentId: string,
  path: string,
  contentHash = "a".repeat(64),
): TreeAttachment {
  return {
    attachmentId,
    path,
    mimeType: "image/png",
    sizeBytes: "1",
    width: 1,
    height: 1,
    contentHash,
    updatedAt: "2026-09-04T00:00:00Z",
  };
}

function pageV3(
  pageId: string,
  path: string,
  body: string,
  referencedAttachmentIds: string[] = ["a"],
): TreePageV3 {
  return {
    ...page(pageId, null, path, { body }),
    referencedAttachmentIds,
  };
}

function snapshotV3(
  pages: TreePageV3[],
  attachments: TreeAttachment[],
  overrides: Partial<TreeSnapshotV3> = {},
): TreeSnapshotV3 {
  return {
    protocolVersion: "3",
    spaceId: "space-1",
    revision: "rev-3",
    revisionContentHash: "0".repeat(64),
    folders: [],
    pages,
    attachments,
    ...overrides,
  };
}

function localScanV3(
  pages: TreePageV3[],
  attachments: TreeAttachment[],
  blockers: LocalTreeScanV3["blockers"] = [],
): LocalTreeScanV3 {
  return {
    rootPath: "Wiki",
    folders: [],
    pages,
    attachments,
    blockers,
    rawPathStates: {},
  };
}

function keepBothCollisionPreview(): Promise<TreePullPreviewV3> {
  const firstBody = "![[assets/a.png]]";
  const pages = [
    pageV3("p1", "pages/P1.md", firstBody),
    pageV3("p2", "pages/P2.md", firstBody),
    pageV3("q", "pages/Q.md", "![[assets/occupied.png]]", ["b"]),
  ];
  return buildTreePullPreviewV3(
    snapshotV3(pages, [
      attachment("a", "assets/a.png"),
      attachment("b", "assets/occupied.png"),
    ]),
    localScanV3(pages, [
      attachment("a", "assets/a.png", "b".repeat(64)),
      attachment("b", "assets/occupied.png"),
    ]),
    snapshotV3(pages, [
      attachment("a", "assets/a.png", "c".repeat(64)),
      attachment("b", "assets/occupied.png"),
    ]),
  );
}

async function proposeOccupiedKeepBoth(preview: TreePullPreviewV3) {
  const contentConflict = preview.attachmentConflicts.find(
    (item) => item.attachmentId === "a" && item.kind === "content",
  )!;
  await resolveAttachmentConflict(preview, contentConflict.conflictId, {
    choice: "keep_both",
    primary: "remote",
    secondaryAttachmentId: "22222222-2222-4222-8222-222222222222",
    secondaryPath: "assets/occupied.png",
    redirectPageIds: ["p2"],
  });
  return preview.attachmentConflicts.find(
    (item) => item.attachmentId === "a" && item.kind === "path_occupied",
  );
}

function moveConflictPreview(): Promise<TreePullPreview> {
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
        kind: "write_page",
        pageId: "p1",
        path: "pages/B/P.md",
        beforePath: "pages/A/P.md",
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

describe("buildTreePullPreviewV3", () => {
  it("keeps an independent local body edit while rewriting a remote attachment rename", async () => {
    const originalBody = 'before\n![alt](../assets/a.png "title")';
    const localBody = 'local edit\n![alt](../assets/a.png "title")';
    const base = snapshotV3(
      [pageV3("p", "pages/P.md", originalBody)],
      [attachment("a", "assets/a.png")],
    );
    const local = localScanV3(
      [pageV3("p", "pages/P.md", localBody)],
      [attachment("a", "assets/a.png")],
    );
    const remote = snapshotV3(
      [pageV3("p", "pages/P.md", originalBody)],
      [attachment("a", "assets/renamed.png")],
      { revision: "rev-remote" },
    );

    const preview = await buildTreePullPreviewV3(base, local, remote);

    expect(preview.blockers).toEqual([]);
    expect(preview.attachmentConflicts).toEqual([]);
    expect(preview.resolvedPages[0]).toMatchObject({
      body: 'local edit\n![alt](../assets/renamed.png "title")',
      referencedAttachmentIds: ["a"],
    });
    const kinds = preview.actions.map((action) => action.kind);
    expect(kinds).toEqual([
      "create_attachment",
      "write_page",
      "remove_attachment_path",
    ]);
  });

  it("recomputes relative image traversal when a parent Folder moves", async () => {
    const root = folder("f", null, "pages/Old");
    const movedParent = folder("parent", null, "pages/New");
    const moved = folder("f", "parent", "pages/New/Old");
    const body = "![x](../../assets/a.png)";
    const base = snapshotV3(
      [{ ...pageV3("p", "pages/Old/P.md", body), folderId: "f" }],
      [attachment("a", "assets/a.png")],
      { folders: [root] },
    );
    const local = {
      ...localScanV3(
        [{ ...pageV3("p", "pages/Old/P.md", body), folderId: "f" }],
        [attachment("a", "assets/a.png")],
      ),
      folders: [root],
    };
    const remote = snapshotV3(
      [{ ...pageV3("p", "pages/New/P.md", body), folderId: "f" }],
      [attachment("a", "assets/a.png")],
      { folders: [movedParent, moved] },
    );

    const preview = await buildTreePullPreviewV3(base, local, remote);

    expect(preview.resolvedPages[0]?.path).toBe("pages/New/Old/P.md");
    expect(preview.resolvedPages[0]?.body).toBe("![x](../../../assets/a.png)");
    expect(preview.resolvedPages[0]?.referencedAttachmentIds).toEqual(["a"]);
  });

  it("preserves scan blockers and excludes them from a confirmable preview", async () => {
    const blocker = {
      code: "ATTACHMENT_MISSING" as const,
      pagePath: "pages/P.md",
      target: "assets/missing.png",
      detail: "missing",
    };
    const preview = await buildTreePullPreviewV3(
      snapshotV3([], []),
      localScanV3([], [], [blocker]),
      snapshotV3([], []),
    );
    expect(preview.blockers).toContainEqual(blocker);
    expect(pendingTreeDecisionCount(preview)).toBe(1);
  });

  it("keeps keep-both pending until an explicit valid Page redirect is resolved", async () => {
    const body = "![[assets/a.png]]";
    const base = snapshotV3(
      [pageV3("p1", "pages/P1.md", body), pageV3("p2", "pages/P2.md", body)],
      [attachment("a", "assets/a.png")],
    );
    const local = localScanV3(
      [pageV3("p1", "pages/P1.md", body), pageV3("p2", "pages/P2.md", body)],
      [attachment("a", "assets/a.png", "b".repeat(64))],
    );
    const remote = snapshotV3(
      [pageV3("p1", "pages/P1.md", body), pageV3("p2", "pages/P2.md", body)],
      [attachment("a", "assets/a.png", "c".repeat(64))],
    );
    const preview: TreePullPreviewV3 = await buildTreePullPreviewV3(
      base,
      local,
      remote,
    );
    expect(pendingTreeDecisionCount(preview)).toBe(1);

    await resolveAttachmentConflict(
      preview,
      preview.attachmentConflicts[0]!.conflictId,
      {
        choice: "keep_both",
        primary: "remote",
        secondaryAttachmentId: "22222222-2222-4222-8222-222222222222",
        secondaryPath: "assets/a (2).png",
        redirectPageIds: ["p2"],
      },
    );

    expect(pendingTreeDecisionCount(preview)).toBe(0);
    expect(
      preview.resolvedPages.find((page) => page.pageId === "p1"),
    ).toMatchObject({
      body: "![[assets/a.png]]",
      referencedAttachmentIds: ["a"],
    });
    expect(
      preview.resolvedPages.find((page) => page.pageId === "p2"),
    ).toMatchObject({
      body: "![[assets/a (2).png]]",
      referencedAttachmentIds: ["22222222-2222-4222-8222-222222222222"],
    });
  });

  it("lets an occupied keep-both proposal be explicitly replaced through the public resolver", async () => {
    const preview = await keepBothCollisionPreview();
    const occupiedConflict = await proposeOccupiedKeepBoth(preview);

    expect(pendingTreeDecisionCount(preview)).toBeGreaterThan(0);
    expect(occupiedConflict).toBeDefined();

    await resolveAttachmentConflict(preview, occupiedConflict!.conflictId, {
      choice: "keep_both",
      primary: "remote",
      secondaryAttachmentId: "33333333-3333-4333-8333-333333333333",
      secondaryPath: "assets/a (2).png",
      redirectPageIds: ["p2"],
    });

    expect(pendingTreeDecisionCount(preview)).toBe(0);
    expect(
      preview.resolvedAttachments
        .map((item) => item.attachmentId)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(["33333333-3333-4333-8333-333333333333", "a", "b"]);
    expect(
      preview.resolvedAttachments.find(
        (item) => item.attachmentId === "33333333-3333-4333-8333-333333333333",
      ),
    ).toMatchObject({
      path: "assets/a (2).png",
      contentHash: "b".repeat(64),
    });
    expect(
      preview.resolvedPages.map((page) => ({
        pageId: page.pageId,
        body: page.body,
        referencedAttachmentIds: page.referencedAttachmentIds,
      })),
    ).toEqual([
      {
        pageId: "p1",
        body: "![[assets/a.png]]",
        referencedAttachmentIds: ["a"],
      },
      {
        pageId: "p2",
        body: "![[assets/a (2).png]]",
        referencedAttachmentIds: ["33333333-3333-4333-8333-333333333333"],
      },
      {
        pageId: "q",
        body: "![[assets/occupied.png]]",
        referencedAttachmentIds: ["b"],
      },
    ]);
  });

  it.each(["local", "remote"] as const)(
    "lets the public resolver replace an occupied keep-both proposal with %s",
    async (choice) => {
      const preview = await keepBothCollisionPreview();
      const occupiedConflict = await proposeOccupiedKeepBoth(preview);

      await resolveAttachmentConflict(preview, occupiedConflict!.conflictId, {
        choice,
      });

      expect(pendingTreeDecisionCount(preview)).toBe(0);
      expect(
        preview.resolvedAttachments.find((item) => item.attachmentId === "a"),
      ).toMatchObject({
        path: "assets/a.png",
        contentHash: (choice === "local" ? "b" : "c").repeat(64),
      });
      expect(
        preview.resolvedAttachments.map((item) => item.attachmentId).sort(),
      ).toEqual(["a", "b"]);
      expect(
        preview.resolvedPages.map((page) => page.referencedAttachmentIds),
      ).toEqual([["a"], ["a"], ["b"]]);
    },
  );

  it("detaches after the last reference without scheduling removal of the local image", async () => {
    const base = snapshotV3(
      [pageV3("p", "pages/P.md", "![[assets/a.png]]")],
      [attachment("a", "assets/a.png")],
    );
    const noReference = pageV3("p", "pages/P.md", "plain", []);
    const preview = await buildTreePullPreviewV3(
      base,
      localScanV3([noReference], [attachment("a", "assets/a.png")]),
      snapshotV3([noReference], []),
    );
    expect(preview.actions).toContainEqual({
      kind: "detach_attachment",
      attachmentId: "a",
    });
    expect(preview.actions).not.toContainEqual(
      expect.objectContaining({ kind: "remove_attachment_path" }),
    );
  });

  it("recomputes attachment rewrites after a v3 Page body resolution", async () => {
    const baseBody = "base\n![[assets/a.png]]";
    const localBody = "local\n![[assets/a.png]]";
    const remoteBody = "remote\n![[assets/a.png]]";
    const base = snapshotV3(
      [pageV3("p", "pages/P.md", baseBody)],
      [attachment("a", "assets/a.png")],
    );
    const local = localScanV3(
      [pageV3("p", "pages/P.md", localBody)],
      [attachment("a", "assets/a.png")],
    );
    const remote = snapshotV3(
      [pageV3("p", "pages/P.md", remoteBody)],
      [attachment("a", "assets/renamed.png")],
    );
    const preview = await buildTreePullPreviewV3(base, local, remote);
    const conflictId = preview.pageConflicts[0]!.conflictId;

    await resolvePageConflictV3(preview, conflictId, { choice: "local" });

    expect(preview.pageConflicts.map((item) => item.conflictId)).toEqual([
      conflictId,
    ]);
    expect(preview.pageConflictResolutions[conflictId]).toEqual({
      choice: "local",
    });
    expect(preview.resolvedPages[0]?.body).toBe(
      "local\n![[assets/renamed.png]]",
    );
    expect(pendingTreeDecisionCount(preview)).toBe(0);
  });

  it("re-derives attachment IDs from an independently merged final Page body", async () => {
    const baseBody = "top\n![[assets/a.png]]\nbottom";
    const localBody = "LOCAL\n![[assets/a.png]]\nbottom";
    const remoteBody = "top\n![[assets/a.png]]\n![[assets/b.png]]\nbottom";
    const base = snapshotV3(
      [pageV3("p", "pages/P.md", baseBody, ["a"])],
      [attachment("a", "assets/a.png")],
    );
    const local = localScanV3(
      [pageV3("p", "pages/P.md", localBody, ["a"])],
      [attachment("a", "assets/a.png")],
    );
    const remote = snapshotV3(
      [pageV3("p", "pages/P.md", remoteBody, ["a", "b"])],
      [attachment("a", "assets/a.png"), attachment("b", "assets/b.png")],
    );

    const preview = await buildTreePullPreviewV3(base, local, remote);

    expect(preview.pageConflicts).toEqual([]);
    expect(preview.blockers).toEqual([]);
    expect(preview.resolvedPages[0]?.body).toContain("LOCAL");
    expect(preview.resolvedPages[0]?.body).toContain("assets/b.png");
    expect(preview.resolvedPages[0]?.referencedAttachmentIds).toEqual([
      "a",
      "b",
    ]);
    expect(
      preview.resolvedAttachments.map((item) => item.attachmentId),
    ).toEqual(["a", "b"]);
  });

  it("recomputes the typed v3 candidate after a Folder resolution", async () => {
    const parentA = folder("pa", null, "pages/A");
    const parentB = folder("pb", null, "pages/B");
    const baseFolder = folder("f", null, "pages/X");
    const localFolder = folder("f", "pa", "pages/A/X");
    const remoteFolder = folder("f", "pb", "pages/B/X");
    const body = "![x](../../../assets/a.png)";
    const base = snapshotV3(
      [{ ...pageV3("p", "pages/X/P.md", body), folderId: "f" }],
      [attachment("a", "assets/a.png")],
      { folders: [parentA, parentB, baseFolder] },
    );
    const local = {
      ...localScanV3(
        [{ ...pageV3("p", "pages/A/X/P.md", body), folderId: "f" }],
        [attachment("a", "assets/a.png")],
      ),
      folders: [parentA, parentB, localFolder],
    };
    const remote = snapshotV3(
      [{ ...pageV3("p", "pages/B/X/P.md", body), folderId: "f" }],
      [attachment("a", "assets/a.png")],
      { folders: [parentA, parentB, remoteFolder] },
    );
    const preview = await buildTreePullPreviewV3(base, local, remote);
    const conflictId = preview.folderConflicts[0]!.conflictId;

    await resolveFolderConflictV3(preview, conflictId, { choice: "remote" });

    expect(preview.folderConflicts).toEqual([]);
    expect(preview.resolvedPages[0]?.path).toBe("pages/B/X/P.md");
    expect(preview.resolvedPages[0]?.referencedAttachmentIds).toEqual(["a"]);
    expect(pendingTreeDecisionCount(preview)).toBe(0);
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

describe("fix round 1 regressions", () => {
  it("creates a new parent folder before moving a folder into it", async () => {
    const base = snapshot({ folders: [folder("f", null, "pages/F")] });
    const local = localScan([folder("f", null, "pages/F")], []);
    const remote = snapshot({
      folders: [folder("n", null, "pages/N"), folder("f", "n", "pages/N/F")],
    });

    const preview = await buildTreePullPreview(base, local, remote);
    const create = preview.actions.findIndex(
      (action) => action.kind === "create_directory" && action.folderId === "n",
    );
    const move = preview.actions.findIndex(
      (action) => action.kind === "move_directory" && action.folderId === "f",
    );
    expect(create).toBeGreaterThanOrEqual(0);
    expect(create).toBeLessThan(move);
  });

  it("moves a folder out before creating into its vacated path", async () => {
    const base = snapshot({ folders: [folder("f", null, "pages/F")] });
    const local = localScan([folder("f", null, "pages/F")], []);
    const remote = snapshot({
      folders: [
        folder("n", null, "pages/N"),
        folder("f", "n", "pages/N/F"),
        folder("g", null, "pages/F"),
      ],
    });

    const preview = await buildTreePullPreview(base, local, remote);
    const move = preview.actions.findIndex(
      (action) => action.kind === "move_directory" && action.folderId === "f",
    );
    const createG = preview.actions.findIndex(
      (action) => action.kind === "create_directory" && action.folderId === "g",
    );
    expect(move).toBeGreaterThanOrEqual(0);
    expect(move).toBeLessThan(createG);
  });

  it("conflicts when local deletes a folder that remote moved", async () => {
    const base = snapshot({ folders: [folder("f", null, "pages/F")] });
    const local = localScan([], []);
    const remote = snapshot({ folders: [folder("f", null, "pages/G")] });

    const preview = await buildTreePullPreview(base, local, remote);

    expect(preview.folderConflicts).toHaveLength(1);
    expect(preview.folderConflicts[0]).toMatchObject({
      folderId: "f",
      basePath: "pages/F",
      localPath: null,
      remotePath: "pages/G",
    });
    expect(preview.actions).not.toContainEqual(
      expect.objectContaining({ kind: "trash_directory", folderId: "f" }),
    );
  });

  it("conflicts when local moves a folder that remote deleted", async () => {
    const base = snapshot({ folders: [folder("f", null, "pages/F")] });
    const local = localScan([folder("f", null, "pages/G")], []);
    const remote = snapshot({ folders: [] });

    const preview = await buildTreePullPreview(base, local, remote);

    expect(preview.folderConflicts).toHaveLength(1);
    expect(preview.folderConflicts[0]).toMatchObject({
      folderId: "f",
      basePath: "pages/F",
      localPath: "pages/G",
      remotePath: null,
    });
  });

  it("conflicts when both sides add the same folder id at different locations", async () => {
    const base = snapshot({ folders: [] });
    const local = localScan([folder("f", null, "pages/A")], []);
    const remote = snapshot({ folders: [folder("f", null, "pages/B")] });

    const preview = await buildTreePullPreview(base, local, remote);

    expect(preview.folderConflicts).toHaveLength(1);
    expect(preview.folderConflicts[0]).toMatchObject({
      folderId: "f",
      basePath: null,
      localPath: "pages/A",
      remotePath: "pages/B",
    });
  });

  it("promotes a deleted folder to a conflict when a page still depends on it", async () => {
    const base = snapshot({ folders: [folder("f", null, "pages/F")] });
    const local = localScan(
      [folder("f", null, "pages/F")],
      [page("p", "f", "pages/F/P.md")],
    );
    const remote = snapshot({ folders: [] });

    const preview = await buildTreePullPreview(base, local, remote);

    expect(preview.folderConflicts).toHaveLength(1);
    expect(preview.folderConflicts[0]?.folderId).toBe("f");
    expect(pendingTreeDecisionCount(preview)).toBe(1);
  });

  it("recomputes descendant actions after resolving a folder to remote", async () => {
    const base = snapshot({
      folders: [folder("f", null, "pages/X"), folder("c", "f", "pages/X/C")],
      pages: [page("p", "c", "pages/X/C/P.md")],
    });
    const local = localScan(
      [folder("f", null, "pages/A"), folder("c", "f", "pages/A/C")],
      [page("p", "c", "pages/A/C/P.md")],
    );
    const remote = snapshot({
      folders: [folder("f", null, "pages/B"), folder("c", "f", "pages/B/C")],
      pages: [page("p", "c", "pages/B/C/P.md")],
    });

    const preview = await buildTreePullPreview(base, local, remote);
    const conflictId = preview.folderConflicts.find(
      (conflict) => conflict.folderId === "f",
    )!.conflictId;

    resolveFolderConflict(preview, conflictId, { choice: "remote" });

    expect(preview.actions).toContainEqual(
      expect.objectContaining({
        kind: "move_directory",
        folderId: "f",
        path: "pages/B",
      }),
    );
    expect(preview.actions).not.toContainEqual(
      expect.objectContaining({ kind: "move_directory", folderId: "c" }),
    );
    expect(preview.actions).not.toContainEqual(
      expect.objectContaining({ kind: "move_page", pageId: "p" }),
    );
    expect(pendingTreeDecisionCount(preview)).toBe(0);
  });

  it("rejects a manual path outside the managed pages/ root", async () => {
    const preview = await moveConflictPreview();
    const conflictId = preview.folderConflicts[0]!.conflictId;

    expect(() =>
      resolveFolderConflict(preview, conflictId, {
        choice: "manual",
        manualPath: "OutsideRoot",
      }),
    ).toThrow(/pages/);
    expect(pendingTreeDecisionCount(preview)).toBe(1);
  });

  it("detects a case-folded manual path cycle", async () => {
    const base = snapshot({ folders: [folder("f1", null, "pages/X")] });
    const local = localScan([folder("f1", null, "pages/A")], []);
    const remote = snapshot({ folders: [folder("f1", null, "pages/B")] });
    const preview = await buildTreePullPreview(base, local, remote);
    const conflictId = preview.folderConflicts[0]!.conflictId;

    expect(() =>
      resolveFolderConflict(preview, conflictId, {
        choice: "manual",
        manualPath: "pages/a/X",
      }),
    ).toThrow(/FOLDER_CYCLE|循环/);
  });

  it("surfaces a title conflict when local and remote diverge on a title", async () => {
    const base = snapshot({
      pages: [page("p", null, "pages/P.md", { title: "Base", body: "x" })],
    });
    const local = localScan(
      [],
      [page("p", null, "pages/P.md", { title: "Local", body: "x" })],
    );
    const remote = snapshot({
      pages: [page("p", null, "pages/P.md", { title: "Remote", body: "x" })],
    });

    const preview = await buildTreePullPreview(base, local, remote);

    expect(preview.pageConflicts).toContainEqual(
      expect.objectContaining({ field: "title", pageId: "p" }),
    );
  });

  it("conflicts when local changes a title and remote deleted the page", async () => {
    const base = snapshot({
      pages: [page("p", null, "pages/P.md", { title: "Base", body: "x" })],
    });
    const local = localScan(
      [],
      [page("p", null, "pages/P.md", { title: "Local", body: "x" })],
    );
    const remote = snapshot({ pages: [] });

    const preview = await buildTreePullPreview(base, local, remote);

    expect(preview.pageConflicts).toContainEqual(
      expect.objectContaining({ field: "archive", pageId: "p" }),
    );
    expect(preview.actions).not.toContainEqual(
      expect.objectContaining({ kind: "trash_page", pageId: "p" }),
    );
  });
});

describe("fix round 2 regressions", () => {
  it("conflicts when both sides add the same page id at different locations", async () => {
    const base = snapshot({ pages: [] });
    const local = localScan([], [page("p", null, "pages/Local.md")]);
    const remote = snapshot({ pages: [page("p", null, "pages/Remote.md")] });

    const preview = await buildTreePullPreview(base, local, remote);

    expect(preview.pageConflicts).toContainEqual(
      expect.objectContaining({ field: "path", pageId: "p" }),
    );
    expect(preview.actions).not.toContainEqual(
      expect.objectContaining({ kind: "create_page", pageId: "p" }),
    );
    expect(pendingTreeDecisionCount(preview)).toBeGreaterThan(0);
  });

  it("keeps the preview unchanged when a resolution fails to recompute", async () => {
    const base = snapshot({
      folders: [folder("f", null, "pages/X"), folder("g", null, "pages/B")],
    });
    const local = localScan(
      [folder("f", null, "pages/A"), folder("g", null, "pages/C")],
      [],
    );
    const remote = snapshot({
      folders: [folder("f", null, "pages/C"), folder("g", null, "pages/B")],
    });

    const preview = await buildTreePullPreview(base, local, remote);
    const conflictId = preview.folderConflicts.find(
      (conflict) => conflict.folderId === "f",
    )!.conflictId;
    const beforeResolutions = { ...preview.folderConflictResolutions };
    const beforeActions = [...preview.actions];
    const beforeConflicts = [...preview.folderConflicts];

    expect(() =>
      resolveFolderConflict(preview, conflictId, { choice: "remote" }),
    ).toThrow();

    expect(preview.folderConflictResolutions).toEqual(beforeResolutions);
    expect(preview.actions).toEqual(beforeActions);
    expect(preview.folderConflicts).toEqual(beforeConflicts);
    expect(pendingTreeDecisionCount(preview)).toBe(1);
  });
});
