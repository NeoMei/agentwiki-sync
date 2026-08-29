import { describe, expect, it } from "vitest";
import { SyncRuntime } from "../../src/application/sync-runtime";
import {
  canonicalBytes,
  confirmationHash,
  contentHash,
  sha256Hex,
} from "../../src/agentwiki/protocol";
import { FakeTreeRemote } from "../fakes/fake-tree-remote";
import { FakeAgentWiki } from "../fakes/fake-agentwiki";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { MemoryVault } from "../fakes/memory-vault";
import { BaselineRepository } from "../../src/storage/baseline";
import { TreeBaselineRepository } from "../../src/storage/tree-baseline";
import { PushService } from "../../src/application/push-service";
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

  it("rejects a truncated remote snapshot before planning destructive Pull actions", async () => {
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
    remote.truncateNextSnapshot = true;
    await expect(runtime.previewPull()).rejects.toThrow(
      /快照(完整性|字节数|对象数量)/,
    );
    expect(vault.text("Wiki/pages/A.md")).toBe("base");
  });

  it("rejects a remote page whose body does not match its content hash", async () => {
    const remote = new FakeTreeRemote();
    const body = "base";
    await remote.seed([
      {
        pageId: "p1",
        path: "pages/A.md",
        title: "A",
        body: "tampered",
        contentHash: await contentHash(body),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const runtime = new SyncRuntime(
      new MemoryVault({}),
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await expect(runtime.previewPull()).rejects.toThrow(/内容哈希不匹配/);
  });

  it("preserves the archived page identity across a local-wins archive", async () => {
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
    const push = await runtime.previewPush();
    expect(push.changes[0]).toMatchObject({
      operation: "upsert_page",
      page: { pageId: "p1", path: "pages/A.md" },
    });
  });

  it("binds a same-path local document during initial pull and keeps it dirty", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/A.md", "remote")]);
    const vault = new MemoryVault({ "Wiki/pages/A.md": "local" });
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    const preview = await runtime.previewPull();
    expect(preview.pageConflicts).toHaveLength(1);
    await expect(runtime.applyPull(preview)).rejects.toThrow(/冲突/);
    preview.pageConflictResolutions[preview.pageConflicts[0]!.conflictId] = {
      choice: "local",
    };
    await runtime.applyPull(preview);
    expect(vault.text("Wiki/pages/A.md")).toBe("local");
    expect((await runtime.status()).local.modified).toHaveLength(1);
  });

  it("uses a v1 confirmation hash for the v1 tree adapter", async () => {
    const remote = new FakeTreeRemote();
    remote.setProtocol("1");
    const vault = new MemoryVault({ "Wiki/pages/New.md": "new" });
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.establishEmptyBase();
    const preview = await runtime.previewPush();
    const upsert = preview.changes.find(
      (change) => change.operation === "upsert_page",
    )!;
    await runtime.applyPush(preview);
    expect((await remote.snapshot()).items[0]?.body).toBe("new");
    const manifest = {
      protocolVersion: "1" as const,
      spaceId: "space",
      baseRevision: "0",
      changes: [
        {
          operation: "upsert" as const,
          pageId: upsert.page.pageId,
          path: "pages/New.md",
          title: "New",
          contentHash: upsert.page.contentHash,
        },
      ],
    };
    expect(remote.lastCreateInput?.confirmationHash).toBe(
      await confirmationHash(manifest),
    );
  });

  it("does not delete unfinished journals before recovering", async () => {
    const remote = new FakeTreeRemote();
    const vault = new MemoryVault({ "Wiki/pages/A.md": "a" });
    const control = new MemoryControlStore();
    const runtime = new SyncRuntime(vault, control, remote, mapping());
    await runtime.establishEmptyBase();
    remote.canPublish = false;
    const preview = await runtime.previewPush();
    await expect(runtime.applyPush(preview)).rejects.toThrow(/SPACE_READ_ONLY/);
    const journalPath =
      ".agentwiki/devices/d-local/spaces/s-space/push/journal.json";
    expect(await control.read(journalPath)).not.toBeNull();
    remote.canPublish = true;
    await runtime.recover();
    expect(await control.read(journalPath)).not.toBeNull();
  });

  it("fails closed on an unknown future push journal version", async () => {
    const remote = new FakeTreeRemote();
    const control = new MemoryControlStore();
    const runtime = new SyncRuntime(
      new MemoryVault({}),
      control,
      remote,
      mapping(),
    );
    await control.write(
      ".agentwiki/devices/d-local/spaces/s-space/push/journal.json",
      JSON.stringify({
        envelopeSchemaVersion: 1,
        writeGeneration: 1,
        payloadHash: "x".repeat(64),
        payload: { schemaVersion: 3, spaceId: "space" },
      }),
    );
    await expect(runtime.recover()).rejects.toThrow(/不支持的推送日志版本/);
  });

  it("clones an empty-bodied page without treating it as a missing sidecar", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("empty", "pages/Empty.md", "")]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    expect(vault.text("Wiki/pages/Empty.md")).toBe("");
  });

  it("supersedes an unfinished Push after credential rotation instead of replaying it", async () => {
    const remote = new FakeTreeRemote();
    const vault = new MemoryVault({ "Wiki/pages/A.md": "a" });
    const control = new MemoryControlStore();
    const m = mapping();
    const runtimeA = new SyncRuntime(
      vault,
      control,
      remote,
      m,
      "device",
      "space",
      "cred-a",
    );
    await runtimeA.establishEmptyBase();
    remote.canPublish = false;
    const preview = await runtimeA.previewPush();
    await expect(runtimeA.applyPush(preview)).rejects.toThrow(
      /SPACE_READ_ONLY/,
    );
    remote.canPublish = true;
    const runtimeB = new SyncRuntime(
      vault,
      control,
      remote,
      m,
      "device",
      "space",
      "cred-b",
    );
    await runtimeB.recover();
    expect(await runtimeB.hasUnfinishedPush()).toBe(false);
  });

  it("does not block disconnect after a cancelled Push is superseded", async () => {
    const remote = new FakeTreeRemote();
    const runtime = new SyncRuntime(
      new MemoryVault({ "Wiki/pages/A.md": "a" }),
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.establishEmptyBase();
    const preview = await runtime.previewPush();
    const controller = new AbortController();
    await expect(
      runtime.applyPush(preview, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === "upload" && progress.completed >= 1)
            controller.abort();
        },
      }),
    ).rejects.toThrow(/取消/);
    expect(await runtime.hasUnfinishedPush()).toBe(false);
    expect((await runtime.status()).local.added).toHaveLength(1);
  });

  it("yields and cancels while scanning local files before creating a Push", async () => {
    const remote = new FakeTreeRemote();
    const vault = new MemoryVault(
      Object.fromEntries(
        Array.from({ length: 60 }, (_, index) => [
          "Wiki/pages/P" + index + ".md",
          "page " + index,
        ]),
      ),
    );
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    const controller = new AbortController();
    await expect(
      runtime.previewPush({
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === "scan" && progress.completed >= 50)
            controller.abort();
        },
      }),
    ).rejects.toThrow(/取消/);
    expect(remote.sessionCount()).toBe(0);
  });

  it("yields and cancels while planning local archives", async () => {
    const remote = new FakeTreeRemote();
    const pages = await Promise.all(
      Array.from({ length: 60 }, async (_, index) =>
        page("p" + index, "pages/P" + index + ".md", "page " + index),
      ),
    );
    await remote.seed(pages);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    for (let index = 0; index < 60; index += 1)
      await vault.remove("Wiki/pages/P" + index + ".md");
    const controller = new AbortController();
    await expect(
      runtime.previewPush({
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === "merge" && progress.completed >= 50)
            controller.abort();
        },
      }),
    ).rejects.toThrow(/取消/);
  });

  it("routes a schema-1 push journal through the legacy push service", async () => {
    const legacyRemote = new FakeAgentWiki();
    const control = new MemoryControlStore();
    const root = ".agentwiki/devices/d-device/spaces/s-space";
    const v1 = new PushService(legacyRemote, control, root + "/push");
    legacyRemote.canPublish = false;
    await expect(
      v1.publish({
        spaceId: "space",
        baseRevision: "0",
        capabilities: legacyRemote.capabilities,
        changes: [
          {
            operation: "upsert",
            pageId: "p1",
            path: "pages/A.md",
            title: "A",
            body: "a",
            contentHash: await contentHash("a"),
          },
        ],
      }),
    ).rejects.toThrow(/SPACE_READ_ONLY/);
    legacyRemote.canPublish = true;
    const runtime = new SyncRuntime(
      new MemoryVault({}),
      control,
      new FakeTreeRemote(),
      mapping(),
      "device",
      "space",
      "cred",
      legacyRemote,
    );
    expect(await runtime.hasUnfinishedPush()).toBe(true);
    await runtime.recover();
    expect(await runtime.hasUnfinishedPush()).toBe(false);
  });

  it("picks the highest writeGeneration journal candidate for routing", async () => {
    const remote = new FakeTreeRemote();
    const control = new MemoryControlStore();
    const runtime = new SyncRuntime(
      new MemoryVault({}),
      control,
      remote,
      mapping(),
    );
    const base = ".agentwiki/devices/d-local/spaces/s-space/push";
    await control.write(
      base + "/journal.json",
      JSON.stringify({
        envelopeSchemaVersion: 1,
        writeGeneration: 1,
        payloadHash: "x".repeat(64),
        payload: { schemaVersion: 1 },
      }),
    );
    await control.write(
      base + "/journal.json.next",
      JSON.stringify({
        envelopeSchemaVersion: 1,
        writeGeneration: 2,
        payloadHash: "x".repeat(64),
        payload: { schemaVersion: 3 },
      }),
    );
    await expect(runtime.recover()).rejects.toThrow(/不支持的推送日志版本/);
  });

  it("applies a legacy pull-control-after state during recovery", async () => {
    const control = new MemoryControlStore();
    const root = ".agentwiki/devices/d-local/spaces/s-space";
    const runtime = new SyncRuntime(
      new MemoryVault({}),
      control,
      new FakeTreeRemote(),
      mapping(),
    );
    const writeEnvelope = async (path: string, payload: unknown) => {
      await control.write(
        path,
        JSON.stringify({
          envelopeSchemaVersion: 1,
          writeGeneration: 1,
          payloadHash: await sha256Hex(canonicalBytes(payload)),
          payload,
        }),
      );
    };
    await writeEnvelope(root + "/pull/journal.json", {
      schemaVersion: 1,
      transactionId: "tx1",
      state: "committed",
      scanEpoch: 0,
      actions: [],
      snapshots: [],
      temporaryPaths: [],
      materialized: [],
    });
    await writeEnvelope(root + "/pull-control-after.json", {
      schemaVersion: 1,
      transactionId: "tx1",
      phase: "pending",
      identities: {
        schemaVersion: 1,
        entries: {
          p1: {
            intent: "restore",
            pageId: "p1",
            path: "pages/A.md",
            contentHash: "h".repeat(64),
            archivedBasePath: "pages/A.md",
            archivedBaseTitle: "A",
            archivedBaseContentHash: "h".repeat(64),
          },
        },
      },
      moveHints: {
        schemaVersion: 1,
        hints: [
          {
            pageId: "p1",
            fromPath: "pages/A.md",
            toPath: "pages/B.md",
            observedVaultByteHash: "h".repeat(64),
          },
        ],
      },
    });
    await runtime.recover();
    const identities = JSON.parse(
      (await control.read(root + "/tree-identities.json"))!,
    ) as {
      payload: {
        pendingPages: Record<string, { pageId: string; path: string }>;
      };
    };
    expect(identities.payload.pendingPages.p1).toMatchObject({
      pageId: "p1",
      path: "pages/A.md",
    });
    const moveHints = JSON.parse(
      (await control.read(root + "/move-hints.json"))!,
    ) as { payload: { hints: Array<{ pageId: string; toPath: string }> } };
    expect(moveHints.payload.hints[0]).toMatchObject({
      pageId: "p1",
      toPath: "pages/B.md",
    });
  });

  it("pushes a v1 nested page path without folder changes", async () => {
    const remote = new FakeTreeRemote();
    remote.setProtocol("1");
    const vault = new MemoryVault({ "Wiki/pages/A/P.md": "# p" });
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.establishEmptyBase();
    const preview = await runtime.previewPush();
    expect(
      preview.changes.filter((change) => change.operation === "upsert_folder"),
    ).toHaveLength(0);
    expect(
      preview.changes.some(
        (change) =>
          change.operation === "upsert_page" &&
          change.page.path === "pages/A/P.md",
      ),
    ).toBe(true);
    await runtime.applyPush(preview);
    expect((await remote.snapshot()).items[0]?.path).toBe("pages/A/P.md");
  });

  it("rejects a snapshot whose page exceeds the body byte limit", async () => {
    const remote = new FakeTreeRemote();
    const huge = "x".repeat(2 * 1024 * 1024);
    await remote.seed([
      {
        pageId: "p1",
        path: "pages/A.md",
        title: "A",
        body: huge,
        contentHash: await contentHash(huge),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const runtime = new SyncRuntime(
      new MemoryVault({}),
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await expect(runtime.previewPull()).rejects.toThrow(/PAGE_TOO_LARGE/);
  });
});
