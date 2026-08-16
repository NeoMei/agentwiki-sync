import { describe, expect, it } from "vitest";
import { SyncRuntime } from "../../src/application/sync-runtime";
import { FakeAgentWiki } from "../fakes/fake-agentwiki";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { MemoryVault } from "../fakes/memory-vault";
import { contentHash } from "../../src/agentwiki/protocol";
import { PushService } from "../../src/application/push-service";

describe("SyncRuntime", () => {
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
});
