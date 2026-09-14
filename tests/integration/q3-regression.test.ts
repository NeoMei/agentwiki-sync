import { describe, expect, it, vi } from "vitest";
import { SyncRuntime } from "../../src/application/sync-runtime";
import { resolvePageConflictV3 } from "../../src/application/tree-diff";
import {
  verifyResolvedV3Vault,
  desiredV3Identities,
} from "../../src/application/tree-local-apply-v3";
import { contentHash } from "../../src/agentwiki/protocol";
import {
  FakeTreeRemote,
  FakeTreeRemoteV3,
  V3_CAPABILITIES,
} from "../fakes/fake-tree-remote";
import { MemoryVault } from "../fakes/memory-vault";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { emptyTreeIdentityStateV2 } from "../../src/storage/tree-identities";
import { makePlugin, modalButton } from "../fakes/plugin-harness";
import { PreviewModal } from "../../src/obsidian/preview-modal";
import type { ModalTransition } from "../../src/obsidian/modal-handoff";

const page = async (
  id: string,
  path: string,
  body: string,
  folderId: string | null = null,
) => ({
  pageId: id,
  folderId,
  path,
  title: path.split("/").at(-1)!.slice(0, -3),
  body,
  contentHash: await contentHash(body),
  updatedAt: "2026-09-14T00:00:00.000Z",
});
const mapping = () => ({
  spaceId: "space",
  rootPath: "Wiki",
  status: "pending" as const,
});

async function deletedTree() {
  const remote = new FakeTreeRemote();
  const folders = ["A", "B"].map((name) => ({
    folderId: `f${name}`,
    parentFolderId: null,
    path: `pages/${name}`,
    name,
    sortOrder: 0,
    updatedAt: "2026-09-14T00:00:00.000Z",
  }));
  const pages = await Promise.all(
    [1, 2, 3, 4, 5].map((id) =>
      page(
        `p${id}`,
        `pages/${id < 4 ? "A" : "B"}/${id}.md`,
        `server ${id}`,
        id < 4 ? "fA" : "fB",
      ),
    ),
  );
  await remote.seedTree({ pages, folders });
  const vault = new MemoryVault({});
  const control = new MemoryControlStore();
  const runtime = new SyncRuntime(vault, control, remote, mapping());
  await runtime.applyPull(await runtime.previewPull());
  await vault.trashDirectory("Wiki/pages/A");
  await vault.trashDirectory("Wiki/pages/B");
  return { remote, vault, control, runtime, pages };
}

