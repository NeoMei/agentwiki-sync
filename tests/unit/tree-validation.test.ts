import { describe, expect, it } from "vitest";

import {
  sortTreeChanges,
  validateTreeSnapshot,
} from "../../src/core/tree-validation";
import type {
  TreeFolder,
  TreePage,
  TreePushChange,
  TreeSnapshot,
} from "../../src/core/tree-model";

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
  const name = path.split("/").at(-1) ?? "Page";
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

describe("validateTreeSnapshot", () => {
  it("rejects a folder cycle", () => {
    expect(() =>
      validateTreeSnapshot(
        snapshot({
          folders: [folder("a", "b", "pages/A"), folder("b", "a", "pages/B")],
        }),
      ),
    ).toThrow(/cycle|循环/);
  });

  it("rejects a page colliding with a directory pathKey", () => {
    expect(() =>
      validateTreeSnapshot(
        snapshot({
          folders: [folder("f", null, "pages/Guide.md")],
          pages: [page("p", null, "pages/guide.md")],
        }),
      ),
    ).toThrow(/PATH_COLLISION/);
  });

  it("rejects duplicate folder IDs", () => {
    expect(() =>
      validateTreeSnapshot(
        snapshot({
          folders: [
            folder("dup", null, "pages/A"),
            folder("dup", null, "pages/B"),
          ],
        }),
      ),
    ).toThrow(/DUPLICATE_FOLDER_ID/);
  });

  it("rejects duplicate page IDs", () => {
    expect(() =>
      validateTreeSnapshot(
        snapshot({
          pages: [
            page("dup", null, "pages/A.md"),
            page("dup", null, "pages/B.md"),
          ],
        }),
      ),
    ).toThrow(/DUPLICATE_PAGE_ID/);
  });

  it("rejects folder pathKey case collisions", () => {
    expect(() =>
      validateTreeSnapshot(
        snapshot({
          folders: [
            folder("a", null, "pages/Guide"),
            folder("b", null, "pages/guide"),
          ],
        }),
      ),
    ).toThrow(/PATH_COLLISION/);
  });

  it("rejects Unicode normalization collisions", () => {
    expect(() =>
      validateTreeSnapshot(
        snapshot({
          pages: [
            page("a", null, "pages/é.md"),
            page("b", null, "pages/e\u0301.md"),
          ],
        }),
      ),
    ).toThrow(/PATH_COLLISION/);
  });

  it("rejects an unknown parent folder", () => {
    expect(() =>
      validateTreeSnapshot(
        snapshot({
          folders: [folder("a", "missing", "pages/A")],
        }),
      ),
    ).toThrow(/UNKNOWN_PARENT/);
  });

  it("rejects an unknown page parent folder", () => {
    expect(() =>
      validateTreeSnapshot(
        snapshot({
          pages: [page("p", "missing", "pages/A.md")],
        }),
      ),
    ).toThrow(/UNKNOWN_PARENT/);
  });

  it("rejects v1 snapshots that contain folders", () => {
    expect(() =>
      validateTreeSnapshot(
        snapshot({
          protocolVersion: "1",
          folders: [folder("a", null, "pages/A")],
        }),
      ),
    ).toThrow(/Sync v1 cannot contain folders/);
  });

  it("rejects v2 paths outside the managed pages root", () => {
    expect(() =>
      validateTreeSnapshot(
        snapshot({ pages: [page("p", null, "notes/A.md")] }),
      ),
    ).toThrow(/under pages\//);
  });

  it("rejects unknown protocol versions", () => {
    expect(() =>
      validateTreeSnapshot(
        snapshot({ protocolVersion: "3" as unknown as "1" | "2" }),
      ),
    ).toThrow(/Unknown protocol version/);
  });

  it("normalizes valid v2 paths and returns the same shape", () => {
    const result = validateTreeSnapshot(
      snapshot({
        folders: [folder("f", null, "pages/Guide")],
        pages: [page("p", "f", "pages/Guide/Setup.MD")],
      }),
    );
    expect(result.folders[0]?.path).toBe("pages/Guide");
    expect(result.pages[0]?.path).toBe("pages/Guide/Setup.MD");
  });

  it("accepts v1 legacy page paths without folders", () => {
    const result = validateTreeSnapshot(
      snapshot({
        protocolVersion: "1",
        pages: [page("p", null, "Notes/Setup.MD")],
      }),
    );
    expect(result.pages[0]?.path).toBe("Notes/Setup.MD");
  });
});

describe("sortTreeChanges", () => {
  function label(change: TreePushChange): string {
    switch (change.operation) {
      case "archive_page":
        return `archive_page:${change.pageId}`;
      case "archive_folder":
        return `archive_folder:${change.folderId}`;
      case "upsert_folder":
        return `upsert_folder:${change.folder.folderId}`;
      case "upsert_page":
        return `upsert_page:${change.page.pageId}`;
    }
  }

  it("orders archive pages, child-first archive folders, parent-first upsert folders, then upsert pages", () => {
    const changes: TreePushChange[] = [
      { operation: "upsert_page", page: page("up", null, "pages/X.md") },
      {
        operation: "upsert_folder",
        folder: folder("uf-deep", "uf-shallow", "pages/X/Y"),
      },
      {
        operation: "upsert_folder",
        folder: folder("uf-shallow", null, "pages/X"),
      },
      {
        operation: "archive_folder",
        folderId: "af-shallow",
        previousPath: "pages/A",
      },
      {
        operation: "archive_folder",
        folderId: "af-deep",
        previousPath: "pages/A/B",
      },
      { operation: "archive_page", pageId: "ap", previousPath: "pages/Z.md" },
    ];

    expect(sortTreeChanges(changes).map(label)).toEqual([
      "archive_page:ap",
      "archive_folder:af-deep",
      "archive_folder:af-shallow",
      "upsert_folder:uf-shallow",
      "upsert_folder:uf-deep",
      "upsert_page:up",
    ]);
  });
});
