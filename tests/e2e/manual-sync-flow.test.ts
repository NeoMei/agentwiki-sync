import { describe, expect, it } from "vitest";
import { FakeAgentWiki } from "../fakes/fake-agentwiki";
import { PushService } from "../../src/application/push-service";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { mergeBody } from "../../src/core/merge";
import { contentHash } from "../../src/agentwiki/protocol";
import { SyncRuntime } from "../../src/application/sync-runtime";
import { MemoryVault } from "../fakes/memory-vault";

describe("manual multi-device sync", () => {
  it("rebases a conflicting remote update with local-wins resolutions, then pushes local content", async () => {
    const remote = new FakeAgentWiki();
    const body = "one\ntwo";
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
    const initial = await runtime.previewPull();
    await runtime.applyPull(initial);

    const remoteBody = "ONE\ntwo";
    await remote.replace([
      {
        pageId: "p1",
        path: "Guide.md",
        title: "Guide",
        body: remoteBody,
        contentHash: await contentHash(remoteBody),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    await vault.write(
      "Wiki/Guide.md",
      new TextEncoder().encode("one\nTWO"),
    );

    const rebase = await runtime.previewPull();
    expect(rebase.conflicts.length).toBeGreaterThan(0);
    for (const conflict of rebase.conflicts)
      rebase.conflictResolutions[conflict.conflictId] = { choice: "local" };
    await runtime.applyPull(rebase);
    expect(vault.text("Wiki/Guide.md")).toBe("one\nTWO");

    const push = await runtime.previewPush();
    expect(push.changes).toHaveLength(1);
    await runtime.applyPush(push);
    expect((await remote.snapshot()).items[0]?.body).toBe("one\nTWO");
  });

  it("overwrites conflicting local edits with server-wins resolutions", async () => {
    const remote = new FakeAgentWiki();
    const body = "one\ntwo";
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
    const initial = await runtime.previewPull();
    await runtime.applyPull(initial);

    const remoteBody = "ONE\ntwo";
    await remote.replace([
      {
        pageId: "p1",
        path: "Guide.md",
        title: "Guide",
        body: remoteBody,
        contentHash: await contentHash(remoteBody),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    await vault.write(
      "Wiki/Guide.md",
      new TextEncoder().encode("one\nTWO"),
    );

    const pull = await runtime.previewPull();
    expect(pull.conflicts.length).toBeGreaterThan(0);
    for (const conflict of pull.conflicts)
      pull.conflictResolutions[conflict.conflictId] = { choice: "remote" };
    await runtime.applyPull(pull);
    expect(vault.text("Wiki/Guide.md")).toBe("ONE\ntwo");
    const status = await runtime.status();
    expect(status.local.added).toHaveLength(0);
    expect(status.local.modified).toHaveLength(0);
  });

  it("publishes from desktop, pulls on mobile, then preserves independent edits", async () => {
    const remote = new FakeAgentWiki();
    const desktop = new PushService(
      remote,
      new MemoryControlStore(),
      ".agentwiki/desktop/push",
    );
    const body = "top\nmiddle\nbottom";
    const first = await desktop.publish({
      spaceId: "space",
      baseRevision: "0",
      capabilities: remote.capabilities,
      changes: [
        {
          operation: "upsert",
          pageId: "p1",
          path: "Guide.md",
          title: "Guide",
          body,
          contentHash: await contentHash(body),
        },
      ],
    });
    expect(first.revision).toBe("1");
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
    const remote = new FakeAgentWiki();
    const desktopVault = new MemoryVault({ "Wiki/Guide.md": "desktop" });
    const mobileVault = new MemoryVault({});
    const desktop = new SyncRuntime(
      desktopVault,
      new MemoryControlStore(),
      remote,
      { spaceId: "space", rootPath: "Wiki", status: "pending" },
      undefined,
      "desktop",
    );
    const mobile = new SyncRuntime(
      mobileVault,
      new MemoryControlStore(),
      remote,
      { spaceId: "space", rootPath: "Wiki", status: "pending" },
      undefined,
      "mobile",
    );
    await desktop.applyPush(await desktop.previewPush());
    await mobile.applyPull(await mobile.previewPull());
    expect(mobileVault.text("Wiki/Guide.md")).toBe("desktop");
    await mobileVault.write(
      "Wiki/Guide.md",
      new TextEncoder().encode("mobile edit"),
    );
    await mobile.applyPush(await mobile.previewPush());
    await desktop.applyPull(await desktop.previewPull());
    expect(desktopVault.text("Wiki/Guide.md")).toBe("mobile edit");
  });
});
