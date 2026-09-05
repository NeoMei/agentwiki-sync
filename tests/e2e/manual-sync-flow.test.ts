import { describe, expect, it } from "vitest";
import { FakeAgentWiki } from "../fakes/fake-agentwiki";
import { FakeTreeRemote, FakeTreeRemoteV3 } from "../fakes/fake-tree-remote";
import { PushService } from "../../src/application/push-service";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { mergeBody } from "../../src/core/merge";
import { contentHash, sha256Hex } from "../../src/agentwiki/protocol";
import { SyncRuntime } from "../../src/application/sync-runtime";
import { MemoryVault } from "../fakes/memory-vault";
import type { SyncPage } from "../../src/agentwiki/protocol";

async function sp(
  pageId: string,
  path: string,
  body: string,
): Promise<SyncPage> {
  return {
    pageId,
    path,
    title: path.split("/").at(-1)!.replace(/\.md$/, ""),
    body,
    contentHash: await contentHash(body),
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

const mapping = {
  spaceId: "space",
  rootPath: "Wiki",
  status: "pending" as const,
};

describe("manual multi-device sync", () => {
  it("pushes a referenced image from desktop and pulls exact bytes on a second v3 device", async () => {
    const image = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      ),
      (value) => value.charCodeAt(0),
    );
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ revision: "empty" });
    const desktopVault = new MemoryVault({});
    const desktop = SyncRuntime.v3(
      desktopVault,
      new MemoryControlStore(),
      remote,
      { ...mapping },
      "desktop-v3",
    );
    await desktop.applyPullV3(await desktop.previewPullV3());
    desktopVault.seedFile("Wiki/assets/image.png", image);
    desktopVault.seedMarkdown("Wiki/pages/Guide.md", "![[assets/image.png]]");
    await desktop.applyPushV3(await desktop.previewPushV3());

    const mobileVault = new MemoryVault({});
    const mobile = SyncRuntime.v3(
      mobileVault,
      new MemoryControlStore(),
      remote,
      { ...mapping },
      "mobile-v3",
    );
    await mobile.applyPullV3(await mobile.previewPullV3());

    expect(await mobileVault.read("Wiki/assets/image.png")).toEqual(image);
    expect(
      await sha256Hex((await mobileVault.read("Wiki/assets/image.png"))!),
    ).toBe(await sha256Hex(image));
    expect(mobileVault.text("Wiki/pages/Guide.md")).toBe(
      "![[assets/image.png]]",
    );
  });

  it("rebases a conflicting remote update with local-wins resolutions, then pushes local content", async () => {
    const remote = new FakeTreeRemote();
    const body = "one\ntwo";
    await remote.seed([await sp("p1", "pages/Guide.md", body)]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping,
    );
    await runtime.applyPull(await runtime.previewPull());

    await remote.replace([await sp("p1", "pages/Guide.md", "ONE\ntwo")]);
    await vault.write(
      "Wiki/pages/Guide.md",
      new TextEncoder().encode("one\nTWO"),
    );

    const rebase = await runtime.previewPull();
    expect(rebase.pageConflicts.length).toBeGreaterThan(0);
    for (const conflict of rebase.pageConflicts)
      rebase.pageConflictResolutions[conflict.conflictId] = { choice: "local" };
    await runtime.applyPull(rebase);
    expect(vault.text("Wiki/pages/Guide.md")).toBe("one\nTWO");

    const push = await runtime.previewPush();
    expect(push.changes).toHaveLength(1);
    await runtime.applyPush(push);
    expect((await remote.snapshot()).items[0]?.body).toBe("one\nTWO");
  });

  it("overwrites conflicting local edits with server-wins resolutions", async () => {
    const remote = new FakeTreeRemote();
    const body = "one\ntwo";
    await remote.seed([await sp("p1", "pages/Guide.md", body)]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping,
    );
    await runtime.applyPull(await runtime.previewPull());

    await remote.replace([await sp("p1", "pages/Guide.md", "ONE\ntwo")]);
    await vault.write(
      "Wiki/pages/Guide.md",
      new TextEncoder().encode("one\nTWO"),
    );

    const pull = await runtime.previewPull();
    expect(pull.pageConflicts.length).toBeGreaterThan(0);
    for (const conflict of pull.pageConflicts)
      pull.pageConflictResolutions[conflict.conflictId] = { choice: "remote" };
    await runtime.applyPull(pull);
    expect(vault.text("Wiki/pages/Guide.md")).toBe("ONE\ntwo");
    const status = await runtime.status();
    expect(status.local.added).toHaveLength(0);
    expect(status.local.modified).toHaveLength(0);
  });

  it("publishes from desktop, pulls on mobile, then preserves independent edits", async () => {
    const remote = new FakeAgentWiki();
    const body = "top\nmiddle\nbottom";
    await remote.seed([await sp("p1", "pages/Guide.md", body)]);
    const desktop = new PushService(
      remote,
      new MemoryControlStore(),
      ".agentwiki/desktop/push",
    );
    const first = await desktop.publish({
      spaceId: "space",
      baseRevision: "1",
      capabilities: remote.capabilities,
      changes: [
        {
          operation: "upsert",
          pageId: "p1",
          path: "pages/Guide.md",
          title: "Guide",
          body,
          contentHash: await contentHash(body),
        },
      ],
    });
    expect(first.revision).toBe("2");
    const mobileSnapshot = await remote.snapshot();
    expect(mobileSnapshot.items[0]?.body).toContain("middle");
    const merged = await mergeBody(
      mobileSnapshot.items[0]!.body,
      "TOP\nmiddle\nbottom",
      "top\nmiddle\nBOTTOM",
      "p1",
    );
    expect(merged.conflicts).toHaveLength(0);
    expect(merged.body).toContain("TOP");
    expect(merged.body).toContain("BOTTOM");
  });

  it("rechecks role at finalize and keeps the base unchanged on downgrade", async () => {
    const remote = new FakeAgentWiki();
    remote.canPublish = false;
    await expect(
      new PushService(
        remote,
        new MemoryControlStore(),
        ".agentwiki/push",
      ).publish({
        spaceId: "space",
        baseRevision: "0",
        capabilities: remote.capabilities,
        changes: [],
      }),
    ).rejects.toThrow(/SPACE_READ_ONLY/);
    expect((await remote.getHead()).revision).toBe("0");
  });

  it("runs desktop Push to mobile Pull to mobile Push to desktop Pull with isolated device state", async () => {
    const remote = new FakeTreeRemote();
    const desktopVault = new MemoryVault({ "Wiki/pages/Guide.md": "desktop" });
    const mobileVault = new MemoryVault({});
    const desktop = new SyncRuntime(
      desktopVault,
      new MemoryControlStore(),
      remote,
      mapping,
      "desktop",
    );
    const mobile = new SyncRuntime(
      mobileVault,
      new MemoryControlStore(),
      remote,
      mapping,
      "mobile",
    );
    await desktop.applyPush(await desktop.previewPush());
    await mobile.applyPull(await mobile.previewPull());
    expect(mobileVault.text("Wiki/pages/Guide.md")).toBe("desktop");
    await mobileVault.write(
      "Wiki/pages/Guide.md",
      new TextEncoder().encode("mobile edit"),
    );
    await mobile.applyPush(await mobile.previewPush());
    await desktop.applyPull(await desktop.previewPull());
    expect(desktopVault.text("Wiki/pages/Guide.md")).toBe("mobile edit");
  });

  it("materializes duplicate readable titles at distinct paths without stripping either H1", async () => {
    const remote = new FakeTreeRemote();
    const firstBody = "# 标题\n\n第一篇";
    const secondBody = "# 标题\n\n第二篇";
    await remote.seed([
      await sp("p1", "pages/标题.md", firstBody),
      await sp("p2", "pages/标题 (2).md", secondBody),
    ]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping,
    );

    await runtime.applyPull(await runtime.previewPull());

    expect(vault.text("Wiki/pages/标题.md")).toBe(firstBody);
    expect(vault.text("Wiki/pages/标题 (2).md")).toBe(secondBody);
    expect(vault.text("Wiki/pages/标题.md")).toContain("# 标题");
    expect(vault.text("Wiki/pages/标题 (2).md")).toContain("# 标题");

    const clean = await runtime.status();
    expect(clean.local.added).toHaveLength(0);
    expect(clean.local.modified).toHaveLength(0);
    expect(clean.local.renamed).toHaveLength(0);
    expect((await runtime.previewPush()).changes).toHaveLength(0);

    await vault.rename("Wiki/pages/标题 (2).md", "Wiki/pages/真正改名.md");
    await runtime.recordRename(
      "Wiki/pages/标题 (2).md",
      "Wiki/pages/真正改名.md",
    );

    const renamed = await runtime.status();
    expect(renamed.local.renamed).toEqual([
      expect.objectContaining({
        pageId: "p2",
        path: "pages/真正改名.md",
        title: "真正改名",
      }),
    ]);
  });

  it("syncs a mixed folder/page tree across desktop and mobile", async () => {
    const remote = new FakeTreeRemote();
    const desktopVault = new MemoryVault({});
    const mobileVault = new MemoryVault({});
    const desktop = new SyncRuntime(
      desktopVault,
      new MemoryControlStore(),
      remote,
      mapping,
      "desktop",
    );
    const mobile = new SyncRuntime(
      mobileVault,
      new MemoryControlStore(),
      remote,
      mapping,
      "mobile",
    );

    await desktopVault.createDirectory("Wiki/pages/Empty");
    await desktopVault.createDirectory("Wiki/pages/Guides");
    await desktopVault.write(
      "Wiki/pages/Guides/A.md",
      new TextEncoder().encode("desktop"),
    );
    await desktop.applyPush(await desktop.previewPush());

    await mobile.applyPull(await mobile.previewPull());
    expect(mobileVault.text("Wiki/pages/Guides/A.md")).toBe("desktop");
    expect(mobileVault.hasDirectory("Wiki/pages/Empty")).toBe(true);

    await mobileVault.rename("Wiki/pages/Guides", "Wiki/pages/Manuals");
    await mobileVault.write(
      "Wiki/pages/Manuals/A.md",
      new TextEncoder().encode("mobile"),
    );
    await mobile.applyPush(await mobile.previewPush());

    await desktop.applyPull(await desktop.previewPull());
    expect(desktopVault.text("Wiki/pages/Manuals/A.md")).toBe("mobile");
    expect(desktopVault.hasDirectory("Wiki/pages/Empty")).toBe(true);
    expect([...desktopVault.folders].sort()).toEqual(
      [...mobileVault.folders].sort(),
    );

    const tree = remote.tree();
    expect(tree.folders.map((folder) => folder.path).sort()).toEqual([
      "pages/Empty",
      "pages/Manuals",
    ]);
    expect(tree.pages.map((page) => page.path)).toEqual(["pages/Manuals/A.md"]);
    expect(tree.pages[0]?.body).toBe("mobile");
  });
});
