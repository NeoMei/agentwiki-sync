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
    const repeated = await runtime.previewPush();
    expect(repeated.changes[0]?.pageId).toBe(preview.changes[0]?.pageId);
    expect(await remote.snapshot()).toHaveLength(0);
    await runtime.applyPush(preview);
    expect((await remote.snapshot())[0]?.body).toBe("new");
  });

  it("three-way merges non-overlapping local and remote edits and keeps local-only changes dirty", async () => {
    const remote = new FakeAgentWiki();
    const original = "top\nmiddle\nbottom";
    await remote.seed([{ pageId: "p1", path: "Guide.md", title: "Guide", body: original, contentHash: await contentHash(original), updatedAt: "2026-08-14T00:00:00.000Z" }]);
    const vault = new MemoryVault({}); const control = new MemoryControlStore();
    const runtime = new SyncRuntime(vault, control, remote, { spaceId: "space", rootPath: "Wiki", status: "pending" });
    await runtime.applyPull(await runtime.previewPull());
    await vault.write("Wiki/Guide.md", new TextEncoder().encode("TOP\nmiddle\nbottom"));
    const remoteEdit = "top\nmiddle\nBOTTOM";
    await remote.replace([{ pageId: "p1", path: "Guide.md", title: "Guide", body: remoteEdit, contentHash: await contentHash(remoteEdit), updatedAt: "2026-08-14T00:01:00.000Z" }]);
    const preview = await runtime.previewPull();
    expect(preview.conflicts).toHaveLength(0);
    expect(preview.actions[0]).toMatchObject({ kind: "write", body: "TOP\nmiddle\nBOTTOM" });
    await runtime.applyPull(preview);
    expect((await runtime.status()).local.modified).toHaveLength(1);
  });

  it("blocks Pull application until structured conflicts are resolved", async () => {
    const remote = new FakeAgentWiki(); const original = "same";
    await remote.seed([{ pageId: "p1", path: "A.md", title: "A", body: original, contentHash: await contentHash(original), updatedAt: "2026-08-14T00:00:00.000Z" }]);
    const vault = new MemoryVault({}); const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, { spaceId: "space", rootPath: "Wiki", status: "pending" });
    await runtime.applyPull(await runtime.previewPull());
    await vault.write("Wiki/A.md", new TextEncoder().encode("local"));
    await remote.replace([{ pageId: "p1", path: "A.md", title: "A", body: "remote", contentHash: await contentHash("remote"), updatedAt: "2026-08-14T00:01:00.000Z" }]);
    const preview = await runtime.previewPull(); expect(preview.conflicts).toHaveLength(1);
    await expect(runtime.applyPull(preview)).rejects.toThrow(/conflict/);
  });

  it("treats remote archive versus local edit as a conflict", async () => {
    const remote = new FakeAgentWiki(); const original = "base";
    await remote.seed([{ pageId: "p1", path: "A.md", title: "A", body: original, contentHash: await contentHash(original), updatedAt: "2026-08-14T00:00:00.000Z" }]);
    const vault = new MemoryVault({}); const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, { spaceId: "space", rootPath: "Wiki", status: "pending" });
    await runtime.applyPull(await runtime.previewPull()); await vault.write("Wiki/A.md", new TextEncoder().encode("local edit")); await remote.replace([]);
    const preview = await runtime.previewPull(); expect(preview.conflicts).toHaveLength(1); expect(preview.actions).toHaveLength(0);
  });

  it("returns clean without creating an empty push session", async () => {
    const remote = new FakeAgentWiki(); const runtime = new SyncRuntime(new MemoryVault({}), new MemoryControlStore(), remote, { spaceId: "space", rootPath: "Wiki", status: "pending" });
    await runtime.establishEmptyBase(); const preview = await runtime.previewPush(); expect(preview.changes).toHaveLength(0); await runtime.applyPush(preview); expect(remote.sessionCount()).toBe(0);
  });

  it("moves the existing page when the remote renames the same pageId", async () => {
    const remote=new FakeAgentWiki();const body="body";await remote.seed([{pageId:"p1",path:"Old.md",title:"Old",body,contentHash:await contentHash(body),updatedAt:"2026-08-14T00:00:00.000Z"}]);const vault=new MemoryVault({});const runtime=new SyncRuntime(vault,new MemoryControlStore(),remote,{spaceId:"space",rootPath:"Wiki",status:"pending"});await runtime.applyPull(await runtime.previewPull());await remote.replace([{pageId:"p1",path:"New.md",title:"New",body,contentHash:await contentHash(body),updatedAt:"2026-08-14T00:01:00.000Z"}]);const preview=await runtime.previewPull();expect(preview.actions).toContainEqual({kind:"rename",fromPath:"Wiki/Old.md",path:"Wiki/New.md",body});await runtime.applyPull(preview);expect(vault.exists("Wiki/Old.md")).toBe(false);expect(vault.text("Wiki/New.md")).toBe(body);
  });

  it("does not overwrite a same-path local document during initial binding", async () => {
    const remote=new FakeAgentWiki();await remote.seed([{pageId:"p1",path:"A.md",title:"A",body:"remote",contentHash:await contentHash("remote"),updatedAt:"2026-08-14T00:00:00.000Z"}]);const runtime=new SyncRuntime(new MemoryVault({"Wiki/A.md":"local"}),new MemoryControlStore(),remote,{spaceId:"space",rootPath:"Wiki",status:"pending"});const preview=await runtime.previewPull();expect(preview.conflicts).toHaveLength(1);expect(preview.actions).toHaveLength(0);
  });

  it("keeps separate device namespaces for the same space", async () => {
    const remote=new FakeAgentWiki();const control=new MemoryControlStore();const a=new SyncRuntime(new MemoryVault({}),control,remote,{spaceId:"space",rootPath:"Wiki",status:"pending"},undefined,"device-a");const b=new SyncRuntime(new MemoryVault({}),control,remote,{spaceId:"space",rootPath:"Wiki",status:"pending"},undefined,"device-b");await a.establishEmptyBase();await b.establishEmptyBase();expect(await control.read(".agentwiki/devices/d-device-a/spaces/s-space/current.json")).not.toBeNull();expect(await control.read(".agentwiki/devices/d-device-b/spaces/s-space/current.json")).not.toBeNull();
  });
});
