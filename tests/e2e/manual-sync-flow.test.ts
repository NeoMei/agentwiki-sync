import { describe, expect, it } from "vitest";
import { FakeAgentWiki } from "../fakes/fake-agentwiki";
import { PushService } from "../../src/application/push-service";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { mergeBody } from "../../src/core/merge";
import { contentHash } from "../../src/agentwiki/protocol";

describe("manual multi-device sync", () => {
  it("publishes from desktop, pulls on mobile, then preserves independent edits", async () => {
    const remote = new FakeAgentWiki();
    const desktop = new PushService(remote, new MemoryControlStore(), ".agentwiki/desktop/push");
    const body = "top\nmiddle\nbottom";
    const first = await desktop.publish({ spaceId: "space", baseRevision: "0", capabilities: remote.capabilities, changes: [{ operation: "upsert", pageId: "p1", path: "Guide.md", title: "Guide", body, contentHash: await contentHash(body) }] });
    expect(first.revision).toBe("1");
    const mobileSnapshot = await remote.snapshot();
    expect(mobileSnapshot[0]?.body).toContain("middle");
    const merged = await mergeBody(mobileSnapshot[0]!.body, "TOP\nmiddle\nbottom", "top\nmiddle\nBOTTOM", "p1");
    expect(merged.conflicts).toHaveLength(0);
    expect(merged.body).toContain("TOP");
    expect(merged.body).toContain("BOTTOM");
  });

  it("rechecks role at finalize and keeps the base unchanged on downgrade", async () => {
    const remote = new FakeAgentWiki();
    remote.canPublish = false;
    await expect(new PushService(remote, new MemoryControlStore(), ".agentwiki/push").publish({ spaceId: "space", baseRevision: "0", capabilities: remote.capabilities, changes: [] })).rejects.toThrow(/SPACE_READ_ONLY/);
    expect((await remote.getHead()).revision).toBe("0");
  });
});
