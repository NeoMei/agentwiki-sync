import { describe, expect, it } from "vitest";
import { SyncRuntime } from "../../src/application/sync-runtime";
import { FakeAgentWiki } from "../fakes/fake-agentwiki";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { MemoryVault } from "../fakes/memory-vault";
import { contentHash } from "../../src/agentwiki/protocol";
import { PushService } from "../../src/application/push-service";

describe("SyncRuntime", () => {
  it("reports remote delta items since the base revision", async () => {
    const remote = new FakeAgentWiki();
    const body = "hello";
    await remote.seed([
      {
        pageId: "p1",
        path: "Guide.md",
        title: "Guide",
        body,
        contentHash: await contentHash(body),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    const pullPreview = await runtime.previewPull();
    await runtime.applyPull(pullPreview);

    const clean = await runtime.remoteDelta();
    expect(clean.ahead).toBe(false);
    expect(clean.items).toHaveLength(0);

    const nextBody = "hello v2";
    await remote.replace([
      {
        pageId: "p1",
        path: "Guide.md",
        title: "Guide",
        body: nextBody,
        contentHash: await contentHash(nextBody),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const ahead = await runtime.remoteDelta();
    expect(ahead.ahead).toBe(true);
    expect(ahead.listed).toBe(true);
    expect(ahead.items).toHaveLength(1);
    expect(ahead.items[0]).toMatchObject({
      operation: "upsert",
      page: { path: "Guide.md" },
    });
  });

  it("clones a pending remote mapping, then reports clean", async () => {
    const remote = new FakeAgentWiki();
    const seed = "hello";
    await remote.seed([
      {
        pageId: "p1",
        path: "Guide.md",
        title: "Guide",
        body: seed,
        contentHash: await contentHash(seed),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    const preview = await runtime.previewPull();
    expect(preview.initialBindings).toHaveLength(1);
    await runtime.applyPull(preview);
    expect(vault.text("Wiki/Guide.md")).toBe("hello");
    expect((await runtime.status()).local.added).toHaveLength(0);
  });

  it("previews and pushes local edits only after explicit apply", async () => {
    const remote = new FakeAgentWiki();
    const vault = new MemoryVault({ "Wiki/New.md": "new" });
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    await runtime.establishEmptyBase();
    const preview = await runtime.previewPush();
    expect(preview.changes).toHaveLength(1);
    const repeated = await runtime.previewPush();
    expect(repeated.changes[0]?.pageId).toBe(preview.changes[0]?.pageId);
    expect((await remote.snapshot()).items).toHaveLength(0);
    await runtime.applyPush(preview);
    expect((await remote.snapshot()).items[0]?.body).toBe("new");
  });

  it("first-publishes local content from a relation-only nonzero remote head without prebuilding a base", async () => {
    const remote = new FakeAgentWiki();
    await remote.advanceEmptyRevision();
    const vault = new MemoryVault({ "Wiki/New.md": "new" });
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    const preview = await runtime.previewPush();
    expect(preview.revision).toBe("1");
    expect(preview.changes).toHaveLength(1);
    await runtime.applyPush(preview);
    expect((await remote.snapshot()).items[0]?.body).toBe("new");
  });

  it("requires initial Pull before pending local content can be pushed over remote pages", async () => {
    const remote = new FakeAgentWiki();
    await remote.seed([
      {
        pageId: "p1",
        path: "Remote.md",
        title: "Remote",
        body: "remote",
        contentHash: await contentHash("remote"),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const runtime = new SyncRuntime(
      new MemoryVault({ "Wiki/Local.md": "local" }),
      new MemoryControlStore(),
      remote,
      { spaceId: "space", rootPath: "Wiki", status: "pending" },
    );
    await expect(runtime.previewPush()).rejects.toThrow(
      /INITIAL_PULL_REQUIRED/,
    );
  });

  it("rejects duplicate page identities and body hash mismatches in snapshots", async () => {
    const remote = new FakeAgentWiki();
    await remote.seed([
      {
        pageId: "p1",
        path: "A.md",
        title: "A",
        body: "tampered",
        contentHash: await contentHash("different"),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const runtime = new SyncRuntime(
      new MemoryVault({}),
      new MemoryControlStore(),
      remote,
      { spaceId: "space", rootPath: "Wiki", status: "pending" },
    );
    await expect(runtime.previewPull()).rejects.toThrow(/内容哈希不匹配/);
  });

  it("three-way merges non-overlapping local and remote edits and keeps local-only changes dirty", async () => {
    const remote = new FakeAgentWiki();
    const original = "top\nmiddle\nbottom";
    await remote.seed([
      {
        pageId: "p1",
        path: "Guide.md",
        title: "Guide",
        body: original,
        contentHash: await contentHash(original),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = new SyncRuntime(vault, control, remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    await runtime.applyPull(await runtime.previewPull());
    await vault.write(
      "Wiki/Guide.md",
      new TextEncoder().encode("TOP\nmiddle\nbottom"),
    );
    const remoteEdit = "top\nmiddle\nBOTTOM";
    await remote.replace([
      {
        pageId: "p1",
        path: "Guide.md",
        title: "Guide",
        body: remoteEdit,
        contentHash: await contentHash(remoteEdit),
        updatedAt: "2026-08-14T00:01:00.000Z",
      },
    ]);
    const preview = await runtime.previewPull();
    expect(preview.conflicts).toHaveLength(0);
    const write = preview.actions[0];
    expect(write).toMatchObject({ kind: "write" });
    if (!write || write.kind === "trash") throw new Error("missing write");
    expect(await control.read(write.bodyPath!)).toBe("TOP\nmiddle\nBOTTOM");
    await runtime.applyPull(preview);
    expect((await runtime.status()).local.modified).toHaveLength(1);
  });

  it("blocks Pull application until structured conflicts are resolved", async () => {
    const remote = new FakeAgentWiki();
    const original = "same";
    await remote.seed([
      {
        pageId: "p1",
        path: "A.md",
        title: "A",
        body: original,
        contentHash: await contentHash(original),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    await runtime.applyPull(await runtime.previewPull());
    await vault.write("Wiki/A.md", new TextEncoder().encode("local"));
    await remote.replace([
      {
        pageId: "p1",
        path: "A.md",
        title: "A",
        body: "remote",
        contentHash: await contentHash("remote"),
        updatedAt: "2026-08-14T00:01:00.000Z",
      },
    ]);
    const preview = await runtime.previewPull();
    expect(preview.conflicts).toHaveLength(1);
    await expect(runtime.applyPull(preview)).rejects.toThrow(/冲突/);
    preview.conflictResolutions[preview.conflicts[0]!.conflictId] = {
      choice: "remote",
    };
    await runtime.applyPull(preview);
    expect(vault.text("Wiki/A.md")).toBe("remote");
  });

  it("applies one coherent rename and body resolution for the same conflicted page", async () => {
    const remote = new FakeAgentWiki();
    await remote.seed([
      {
        pageId: "p1",
        path: "A.md",
        title: "A",
        body: "base",
        contentHash: await contentHash("base"),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    await runtime.applyPull(await runtime.previewPull());
    await vault.rename("Wiki/A.md", "Wiki/Local.md");
    await runtime.recordRename("Wiki/A.md", "Wiki/Local.md");
    await vault.write("Wiki/Local.md", new TextEncoder().encode("local"));
    await remote.replace([
      {
        pageId: "p1",
        path: "Remote.md",
        title: "Remote",
        body: "remote",
        contentHash: await contentHash("remote"),
        updatedAt: "2026-08-14T00:01:00.000Z",
      },
    ]);
    const preview = await runtime.previewPull();
    for (const conflict of preview.conflicts)
      preview.conflictResolutions[conflict.conflictId] = { choice: "remote" };
    await runtime.applyPull(preview);
    expect(vault.exists("Wiki/Local.md")).toBe(false);
    expect(vault.text("Wiki/Remote.md")).toBe("remote");
  });

  it("treats remote archive versus local edit as a conflict", async () => {
    const remote = new FakeAgentWiki();
    const original = "base";
    await remote.seed([
      {
        pageId: "p1",
        path: "A.md",
        title: "A",
        body: original,
        contentHash: await contentHash(original),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    await runtime.applyPull(await runtime.previewPull());
    await vault.write("Wiki/A.md", new TextEncoder().encode("local edit"));
    await remote.replace([]);
    const preview = await runtime.previewPull();
    expect(preview.conflicts).toHaveLength(1);
    expect(preview.actions).toHaveLength(0);
  });

  it("preserves the archived page identity when Local is chosen for an archive conflict", async () => {
    const remote = new FakeAgentWiki();
    await remote.seed([
      {
        pageId: "p1",
        path: "A.md",
        title: "A",
        body: "base",
        contentHash: await contentHash("base"),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    await runtime.applyPull(await runtime.previewPull());
    await vault.write("Wiki/A.md", new TextEncoder().encode("local"));
    await remote.replace([]);
    const preview = await runtime.previewPull();
    preview.conflictResolutions[preview.conflicts[0]!.conflictId] = {
      choice: "local",
    };
    await runtime.applyPull(preview);
    const push = await runtime.previewPush();
    expect(push.changes[0]).toMatchObject({
      operation: "upsert",
      pageId: "p1",
      path: "A.md",
    });
  });

  it("keeps the local file with manual content when Manual is chosen for an archive conflict", async () => {
    const remote = new FakeAgentWiki();
    await remote.seed([
      {
        pageId: "p1",
        path: "A.md",
        title: "A",
        body: "base",
        contentHash: await contentHash("base"),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    await runtime.applyPull(await runtime.previewPull());
    await vault.write("Wiki/A.md", new TextEncoder().encode("local"));
    await remote.replace([]);
    const preview = await runtime.previewPull();
    preview.conflictResolutions[preview.conflicts[0]!.conflictId] = {
      choice: "manual",
      manualValue: "manual final",
    };
    await runtime.applyPull(preview);
    expect(vault.text("Wiki/A.md")).toBe("manual final");
    const push = await runtime.previewPush();
    expect(push.changes[0]).toMatchObject({
      operation: "upsert",
      pageId: "p1",
      path: "A.md",
    });
  });

  it("ignores internal temporary renames when recording move hints", async () => {
    const remote = new FakeAgentWiki();
    await remote.seed([
      {
        pageId: "p1",
        path: "A.md",
        title: "A",
        body: "base",
        contentHash: await contentHash("base"),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = new SyncRuntime(vault, control, remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    await runtime.applyPull(await runtime.previewPull());
    await runtime.recordRename("Wiki/A.md", "Wiki/A.md.agentwiki-tmp-0");
    const envelope = JSON.parse(
      (await control.read(
        ".agentwiki/devices/d-local/spaces/s-space/move-hints.json",
      )) ?? "null",
    ) as { payload?: { hints?: unknown[] } } | null;
    expect(envelope?.payload?.hints ?? []).toHaveLength(0);
    await vault.rename("Wiki/A.md", "Wiki/B.md");
    await runtime.recordRename("Wiki/A.md", "Wiki/B.md");
    const updated = JSON.parse(
      (await control.read(
        ".agentwiki/devices/d-local/spaces/s-space/move-hints.json",
      ))!,
    ) as {
      payload: {
        hints: Array<{
          pageId: string;
          fromPath: string;
          toPath: string;
          observedVaultByteHash: string;
        }>;
      };
    };
    expect(updated.payload.hints).toHaveLength(1);
    expect(updated.payload.hints[0]).toMatchObject({
      pageId: "p1",
      fromPath: "A.md",
      toPath: "B.md",
    });
    expect(updated.payload.hints[0]?.observedVaultByteHash).toEqual(
      expect.any(String),
    );
  });

  it("prunes stale generations after each committed baseline", async () => {
    const remote = new FakeAgentWiki();
    await remote.seed([
      {
        pageId: "p1",
        path: "A.md",
        title: "A",
        body: "base",
        contentHash: await contentHash("base"),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = new SyncRuntime(vault, control, remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    const generationsRoot =
      ".agentwiki/devices/d-local/spaces/s-space/generations";
    const countGenerations = async () =>
      (await control.list(generationsRoot)).folders.length;

    await runtime.applyPull(await runtime.previewPull());
    expect(await countGenerations()).toBe(1);

    for (let version = 2; version <= 7; version += 1) {
      await vault.write(
        "Wiki/A.md",
        new TextEncoder().encode(`local v${version}`),
      );
      await runtime.applyPush(await runtime.previewPush());

      // Only the current and rollback generations remain after arbitrarily
      // many commits; stale full snapshots must not accumulate over time.
      expect(await countGenerations()).toBeLessThanOrEqual(2);
    }
  });

  it("returns clean without creating an empty push session", async () => {
    const remote = new FakeAgentWiki();
    const runtime = new SyncRuntime(
      new MemoryVault({}),
      new MemoryControlStore(),
      remote,
      { spaceId: "space", rootPath: "Wiki", status: "pending" },
    );
    await runtime.establishEmptyBase();
    const preview = await runtime.previewPush();
    expect(preview.changes).toHaveLength(0);
    await runtime.applyPush(preview);
    expect(remote.sessionCount()).toBe(0);
  });

  it("yields every 50 scanned files and cancels before creating a Push", async () => {
    const remote = new FakeAgentWiki();
    const vault = new MemoryVault(
      Object.fromEntries(
        Array.from({ length: 60 }, (_, index) => [
          `Wiki/P${index}.md`,
          `page ${index}`,
        ]),
      ),
    );
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    const controller = new AbortController();
    const previewPush = runtime.previewPush.bind(runtime);
    await expect(
      previewPush({
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === "scan" && progress.completed >= 50)
            controller.abort();
        },
      }),
    ).rejects.toThrow(/取消/);
    expect(remote.sessionCount()).toBe(0);
  });

  it("yields and cancels while planning 60 local archives", async () => {
    const remote = new FakeAgentWiki();
    const pages = await Promise.all(
      Array.from({ length: 60 }, async (_, index) => {
        const body = `page ${index}`;
        return {
          pageId: `p${index}`,
          path: `P${index}.md`,
          title: `P${index}`,
          body,
          contentHash: await contentHash(body),
          updatedAt: "2026-08-14T00:00:00.000Z",
        };
      }),
    );
    await remote.seed(pages);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    await runtime.applyPull(await runtime.previewPull());
    for (let index = 0; index < 60; index += 1)
      await vault.remove(`Wiki/P${index}.md`);
    await vault.write("Wiki/.keep", new TextEncoder().encode("keep folder"));
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

  it("yields and cancels while planning 60 remote archives", async () => {
    const remote = new FakeAgentWiki();
    const pages = await Promise.all(
      Array.from({ length: 60 }, async (_, index) => {
        const body = `page ${index}`;
        return {
          pageId: `p${index}`,
          path: `P${index}.md`,
          title: `P${index}`,
          body,
          contentHash: await contentHash(body),
          updatedAt: "2026-08-14T00:00:00.000Z",
        };
      }),
    );
    await remote.seed(pages);
    const runtime = new SyncRuntime(
      new MemoryVault({}),
      new MemoryControlStore(),
      remote,
      { spaceId: "space", rootPath: "Wiki", status: "pending" },
    );
    await runtime.applyPull(await runtime.previewPull());
    await remote.replace([]);
    const controller = new AbortController();
    await expect(
      runtime.previewPull({
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === "merge" && progress.completed >= 50)
            controller.abort();
        },
      }),
    ).rejects.toThrow(/取消/);
  });

  it("rejects a truncated remote snapshot before planning destructive Pull actions", async () => {
    const remote = new FakeAgentWiki();
    const body = "base";
    await remote.seed([
      {
        pageId: "p1",
        path: "A.md",
        title: "A",
        body,
        contentHash: await contentHash(body),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    await runtime.applyPull(await runtime.previewPull());
    remote.truncateNextSnapshot = true;
    await expect(runtime.previewPull()).rejects.toThrow(/快照完整性/);
    expect(vault.text("Wiki/A.md")).toBe("base");
  });

  it("moves the existing page when the remote renames the same pageId", async () => {
    const remote = new FakeAgentWiki();
    const body = "body";
    await remote.seed([
      {
        pageId: "p1",
        path: "Old.md",
        title: "Old",
        body,
        contentHash: await contentHash(body),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    await runtime.applyPull(await runtime.previewPull());
    await remote.replace([
      {
        pageId: "p1",
        path: "New.md",
        title: "New",
        body,
        contentHash: await contentHash(body),
        updatedAt: "2026-08-14T00:01:00.000Z",
      },
    ]);
    const preview = await runtime.previewPull();
    expect(preview.actions[0]).toMatchObject({
      kind: "rename",
      fromPath: "Wiki/Old.md",
      path: "Wiki/New.md",
    });
    await runtime.applyPull(preview);
    expect(vault.exists("Wiki/Old.md")).toBe(false);
    expect(vault.text("Wiki/New.md")).toBe(body);
  });

  it("renames an unchanged local opaque file to the canonical title path without changing its body", async () => {
    const remote = new FakeAgentWiki();
    const opaque = `pages/p-${"a".repeat(64)}.md`;
    const body = "# 吃饭\n\n正文";
    await remote.seed([
      {
        pageId: "p1",
        path: opaque,
        title: "吃饭",
        body,
        contentHash: await contentHash(body),
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
    ]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    await runtime.applyPull(await runtime.previewPull());
    const beforeHash = await contentHash(vault.text(`Wiki/${opaque}`)!);

    await remote.replace([
      {
        pageId: "p1",
        path: "pages/吃饭.md",
        title: "吃饭",
        body,
        contentHash: await contentHash(body),
        updatedAt: "2026-08-20T00:01:00.000Z",
      },
    ]);
    const preview = await runtime.previewPull();
    expect(preview.conflicts).toHaveLength(0);
    expect(preview.actions).toEqual([
      expect.objectContaining({
        kind: "rename",
        fromPath: `Wiki/${opaque}`,
        path: "Wiki/pages/吃饭.md",
      }),
    ]);

    await runtime.applyPull(preview);

    expect(vault.exists(`Wiki/${opaque}`)).toBe(false);
    expect(vault.text("Wiki/pages/吃饭.md")).toBe(body);
    expect(await contentHash(vault.text("Wiki/pages/吃饭.md")!)).toBe(
      beforeHash,
    );
  });

  it("reports a path conflict when local and remote rename the same opaque page differently", async () => {
    const remote = new FakeAgentWiki();
    const opaque = `pages/p-${"b".repeat(64)}.md`;
    const body = "# 吃饭\n\n正文";
    await remote.seed([
      {
        pageId: "p1",
        path: opaque,
        title: "吃饭",
        body,
        contentHash: await contentHash(body),
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
    ]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    await runtime.applyPull(await runtime.previewPull());
    await vault.rename(`Wiki/${opaque}`, "Wiki/Guides/吃饭.md");
    await runtime.recordRename(`Wiki/${opaque}`, "Wiki/Guides/吃饭.md");
    await remote.replace([
      {
        pageId: "p1",
        path: "pages/吃饭.md",
        title: "吃饭",
        body,
        contentHash: await contentHash(body),
        updatedAt: "2026-08-20T00:01:00.000Z",
      },
    ]);

    const preview = await runtime.previewPull();

    const pathConflict = preview.conflicts.find(
      (conflict) => conflict.pageId === "p1" && conflict.field === "path",
    );
    expect(pathConflict).toBeDefined();
    expect(await runtime.conflictSummary(preview, pathConflict!)).toEqual({
      base: opaque,
      local: "Guides/吃饭.md",
      remote: "pages/吃饭.md",
    });
    expect(preview.actions).toHaveLength(0);
    expect(vault.exists("Wiki/Guides/吃饭.md")).toBe(true);
  });

  it("keeps a same-path local document dirty during initial binding", async () => {
    const remote = new FakeAgentWiki();
    const vault = new MemoryVault({ "Wiki/A.md": "local" });
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    await remote.seed([
      {
        pageId: "p1",
        path: "A.md",
        title: "A",
        body: "remote",
        contentHash: await contentHash("remote"),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const preview = await runtime.previewPull();
    expect(preview.initialBindings[0]?.resolution).toBeNull();
    await expect(runtime.applyPull(preview)).rejects.toThrow(/未解决/);
    preview.initialBindings[0]!.resolution = "local";
    await runtime.applyPull(preview);
    expect(vault.text("Wiki/A.md")).toBe("local");
    expect((await runtime.status()).local.modified).toHaveLength(1);
  });

  it("keeps separate device namespaces for the same space", async () => {
    const remote = new FakeAgentWiki();
    const control = new MemoryControlStore();
    const a = new SyncRuntime(
      new MemoryVault({}),
      control,
      remote,
      { spaceId: "space", rootPath: "Wiki", status: "pending" },
      undefined,
      "device-a",
    );
    const b = new SyncRuntime(
      new MemoryVault({}),
      control,
      remote,
      { spaceId: "space", rootPath: "Wiki", status: "pending" },
      undefined,
      "device-b",
    );
    await a.establishEmptyBase();
    await b.establishEmptyBase();
    expect(
      await control.read(
        ".agentwiki/devices/d-device-a/spaces/s-space/current.json",
      ),
    ).not.toBeNull();
    expect(
      await control.read(
        ".agentwiki/devices/d-device-b/spaces/s-space/current.json",
      ),
    ).not.toBeNull();
  });

  it("does not replay an applied Pull control after-state over later identity work", async () => {
    const remote = new FakeAgentWiki();
    await remote.seed([
      {
        pageId: "p1",
        path: "A.md",
        title: "A",
        body: "a",
        contentHash: await contentHash("a"),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = new SyncRuntime(vault, control, remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    await runtime.applyPull(await runtime.previewPull());
    await vault.write("Wiki/New.md", new TextEncoder().encode("new"));
    const first = await runtime.previewPush();
    const firstId = first.changes.find(
      (item) => item.operation === "upsert" && item.path === "New.md",
    )?.pageId;
    await runtime.recover();
    const second = await runtime.previewPush();
    expect(
      second.changes.find(
        (item) => item.operation === "upsert" && item.path === "New.md",
      )?.pageId,
    ).toBe(firstId);
  });

  it("supersedes an unfinished Push after credential rotation instead of replaying it", async () => {
    const remote = new FakeAgentWiki();
    const vault = new MemoryVault({ "Wiki/A.md": "a" });
    const control = new MemoryControlStore();
    const mapping = {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending" as const,
    };
    const runtimeA = new SyncRuntime(
      vault,
      control,
      remote,
      mapping,
      undefined,
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
      mapping,
      undefined,
      "device",
      "space",
      "cred-b",
    );
    await runtimeB.recover();
    const push = new PushService(
      remote,
      control,
      ".agentwiki/devices/d-device/spaces/s-space/push",
    );
    expect((await push.inspect())?.remoteState).toBe("superseded");
  });

  it("does not block disconnect after a cancelled Push is superseded", async () => {
    const remote = new FakeAgentWiki();
    const runtime = new SyncRuntime(
      new MemoryVault({ "Wiki/A.md": "a" }),
      new MemoryControlStore(),
      remote,
      { spaceId: "space", rootPath: "Wiki", status: "pending" },
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

  it("clones an empty-bodied page without treating it as a missing sidecar", async () => {
    const remote = new FakeAgentWiki();
    await remote.seed([
      {
        pageId: "empty",
        path: "Empty.md",
        title: "Empty",
        body: "",
        contentHash: await contentHash(""),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
    const preview = await runtime.previewPull();
    await runtime.applyPull(preview);
    expect(vault.text("Wiki/Empty.md")).toBe("");
  });

  it("blocks a missing mapping root without deleting the mapping", async () => {
    const remote = new FakeAgentWiki();
    const vault = new MemoryVault({});
    vault.setRootStatus("missing");
    const mapping = {
      spaceId: "space",
      rootPath: "Wiki",
      status: "active" as const,
    };
    const settingsMappings = [mapping];
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping,
    );

    await expect(runtime.status()).rejects.toThrow("MAPPING_ROOT_MISSING");
    expect(settingsMappings).toEqual([mapping]);
    expect(await remote.getHead()).toMatchObject({ revision: "0" });
  });

  it("blocks a file used as the mapping root without deleting the mapping", async () => {
    const remote = new FakeAgentWiki();
    const vault = new MemoryVault({});
    vault.setRootStatus("file");
    const mapping = {
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending" as const,
    };
    const settingsMappings = [mapping];
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping,
    );

    await expect(runtime.previewPush()).rejects.toThrow(
      "MAPPING_ROOT_NOT_DIRECTORY",
    );
    expect(settingsMappings).toEqual([mapping]);
    expect(await remote.getHead()).toMatchObject({ revision: "0" });
  });
});
