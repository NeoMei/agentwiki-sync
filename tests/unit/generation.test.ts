import { describe, expect, it } from "vitest";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { GenerationRepository, type SpaceManifest } from "../../src/storage/generation";

describe("immutable generations", () => {
  it("writes and verifies manifest, base bodies and revision metrics", async () => {
    const store = new MemoryControlStore();
    const repo = new GenerationRepository(store, ".agentwiki/device/space");
    const manifest: SpaceManifest = {
      schemaVersion: 1, protocolVersion: "1", generationId: "g1", spaceId: "s", rootPath: "Wiki",
      baseRevision: "r1", baseRevisionContentHash: "", basePageCount: 1, baseRevisionManifestByteLength: 0,
      baseRevisionBodyBytes: 5, lastSuccessfulSyncAt: "2026-08-14T00:00:00.000Z",
      pages: { p1: { pageId: "p1", relativePath: "A.md", title: "A", contentHash: "" } }
    };
    await repo.write(manifest, { p1: "hello" });
    const verified = await repo.verify("g1");
    expect(verified.basePageCount).toBe(1);
    await store.write(".agentwiki/device/space/generations/g1/base/p1.md", "tampered");
    await expect(repo.verify("g1")).rejects.toThrow(/corrupt/);
  });
});
