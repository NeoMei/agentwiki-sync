import { describe, expect, it } from "vitest";
import { SyncRuntime } from "../../src/application/sync-runtime";
import { FakeAgentWiki } from "../fakes/fake-agentwiki";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { MemoryVault } from "../fakes/memory-vault";
import { contentHash } from "../../src/agentwiki/protocol";

describe("SyncRuntime", () => {
  it("clones a pending remote mapping, then reports clean", async () => {
    const remote = new FakeAgentWiki();
    const seed = "hello";
    await remote.seed([{ pageId: "p1", path: "Guide.md", title: "Guide", body: seed, contentHash: await contentHash(seed), updatedAt: "2026-08-14T00:00:00.000Z" }]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, { spaceId: "space", rootPath: "Wiki", status: "pending" });
    const preview = await runtime.previewPull();
    expect(preview.actions).toEqual([{ kind: "create", path: "Wiki/Guide.md", body: "hello" }]);
    await runtime.applyPull(preview);
    expect(vault.text("Wiki/Guide.md")).toBe("hello");
    expect((await runtime.status()).local.added).toHaveLength(0);
  });

  it("previews and pushes local edits only after explicit apply", async () => {
    const remote = new FakeAgentWiki();
    const vault = new MemoryVault({ "Wiki/New.md": "new" });
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, { spaceId: "space", rootPath: "Wiki", status: "pending" });
    await runtime.establishEmptyBase();
    const preview = await runtime.previewPush();
    expect(preview.changes).toHaveLength(1);
    expect(await remote.snapshot()).toHaveLength(0);
    await runtime.applyPush(preview);
    expect((await remote.snapshot())[0]?.body).toBe("new");
  });
});
