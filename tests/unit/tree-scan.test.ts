import { describe, expect, it } from "vitest";

import { pathKey } from "@neomei/agentwiki-sync-protocol";

import { contentHash } from "../../src/agentwiki/protocol";
import { sha256Hex } from "../../src/agentwiki/protocol";
import type {
  TreeScanLimits,
  TreeScanLimitsV3,
} from "../../src/core/tree-scan";
import {
  deriveEffectiveTreeScanLimitsV3,
  scanLocalTree,
} from "../../src/core/tree-scan";
import type {
  TreeAttachment,
  TreeFolder,
  TreePage,
  TreeSnapshot,
  TreeSnapshotV3,
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

const imageLimits: TreeScanLimitsV3 = {
  ...limits,
  maxAttachmentBytes: 1_000_000,
  maxRevisionAttachments: 100,
  maxTransferBlobBytes: 10_000_000,
  maxImageDimension: 10_000,
  maxDecodedPixels: 40_000_000,
  allowedMimeTypes: ["image/gif", "image/jpeg", "image/png", "image/webp"],
};

const pngBytes = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0,
  0, 0, 3, 8, 6, 0, 0, 0, 0, 0, 0, 0,
]);

function attachment(
  attachmentId: string,
  path: string,
  overrides: Partial<TreeAttachment> = {},
): TreeAttachment {
  return {
    attachmentId,
    path,
    mimeType: "image/png",
    sizeBytes: String(pngBytes.byteLength),
    width: 2,
    height: 3,
    contentHash: "a".repeat(64),
    updatedAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

function snapshotV3(overrides: Partial<TreeSnapshotV3> = {}): TreeSnapshotV3 {
  return {
    protocolVersion: "3",
    spaceId: "space-1",
    revision: "rev-1",
    revisionContentHash: "0".repeat(64),
    folders: [],
    pages: [],
    attachments: [],
    ...overrides,
  };
}

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

  it("keeps the existing v2 scan shape free of v3 attachment fields", async () => {
    const scan = await scanLocalTree(
      new MemoryVault({ "Wiki/pages/A.md": "# a" }),
      "Wiki",
      snapshot(),
      identityState(),
      limits,
    );

    expect(Object.keys(scan).sort()).toEqual(["folders", "pages", "rootPath"]);
    expect(Object.keys(scan.pages[0]!).sort()).not.toContain(
      "referencedAttachmentIds",
    );
  });

  it("does not read bytes for images absent from markdown references", async () => {
    const vault = new MemoryVault({});
    vault.seedFile("assets/unused.png", pngBytes);
    vault.seedMarkdown("pages/note.md", "no image");

    const scan = await scanLocalTree(
      vault,
      "",
      snapshotV3(),
      identityState(),
      imageLimits,
    );

    expect(vault.readPaths).not.toContain("assets/unused.png");
    expect(scan.attachments).toEqual([]);
    expect(scan.blockers).toEqual([]);
  });

  it("leaves a previously tracked image untouched after its last reference disappears", async () => {
    const hash = await sha256Hex(pngBytes);
    const vault = new MemoryVault({});
    vault.seedFile("assets/kept.png", pngBytes);
    vault.seedMarkdown("pages/note.md", "reference removed");
    const identities = identityState({
      attachments: {
        kept: {
          attachmentId: "kept",
          path: "assets/kept.png",
          pathKey: pathKey("assets/kept.png"),
          baseContentHash: hash,
          active: true,
        },
      },
    });
    const base = snapshotV3({
      pages: [
        {
          ...page("note", null, "pages/note.md"),
          referencedAttachmentIds: ["kept"],
        },
      ],
      attachments: [
        attachment("kept", "assets/kept.png", { contentHash: hash }),
      ],
    });

    const scan = await scanLocalTree(vault, "", base, identities, imageLimits);

    expect(vault.readPaths).not.toContain("assets/kept.png");
    expect(vault.operations).toBe(0);
    expect(vault.exists("assets/kept.png")).toBe(true);
    expect(scan.attachments).toEqual([]);
    expect(scan.pages[0]?.referencedAttachmentIds).toEqual([]);
    expect(identities.attachments?.kept?.active).toBe(true);
  });

  it("reads one referenced image once across pages and emits sorted unique IDs", async () => {
    const vault = new MemoryVault({});
    vault.seedFile("Wiki/assets/a.png", pngBytes);
    vault.seedMarkdown(
      "Wiki/pages/A.md",
      "![[assets/a.png]] ![[assets/a.png|320]]",
    );
    vault.seedMarkdown("Wiki/pages/B.md", "![b](../assets/a.png)");
    const identities = identityState();

    const scan = await scanLocalTree(
      vault,
      "Wiki",
      snapshotV3(),
      identities,
      imageLimits,
    );

    expect(
      vault.readPaths.filter((path) => path === "Wiki/assets/a.png"),
    ).toHaveLength(1);
    expect(scan.attachments).toHaveLength(1);
    expect(scan.attachments[0]).toMatchObject({
      path: "assets/a.png",
      mimeType: "image/png",
      sizeBytes: String(pngBytes.byteLength),
      width: 2,
      height: 3,
      contentHash: await sha256Hex(pngBytes),
    });
    const id = scan.attachments[0]!.attachmentId;
    expect(scan.pages.map((item) => item.referencedAttachmentIds)).toEqual([
      [id],
      [id],
    ]);
    expect(identities.pendingAttachments).toHaveProperty(id);
  });

  it("does not read explicit URL or data URI targets", async () => {
    const vault = new MemoryVault({});
    vault.seedFile("assets/a.png", pngBytes);
    vault.seedMarkdown(
      "pages/note.md",
      [
        "![a](https://example.test/a.png)",
        "![b](ftp://example.test/b.png)",
        "![c](//cdn.test/c.png)",
        "![d](data:image/png;base64,AA==)",
      ].join("\n"),
    );

    const scan = await scanLocalTree(
      vault,
      "",
      snapshotV3(),
      identityState(),
      imageLimits,
    );

    expect(vault.readPaths).toEqual([]);
    expect(scan.blockers).toEqual([]);
  });

  it("resolves a historical bare name only when it is unique", async () => {
    const unique = new MemoryVault({});
    unique.seedFile("assets/old.png", pngBytes);
    unique.seedMarkdown("pages/note.md", "![[old.png]]");

    const uniqueScan = await scanLocalTree(
      unique,
      "",
      snapshotV3(),
      identityState(),
      imageLimits,
    );

    expect(uniqueScan.attachments.map((item) => item.path)).toEqual([
      "assets/old.png",
    ]);

    const ambiguous = new MemoryVault({});
    ambiguous.seedFile("assets/old.png", pngBytes);
    ambiguous.seedFile("assets/OLD.PNG", pngBytes);
    ambiguous.seedMarkdown("pages/note.md", "![[old.png]]");

    const ambiguousScan = await scanLocalTree(
      ambiguous,
      "",
      snapshotV3(),
      identityState(),
      imageLimits,
    );

    expect(ambiguous.readPaths).toEqual([]);
    expect(ambiguousScan.blockers.map((item) => item.code)).toContain(
      "ATTACHMENT_NAME_CONFLICT",
    );
  });

  it.each([
    ["missing", "![[assets/missing.png]]", "ATTACHMENT_MISSING"],
    ["escape", "![x](../../outside.png)", "ATTACHMENT_REFERENCE_INVALID"],
    ["absolute", "![x](/assets/a.png)", "ATTACHMENT_REFERENCE_INVALID"],
    ["drive", "![x](C:/assets/a.png)", "ATTACHMENT_REFERENCE_INVALID"],
    ["unsupported", "![[assets/a.svg]]", "ATTACHMENT_REFERENCE_INVALID"],
  ])(
    "returns a blocker for a %s local reference",
    async (_name, body, code) => {
      const vault = new MemoryVault({});
      vault.seedMarkdown("pages/note.md", body);

      const scan = await scanLocalTree(
        vault,
        "",
        snapshotV3(),
        identityState(),
        imageLimits,
      );

      expect(scan.blockers.map((item) => item.code)).toContain(code);
      expect(vault.readPaths).toEqual([]);
    },
  );

  it("checks listed size before read and actual size after read", async () => {
    const oversized = new MemoryVault({});
    oversized.seedFile("assets/a.png", pngBytes);
    oversized.seedMarkdown("pages/note.md", "![[assets/a.png]]");
    const tinyLimit = {
      ...imageLimits,
      maxAttachmentBytes: pngBytes.byteLength - 1,
    };

    const listedBlock = await scanLocalTree(
      oversized,
      "",
      snapshotV3(),
      identityState(),
      tinyLimit,
    );
    expect(oversized.readPaths).toEqual([]);
    expect(listedBlock.blockers.map((item) => item.code)).toContain(
      "ATTACHMENT_QUOTA_EXCEEDED",
    );

    const inaccurate = new MemoryVault({});
    inaccurate.seedFile("assets/a.png", pngBytes);
    inaccurate.seedMarkdown("pages/note.md", "![[assets/a.png]]");
    inaccurate.setListedByteLength("assets/a.png", 1);
    const actualBlock = await scanLocalTree(
      inaccurate,
      "",
      snapshotV3(),
      identityState(),
      tinyLimit,
    );
    expect(inaccurate.readPaths).toEqual(["assets/a.png"]);
    expect(actualBlock.blockers.map((item) => item.code)).toContain(
      "ATTACHMENT_QUOTA_EXCEEDED",
    );
  });

  it("charges transfer bytes once per new content hash and excludes blobs proven in base", async () => {
    const existingHash = await sha256Hex(pngBytes);
    const newBytes = Uint8Array.from([...pngBytes, 1]);
    const newHash = await sha256Hex(newBytes);
    const base = snapshotV3({
      attachments: [
        attachment("existing", "assets/existing.png", {
          contentHash: existingHash,
        }),
      ],
    });
    const makeVault = () => {
      const vault = new MemoryVault({});
      vault.seedFile("assets/existing.png", pngBytes);
      vault.seedFile("assets/new.png", newBytes);
      vault.seedFile("assets/new-copy.png", newBytes);
      vault.seedMarkdown(
        "pages/note.md",
        ["existing", "new", "new-copy"]
          .map((name) => `![[assets/${name}.png]]`)
          .join(" "),
      );
      return vault;
    };

    const boundaryScan = await scanLocalTree(
      makeVault(),
      "",
      base,
      identityState(),
      { ...imageLimits, maxTransferBlobBytes: newBytes.byteLength },
    );

    expect(boundaryScan.blockers).toEqual([]);
    expect(boundaryScan.attachments.map((item) => item.path)).toEqual([
      "assets/existing.png",
      "assets/new-copy.png",
      "assets/new.png",
    ]);
    expect(
      boundaryScan.attachments.filter((item) => item.contentHash === newHash),
    ).toHaveLength(2);

    const overBoundaryScan = await scanLocalTree(
      makeVault(),
      "",
      base,
      identityState(),
      { ...imageLimits, maxTransferBlobBytes: newBytes.byteLength - 1 },
    );

    expect(overBoundaryScan.attachments.map((item) => item.path)).toEqual([
      "assets/existing.png",
    ]);
    expect(overBoundaryScan.blockers.map((item) => item.code)).toContain(
      "ATTACHMENT_QUOTA_EXCEEDED",
    );
  });

  it("uses immutable local defaults and only accepts stricter numeric v3 limits", () => {
    const localDefaults = {
      maxAttachmentBytes: 10 * 1024 * 1024,
      maxRevisionAttachments: 1_000,
      maxTransferBlobBytes: 100 * 1024 * 1024,
      maxImageDimension: 10_000,
      maxDecodedPixels: 40_000_000,
    };
    const numericKeys = Object.keys(localDefaults) as Array<
      keyof typeof localDefaults
    >;

    expect(deriveEffectiveTreeScanLimitsV3(limits)).toMatchObject(
      localDefaults,
    );
    expect(
      deriveEffectiveTreeScanLimitsV3({
        ...limits,
        maxAttachmentBytes: Number.MAX_SAFE_INTEGER,
        maxRevisionAttachments: Number.MAX_SAFE_INTEGER,
        maxTransferBlobBytes: Number.MAX_SAFE_INTEGER,
        maxImageDimension: Number.MAX_SAFE_INTEGER,
        maxDecodedPixels: Number.MAX_SAFE_INTEGER,
      }),
    ).toMatchObject(localDefaults);
    expect(
      deriveEffectiveTreeScanLimitsV3({
        ...limits,
        maxAttachmentBytes: 5,
        maxRevisionAttachments: 6,
        maxTransferBlobBytes: 7,
        maxImageDimension: 8,
        maxDecodedPixels: 9,
      }),
    ).toMatchObject({
      maxAttachmentBytes: 5,
      maxRevisionAttachments: 6,
      maxTransferBlobBytes: 7,
      maxImageDimension: 8,
      maxDecodedPixels: 9,
    });

    for (const key of numericKeys)
      for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
        expect(() =>
          deriveEffectiveTreeScanLimitsV3({
            ...limits,
            [key]: invalid,
          }),
        ).toThrow(/invalid v3 scan limit/);
  });

  it("blocks corrupt bytes and extension-to-magic mismatches", async () => {
    const vault = new MemoryVault({});
    vault.seedFile("assets/corrupt.png", Uint8Array.from([1, 2, 3]));
    vault.seedFile("assets/wrong.jpg", pngBytes);
    vault.seedMarkdown(
      "pages/note.md",
      "![[assets/corrupt.png]] ![[assets/wrong.jpg]]",
    );

    const scan = await scanLocalTree(
      vault,
      "",
      snapshotV3(),
      identityState(),
      imageLimits,
    );

    expect(scan.blockers.map((item) => item.code)).toEqual([
      "ATTACHMENT_CONTENT_INVALID",
      "ATTACHMENT_CONTENT_INVALID",
    ]);
    expect(scan.attachments).toEqual([]);
  });

  it("resolves active, pending and base IDs and reactivates only an exact detached path/hash", async () => {
    const hash = await sha256Hex(pngBytes);
    const vault = new MemoryVault({});
    for (const name of ["active", "pending", "base", "detached", "stale"])
      vault.seedFile(`assets/${name}.png`, pngBytes);
    vault.seedMarkdown(
      "pages/note.md",
      ["active", "pending", "base", "detached", "stale"]
        .map((name) => `![[assets/${name}.png]]`)
        .join(" "),
    );
    const identities = identityState({
      attachments: {
        active: {
          attachmentId: "active",
          path: "assets/active.png",
          pathKey: pathKey("assets/active.png"),
          baseContentHash: hash,
          active: true,
        },
        detached: {
          attachmentId: "detached",
          path: "assets/detached.png",
          pathKey: pathKey("assets/detached.png"),
          baseContentHash: hash,
          active: false,
        },
        stale: {
          attachmentId: "stale",
          path: "assets/stale.png",
          pathKey: pathKey("assets/stale.png"),
          baseContentHash: "f".repeat(64),
          active: false,
        },
      },
      pendingAttachments: {
        pending: {
          attachmentId: "pending",
          path: "assets/pending.png",
          pathKey: pathKey("assets/pending.png"),
          contentHash: hash,
        },
      },
    });
    const base = snapshotV3({
      attachments: [
        attachment("base", "assets/base.png", { contentHash: hash }),
      ],
    });

    const scan = await scanLocalTree(vault, "", base, identities, imageLimits);
    const idByPath = Object.fromEntries(
      scan.attachments.map((item) => [item.path, item.attachmentId]),
    );

    expect(idByPath).toMatchObject({
      "assets/active.png": "active",
      "assets/pending.png": "pending",
      "assets/base.png": "base",
      "assets/detached.png": "detached",
    });
    expect(identities.attachments?.detached?.active).toBe(true);
    expect(identities.attachments?.stale?.active).toBe(false);
    expect(idByPath["assets/stale.png"]).not.toBe("stale");
    expect(scan.pages[0]?.referencedAttachmentIds).toEqual(
      [...(scan.pages[0]?.referencedAttachmentIds ?? [])].sort(),
    );
  });

  it("stops before reads when listed attachment count exceeds capability", async () => {
    const vault = new MemoryVault({});
    vault.seedFile("assets/a.png", pngBytes);
    vault.seedFile("assets/b.png", pngBytes);
    vault.seedMarkdown("pages/note.md", "![[assets/a.png]] ![[assets/b.png]]");

    const countBlock = await scanLocalTree(
      vault,
      "",
      snapshotV3(),
      identityState(),
      { ...imageLimits, maxRevisionAttachments: 1 },
    );
    expect(countBlock.blockers.map((item) => item.code)).toContain(
      "ATTACHMENT_QUOTA_EXCEEDED",
    );
    expect(vault.readPaths).toEqual([]);
  });

  it("blocks path-to-multiple-ID and ID-to-multiple-path collisions", async () => {
    const vault = new MemoryVault({});
    vault.seedFile("assets/a.png", pngBytes);
    vault.seedFile("assets/b.png", pngBytes);
    vault.seedMarkdown("pages/note.md", "![[assets/a.png]] ![[assets/b.png]]");
    const identities = identityState({
      attachments: {
        one: {
          attachmentId: "same",
          path: "assets/a.png",
          pathKey: pathKey("assets/a.png"),
          baseContentHash: "a".repeat(64),
          active: true,
        },
        two: {
          attachmentId: "same",
          path: "assets/b.png",
          pathKey: pathKey("assets/b.png"),
          baseContentHash: "a".repeat(64),
          active: true,
        },
      },
      pendingAttachments: {
        other: {
          attachmentId: "other",
          path: "assets/a.png",
          pathKey: pathKey("assets/a.png"),
          contentHash: "a".repeat(64),
        },
      },
    });

    const scan = await scanLocalTree(
      vault,
      "",
      snapshotV3(),
      identities,
      imageLimits,
    );

    expect(scan.blockers.map((item) => item.code)).toContain(
      "ATTACHMENT_NAME_CONFLICT",
    );
    expect(vault.readPaths).toEqual([]);
  });

  it("blocks a detached reactivation whose ID is active at another path", async () => {
    const hash = await sha256Hex(pngBytes);
    const vault = new MemoryVault({});
    vault.seedFile("assets/a.png", pngBytes);
    vault.seedMarkdown("pages/note.md", "![[assets/a.png]]");
    const identities = identityState({
      attachments: {
        active: {
          attachmentId: "same",
          path: "assets/b.png",
          pathKey: pathKey("assets/b.png"),
          baseContentHash: hash,
          active: true,
        },
        detached: {
          attachmentId: "same",
          path: "assets/a.png",
          pathKey: pathKey("assets/a.png"),
          baseContentHash: hash,
          active: false,
        },
      },
    });

    const scan = await scanLocalTree(
      vault,
      "",
      snapshotV3(),
      identities,
      imageLimits,
    );

    expect(scan.attachments).toEqual([]);
    expect(scan.blockers.map((item) => item.code)).toContain(
      "ATTACHMENT_NAME_CONFLICT",
    );
    expect(identities.attachments?.detached?.active).toBe(false);
  });

  it("keeps generated attachment IDs stable across repeated nested-root scans", async () => {
    const vault = new MemoryVault({});
    vault.seedFile("Mappings/One/assets/a.png", pngBytes);
    vault.seedMarkdown("Mappings/One/pages/note.md", "![[assets/a.png]]");
    const identities = identityState();

    const first = await scanLocalTree(
      vault,
      "Mappings/One",
      snapshotV3(),
      identities,
      imageLimits,
    );
    const second = await scanLocalTree(
      vault,
      "Mappings/One",
      snapshotV3(),
      identities,
      imageLimits,
    );

    expect(second.attachments[0]?.attachmentId).toBe(
      first.attachments[0]?.attachmentId,
    );
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
