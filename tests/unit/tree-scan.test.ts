import { describe, expect, it } from "vitest";

import { pathKey } from "@neomei/agentwiki-sync-protocol";

import { contentHash } from "../../src/agentwiki/protocol";
import type { TreeScanLimits } from "../../src/core/tree-scan";
import { scanLocalTree } from "../../src/core/tree-scan";
import type {
  TreeFolder,
  TreePage,
  TreeSnapshot,
} from "../../src/core/tree-model";
import type { TreeIdentityState } from "../../src/storage/tree-identities";
import { MemoryVault } from "../fakes/memory-vault";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function identityState(
  overrides: Partial<TreeIdentityState> = {},
): TreeIdentityState {
  return {
    schemaVersion: 1,
    folders: {},
    pendingFolders: {},
    pendingPages: {},
    ...overrides,
  };
}

const limits: TreeScanLimits = {
  maxFolders: 1000,
  maxPages: 1000,
  maxPageBytes: 1_000_000,
};

describe("scanLocalTree", () => {
  it("enumerates folders and pages under the managed pages root", async () => {
    const vault = new MemoryVault({ "Wiki/pages/Guide/B.md": "# B" });
    await vault.createDirectory("Wiki/pages/Empty");
    await vault.createDirectory("Wiki/pages/Guide");
    await vault.write("Wiki/notes.md", new TextEncoder().encode("# notes"));

    const scan = await scanLocalTree(
      vault,
      "Wiki",
      snapshot(),
      identityState(),
      limits,
    );

    expect(scan.folders.map((item) => item.path)).toEqual([
      "pages/Empty",
      "pages/Guide",
    ]);
    expect(scan.pages.map((item) => item.path)).toEqual(["pages/Guide/B.md"]);
    expect(scan.pages[0]?.body).toBe("# B");
    expect(scan.pages[0]?.title).toBe("B");
    expect(scan.pages[0]?.folderId).toBe(scan.folders[1]?.folderId);
  });

  it("keeps a known folder ID through the local identity state after a move", async () => {
    const vault = new MemoryVault({ "Wiki/pages/B/P.md": "# moved" });
    const identities = identityState({
      folders: {
        f1: { folderId: "f1", path: "pages/B", pathKey: pathKey("pages/B") },
      },
    });
    const base = snapshot({
      folders: [folder("f1", null, "pages/A")],
      pages: [page("p1", "f1", "pages/A/P.md")],
    });

    const scan = await scanLocalTree(vault, "Wiki", base, identities, limits);

    expect(scan.folders.map((item) => item.folderId)).toEqual(["f1"]);
    expect(scan.folders[0]?.path).toBe("pages/B");
    expect(UUID.test(scan.pages[0]?.pageId ?? "")).toBe(true);
  });

  it("records new folders and pages as pending UUID identities", async () => {
    const vault = new MemoryVault({ "Wiki/pages/New.md": "# new" });
    const identities = identityState();

    const scan = await scanLocalTree(
      vault,
      "Wiki",
      snapshot(),
      identities,
      limits,
    );

    expect(scan.pages[0]?.folderId).toBeNull();
    expect(scan.pages[0]?.path).toBe("pages/New.md");
    expect(UUID.test(scan.pages[0]?.pageId ?? "")).toBe(true);
    expect(identities.pendingPages).toHaveProperty(scan.pages[0]!.pageId);
    expect(identities.pendingPages[scan.pages[0]!.pageId]?.path).toBe(
      "pages/New.md",
    );
    expect(identities.pendingPages[scan.pages[0]!.pageId]?.contentHash).toBe(
      await contentHash("# new"),
    );
  });

  it("reuses pending identities when the same tree is scanned again", async () => {
    const vault = new MemoryVault({ "Wiki/pages/Guide/A.md": "# a" });
    const identities = identityState();

    const first = await scanLocalTree(
      vault,
      "Wiki",
      snapshot(),
      identities,
      limits,
    );
    const second = await scanLocalTree(
      vault,
      "Wiki",
      snapshot(),
      identities,
      limits,
    );

    expect(second.folders.map((item) => item.folderId)).toEqual(
      first.folders.map((item) => item.folderId),
    );
    expect(second.pages.map((item) => item.pageId)).toEqual(
      first.pages.map((item) => item.pageId),
    );
  });

  it("skips the pages root itself and content outside pages/", async () => {
    const vault = new MemoryVault({ "Wiki/pages/Keep.md": "# keep" });
    await vault.createDirectory("Wiki/other");

    const scan = await scanLocalTree(
      vault,
      "Wiki",
      snapshot(),
      identityState(),
      limits,
    );

    expect(scan.folders).toEqual([]);
    expect(scan.pages.map((item) => item.path)).toEqual(["pages/Keep.md"]);
  });

  it("excludes .agentwiki content nested under the managed pages root", async () => {
    const vault = new MemoryVault({
      "Wiki/pages/Keep.md": "# keep",
      "Wiki/pages/.agentwiki/secret.md": "# secret",
    });

    const scan = await scanLocalTree(
      vault,
      "Wiki",
      snapshot(),
      identityState(),
      limits,
    );

    expect(scan.folders).toEqual([]);
    expect(scan.pages.map((item) => item.path)).toEqual(["pages/Keep.md"]);
  });

  it("rejects a pathKey collision between a directory and a page", async () => {
    const vault = new MemoryVault({ "Wiki/pages/Dup.md": "# page" });
    await vault.createDirectory("Wiki/pages/Dup.md");

    await expect(
      scanLocalTree(vault, "Wiki", snapshot(), identityState(), limits),
    ).rejects.toThrow(/PATH_COLLISION/);
  });

  it("enforces folder, page, and body-byte limits", async () => {
    const vault = new MemoryVault({ "Wiki/pages/A.md": "x".repeat(10) });

    await expect(
      scanLocalTree(vault, "Wiki", snapshot(), identityState(), {
        ...limits,
        maxPages: 0,
      }),
    ).rejects.toThrow(/SPACE_TOO_LARGE/);

    await expect(
      scanLocalTree(vault, "Wiki", snapshot(), identityState(), {
        ...limits,
        maxPageBytes: 4,
      }),
    ).rejects.toThrow(/SPACE_TOO_LARGE/);

    const folderVault = new MemoryVault({ "Wiki/pages/A/P.md": "# p" });
    await expect(
      scanLocalTree(folderVault, "Wiki", snapshot(), identityState(), {
        ...limits,
        maxFolders: 0,
      }),
    ).rejects.toThrow(/SPACE_TOO_LARGE/);
  });
});
