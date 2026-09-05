import { describe, expect, it } from "vitest";

import {
  sortTreeChanges,
  validateTreeSnapshot,
  validateTreeSnapshotV3,
} from "../../src/core/tree-validation";
import type {
  TreeAttachment,
  TreeFolder,
  TreePage,
  TreePageV3,
  TreePushChange,
  TreeSnapshot,
  TreeSnapshotV3,
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

describe("validateTreeSnapshotV3", () => {
  const image: TreeAttachment = {
    attachmentId: "a",
    path: "assets/a.png",
    mimeType: "image/png",
    sizeBytes: "1",
    width: 1,
    height: 1,
    contentHash: "a".repeat(64),
    updatedAt: "2026-09-04T00:00:00Z",
  };
  const imagePage: TreePageV3 = {
    ...page("p", null, "pages/P.md", { body: "![[assets/a.png]]" }),
    referencedAttachmentIds: ["a"],
  };
  const v3 = (overrides: Partial<TreeSnapshotV3> = {}): TreeSnapshotV3 => ({
    protocolVersion: "3",
    spaceId: "space-1",
    revision: "rev-3",
    revisionContentHash: "0".repeat(64),
    folders: [],
    pages: [imagePage],
    attachments: [image],
    ...overrides,
  });

  it("accepts a referenced attachment and preserves the strict v3 shape", () => {
    expect(validateTreeSnapshotV3(v3())).toEqual(v3());
  });

  it("rejects duplicate attachment IDs and pathKeys", () => {
    expect(() =>
      validateTreeSnapshotV3(
        v3({ attachments: [image, { ...image, path: "assets/b.png" }] }),
      ),
    ).toThrow(/DUPLICATE_ATTACHMENT_ID/);
    expect(() =>
      validateTreeSnapshotV3(
        v3({
          attachments: [
            image,
            { ...image, attachmentId: "b", path: "assets/A.png" },
          ],
        }),
      ),
    ).toThrow(/ATTACHMENT_PATH_COLLISION/);
  });

  it("rejects reference manifests that are unsorted, missing, or not derived from Markdown", () => {
    expect(() =>
      validateTreeSnapshotV3(
        v3({ pages: [{ ...imagePage, referencedAttachmentIds: ["a", "a"] }] }),
      ),
    ).toThrow(/ATTACHMENT_REFERENCES_INVALID/);
    expect(() =>
      validateTreeSnapshotV3(
        v3({ pages: [{ ...imagePage, referencedAttachmentIds: ["missing"] }] }),
      ),
    ).toThrow(/ATTACHMENT_REFERENCES_INVALID/);
    expect(() =>
      validateTreeSnapshotV3(
        v3({ pages: [{ ...imagePage, body: "no image" }] }),
      ),
    ).toThrow(/ATTACHMENT_REFERENCES_INVALID/);
  });

  it("rejects an attachment that is not referenced by any Page", () => {
    expect(() => validateTreeSnapshotV3(v3({ pages: [] }))).toThrow(
      /ATTACHMENT_REFERENCES_INVALID/,
    );
  });

  it("rejects an invalid local image reference even when the declared set is empty", () => {
    expect(() =>
      validateTreeSnapshotV3(
        v3({
          pages: [
            {
              ...imagePage,
              body: "![[../outside.png]]",
              referencedAttachmentIds: [],
            },
          ],
          attachments: [],
        }),
      ),
    ).toThrow(/ATTACHMENT_REFERENCES_INVALID/);
  });
});