describe("Q3 regression", () => {
  it("keeps 2 folder / 5 page local deletions as a deliberate publishable change", async () => {
    const { runtime, remote, vault } = await deletedTree();
    expect((await runtime.remoteDelta()).ahead).toBe(false);
    const preview = await runtime.previewPush();
    expect(
      preview.changes.filter((x) => x.operation === "archive_page"),
    ).toHaveLength(5);
    expect(
      preview.changes.filter((x) => x.operation === "archive_folder"),
    ).toHaveLength(2);
    await runtime.applyPush(preview);
    expect((await remote.head()).pageCount).toBe("0");
    expect(vault.exists("Wiki/pages/A/1.md")).toBe(false);
  });

  it.each([false, true])(
    "confirms server restore or a content-identical newer baseline (newer=%s)",
    async (newer) => {
      const { runtime, remote, vault, pages } = await deletedTree();
      if (newer) {
        await runtime.applyPull(
          await runtime.previewPull(undefined, { restoreServer: true }),
        );
        await remote.advanceEmptyRevision();
      }
      const harness = await makePlugin({
        data: {
          schemaVersion: 2,
          serverUrl: "https://wiki.example.com",
          mappings: [{ spaceId: "space", rootPath: "Wiki", status: "active" }],
        },
      });
      await harness.plugin.onload();
      const subject = harness.plugin as unknown as {
        runtime: () => Promise<SyncRuntime>;
        runSyncStrategy: (
          id: string,
          strategy: "server",
          options: object,
        ) => Promise<ModalTransition | void>;
      };
      subject.runtime = async () => runtime;
      const open = vi
        .spyOn(PreviewModal.prototype, "open")
        .mockImplementation(function (this: PreviewModal) {
          this.onOpen();
        });
      try {
        const transition = await subject.runSyncStrategy("space", "server", {});
        expect(transition).toBeTypeOf("function");
        transition?.();
        const modal = open.mock.instances.at(-1)!;
        expect(vault.exists("Wiki/pages/A/1.md")).toBe(newer);
        modalButton(modal, "确认执行").dispatchEvent({ type: "click" });
        await vi.waitFor(() =>
          expect(vault.text("Wiki/pages/B/5.md")).toBe("server 5"),
        );
        for (const p of pages)
          expect(vault.text(`Wiki/${p.path}`)).toBe(p.body);
        await vi.waitFor(async () =>
          expect((await runtime.remoteDelta()).ahead).toBe(false),
        );
        expect((await runtime.previewPush()).changes).toEqual([]);
      } finally {
        open.mockRestore();
      }
    },
  );

  it.each(["local\nline", "local\r\nline"])(
    "retains locally chosen V3 conflict with line endings %j",
    async (body) => {
      const remote = new FakeTreeRemoteV3();
      const p = await page("p1", "pages/中文.md", "base");
      await remote.seedTree({
        revision: "r1",
        pages: [{ ...p, referencedAttachmentIds: [] }],
      });
      const vault = new MemoryVault({});
      const control = new MemoryControlStore();
      const runtime = SyncRuntime.v3(vault, control, remote, mapping());
      await runtime.applyPullV3(await runtime.previewPullV3());
      vault.seedMarkdown("Wiki/pages/中文.md", body);
      await remote.seedTree({
        revision: "r2",
        pages: [
          {
            ...(await page("p1", "pages/中文.md", "remote\nline")),
            referencedAttachmentIds: [],
          },
        ],
      });
      const preview = await runtime.previewPullV3();
      for (const conflict of preview.pageConflicts)
        await resolvePageConflictV3(preview, conflict.conflictId, {
          choice: "local",
        });
      await runtime.applyPullV3(preview);
      expect(vault.text("Wiki/pages/中文.md")?.replace(/\r\n/g, "\n")).toBe(
        "local\nline",
      );
      expect((await runtime.previewPushV3()).changes).toHaveLength(1);
      await runtime.recover();
    },
  );

  it("identifies verification hash mismatches without exposing document contents", async () => {
    const expected = {
      ...(await page("p1", "pages/note.md", "expected secret")),
      referencedAttachmentIds: [],
    };
    const preview = {
      revision: "r1",
      base: { attachments: [] },
      remote: { pages: [expected], attachments: [] },
      resolvedFolders: [],
      resolvedPages: [expected],
      resolvedAttachments: [],
    };
    const identities = desiredV3Identities(emptyTreeIdentityStateV2(), preview);
    const error = await verifyResolvedV3Vault({
      vault: new MemoryVault({ "Wiki/pages/note.md": "private actual secret" }),
      rootPath: "Wiki",
      spaceId: "space",
      preview,
      identities,
      capabilities: V3_CAPABILITIES,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("V3_VAULT_VERIFY_FAILED");
    expect(message).toContain("pages/note.md");
    expect(message).toContain("contentHash");
    expect(message).not.toContain("secret");
  });
});

it("verifies a legal multi-page V3 tree using the total-body limit", async () => {
  const pages = await Promise.all(
    [1, 2].map(async (id) => ({
      ...(await page(`p${id}`, `pages/${id}.md`, "123456")),
      referencedAttachmentIds: [],
    })),
  );
  const preview = {
    revision: "r1",
    base: { attachments: [] },
    remote: { pages, attachments: [] },
    resolvedFolders: [],
    resolvedPages: pages,
    resolvedAttachments: [],
  };
  const identities = desiredV3Identities(emptyTreeIdentityStateV2(), preview);
  const vault = new MemoryVault({
    "Wiki/pages/1.md": "123456",
    "Wiki/pages/2.md": "123456",
  });
  await expect(
    verifyResolvedV3Vault({
      vault,
      rootPath: "Wiki",
      spaceId: "space",
      preview,
      identities,
      capabilities: {
        ...V3_CAPABILITIES,
        maxPageBytes: 8,
        maxClientTotalBodyBytes: 16,
      },
    }),
  ).resolves.toBeUndefined();
  await expect(
    verifyResolvedV3Vault({
      vault,
      rootPath: "Wiki",
      spaceId: "space",
      preview,
      identities,
      capabilities: {
        ...V3_CAPABILITIES,
        maxPageBytes: 8,
        maxClientTotalBodyBytes: 10,
      },
    }),
  ).rejects.toThrow(/SPACE_TOO_LARGE/);
});

it("retains V2 restore evidence after preparation fails and the preview closes", async () => {
  const { runtime, control, vault } = await deletedTree();
  const preview = await runtime.previewPull(undefined, { restoreServer: true });
  control.failNextTextWriteAt =
    ".agentwiki/devices/d-local/spaces/s-space/pull/journal.json.next";
  await expect(runtime.applyPull(preview)).rejects.toThrow(
    "injected text write failure",
  );
  const root = ".agentwiki/devices/d-local/spaces/s-space";
  expect(await control.read(`${root}/tree-preview-body/p1.md`)).toBe(
    "server 1",
  );
  await runtime.discardPullPreview(preview);
  expect(await control.read(`${root}/tree-preview-body/p1.md`)).toBe(
    "server 1",
  );
  expect(vault.exists("Wiki/pages/A/1.md")).toBe(false);
  expect(
    await control.read(`${root}/tree-v2/baseline-journal.json`),
  ).not.toBeNull();
});

it("pulls and reopens an additional mapped V3 Space without changing the first Space control state", async () => {
  const control = new MemoryControlStore();
  const vault = new MemoryVault({});
  const firstRemote = new FakeTreeRemoteV3();
  await firstRemote.seedTree({
    pages: [
      {
        ...(await page("p1", "pages/note.md", "first")),
        referencedAttachmentIds: [],
      },
    ],
  });
  const first = SyncRuntime.v3(vault, control, firstRemote, mapping());
  await first.applyPullV3(await first.previewPullV3());
  const before = [...control.files.entries()];
  const extraRemote = new FakeTreeRemoteV3();
  await extraRemote.seedTree({
    spaceId: "space-extra",
    pages: [
      {
        ...(await page("p2", "pages/note.md", "extra")),
        referencedAttachmentIds: [],
      },
    ],
  });
  const extraMapping = {
    spaceId: "space-extra",
    rootPath: "Extra",
    status: "pending" as const,
  };
  const extra = SyncRuntime.v3(vault, control, extraRemote, extraMapping);
  await extra.applyPullV3(await extra.previewPullV3());
  await SyncRuntime.v3(vault, control, extraRemote, extraMapping).recover();
  for (const [path, raw] of before) expect(control.files.get(path)).toBe(raw);
  expect(vault.text("Wiki/pages/note.md")).toBe("first");
  expect(vault.text("Extra/pages/note.md")).toBe("extra");
});

async function restoreReviewFixture() {
  const remote = new FakeTreeRemote();
  await remote.seedTree({
    folders: [],
    pages: [await page("p1", "pages/note.md", "server")],
  });
  const vault = new MemoryVault({});
  const control = new MemoryControlStore();
  const runtime = new SyncRuntime(vault, control, remote, mapping());
  await runtime.applyPull(await runtime.previewPull());
  vault.seedMarkdown("Wiki/pages/note.md", "local before preview\n");
  vault.seedMarkdown("Wiki/pages/Only/draft.md", "draft");
  await remote.advanceEmptyRevision();
  return { remote, vault, control, runtime };
}

describe("Q3 review restore ownership", () => {
  it.each(["body", "raw-newline", "markdown", "pdf", "empty-directory"])(
    "rejects a late %s change before any control or Vault mutation",
    async (change) => {
      const { runtime, vault, control } = await restoreReviewFixture();
      const preview = await runtime.previewPull(undefined, {
        restoreServer: true,
      });
      const before = [...control.files.entries()];
      if (change === "body")
        vault.seedMarkdown("Wiki/pages/note.md", "NEW EDIT AFTER PREVIEW");
      if (change === "raw-newline")
        vault.seedMarkdown("Wiki/pages/note.md", "local before preview\r\n");
      if (change === "markdown")
        vault.seedMarkdown("Wiki/pages/Only/late.md", "NEW UNPREVIEWED FILE");
      if (change === "pdf")
        vault.seedFile("Wiki/pages/Only/late.pdf", new Uint8Array([1, 2, 3]));
      if (change === "empty-directory")
        vault.folders.add("Wiki/pages/Only/late");
      const operations = vault.operations;
      await expect(runtime.applyPull(preview)).rejects.toThrow(
        /STALE_PULL_PREVIEW/,
      );
      expect([...control.files.entries()]).toEqual(before);
      expect(vault.operations).toBe(operations);
      expect(vault.text("Wiki/pages/Only/draft.md")).toBe("draft");
      expect((await runtime.remoteDelta()).ahead).toBe(true);
    },
  );

  it.each([
    "document.pdf",
    "image.png",
    "nested/document.pdf",
    ".agentwiki/private.bin",
  ])(
    "blocks restore of a folder containing unmanaged %s at preview time",
    async (file) => {
      const { runtime, vault, control } = await restoreReviewFixture();
      const path = `Wiki/pages/Only/${file}`;
      vault.seedFile(path, new Uint8Array([1, 2, 3]));
      const operations = vault.operations;
      const baseline = [...control.files.entries()].filter(([p]) =>
        p.includes("tree-v2/"),
      );
      const error = await runtime
        .previewPull(undefined, { restoreServer: true })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "SERVER_RESTORE_UNMANAGED_DESCENDANT",
      );
      expect((error as Error).message).toContain(
        file.startsWith(".agentwiki/") ? ".agentwiki" : file,
      );
      expect(vault.operations).toBe(operations);
      expect(await vault.read(path)).toEqual(new Uint8Array([1, 2, 3]));
      expect(vault.text("Wiki/pages/Only/draft.md")).toBe("draft");
      expect(
        [...control.files.entries()].filter(([p]) => p.includes("tree-v2/")),
      ).toEqual(baseline);
    },
  );

  it("blocks a late edit made inside the real server confirmation flow", async () => {
    const { runtime, vault, control } = await restoreReviewFixture();
    const harness = await makePlugin({
      data: {
        schemaVersion: 2,
        serverUrl: "https://wiki.example.com",
        mappings: [{ spaceId: "space", rootPath: "Wiki", status: "active" }],
      },
    });
    await harness.plugin.onload();
    const subject = harness.plugin as unknown as {
      runtime: () => Promise<SyncRuntime>;
      runSyncStrategy: (
        id: string,
        strategy: "server",
        options: object,
      ) => Promise<ModalTransition | void>;
    };
    subject.runtime = async () => runtime;
    const open = vi
      .spyOn(PreviewModal.prototype, "open")
      .mockImplementation(function (this: PreviewModal) {
        this.onOpen();
      });
    const apply = vi.spyOn(runtime, "applyPull");
    try {
      const transition = await subject.runSyncStrategy("space", "server", {});
      transition?.();
      const before = [...control.files.entries()];
      vault.seedMarkdown("Wiki/pages/note.md", "late UI edit");
      vault.seedMarkdown("Wiki/pages/Only/late.md", "late UI addition");
      modalButton(open.mock.instances.at(-1)!, "确认执行").dispatchEvent({
        type: "click",
      });
      await vi.waitFor(() => expect(apply).toHaveBeenCalled());
      await expect(apply.mock.results[0]!.value).rejects.toThrow(
        /STALE_PULL_PREVIEW/,
      );
      expect(vault.text("Wiki/pages/note.md")).toBe("late UI edit");
      expect(vault.text("Wiki/pages/Only/late.md")).toBe("late UI addition");
      expect([...control.files.entries()]).toEqual(before);
      expect((await runtime.remoteDelta()).ahead).toBe(true);
    } finally {
      apply.mockRestore();
      open.mockRestore();
    }
  });
});

it("rejects a hidden descendant added after transaction preparation", async () => {
  const { runtime, vault, control } = await restoreReviewFixture();
  const preview = await runtime.previewPull(undefined, { restoreServer: true });
  control.onTextWrite = (path) => {
    if (
      path.endsWith("/pull/journal.json.next") &&
      (JSON.parse(control.files.get(path)!) as { payload: { state: string } })
        .payload.state === "applying"
    ) {
      vault.seedFile(
        "Wiki/pages/Only/.agentwiki/private.bin",
        new Uint8Array([4, 5, 6]),
      );
      control.onTextWrite = undefined;
    }
  };
  await expect(runtime.applyPull(preview)).rejects.toThrow(
    /TREE_TRANSACTION_AMBIGUOUS/,
  );
  expect(await vault.read("Wiki/pages/Only/.agentwiki/private.bin")).toEqual(
    new Uint8Array([4, 5, 6]),
  );
  expect((await runtime.remoteDelta()).ahead).toBe(true);
});

it("rejects an unbound copy of a restore preview", async () => {
  const { runtime, vault, control } = await restoreReviewFixture();
  const preview = await runtime.previewPull(undefined, { restoreServer: true });
  const before = [...control.files.entries()];
  await expect(runtime.applyPull(structuredClone(preview))).rejects.toThrow(
    /STALE_PULL_PREVIEW/,
  );
  expect([...control.files.entries()]).toEqual(before);
  expect(vault.text("Wiki/pages/Only/draft.md")).toBe("draft");
});

it("rechecks full membership after the cancellable apply checkpoint", async () => {
  const { runtime, vault, control } = await restoreReviewFixture();
  const preview = await runtime.previewPull(undefined, { restoreServer: true });
  const before = [...control.files.entries()];
  await expect(
    runtime.applyPull(preview, {
      onProgress: () => {
        vault.seedMarkdown("Wiki/pages/Only/checkpoint.md", "late");
      },
    }),
  ).rejects.toThrow(/STALE_PULL_PREVIEW/);
  expect([...control.files.entries()]).toEqual(before);
  expect(vault.text("Wiki/pages/Only/checkpoint.md")).toBe("late");
});
