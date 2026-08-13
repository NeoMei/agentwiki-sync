import { describe, expect, it } from "vitest";
import { PushService } from "../../src/application/push-service";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { FakePushRemote } from "../fakes/fake-push-remote";
import type { PushChange, SyncCapabilities } from "../../src/agentwiki/protocol";

const capabilities: SyncCapabilities = { maxPageBytes: 1048576, maxBatchBytes: 1048576, maxBatchItems: 1, maxChangeCount: 5000, maxConfirmationBytes: 4194304, maxClientSpacePages: 5000, maxClientManifestBytes: 4194304, maxClientTotalBodyBytes: 104857600, maxResponseBytes: 4194304, maxPageItems: 200, pushSessionTtlSeconds: 900 };
const changes: PushChange[] = [
  { operation: "upsert", pageId: "p1", path: "A.md", title: "A", body: "hello", contentHash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" },
  { operation: "archive", pageId: "p2", previousPath: "B.md" }
];

describe("PushService", () => {
  it("persists confirmation payload, uploads deterministic batches and publishes", async () => {
    const remote = new FakePushRemote(capabilities, "r1");
    const store = new MemoryControlStore();
    const service = new PushService(remote, store, ".agentwiki/push/t1");
    const result = await service.publish({ spaceId: "s", baseRevision: "r1", changes, capabilities });
    expect(remote.batches).toHaveLength(2);
    expect(result.status).toBe("published");
    expect((await store.read(".agentwiki/push/t1/journal.json"))).toContain('"localCommitPhase":"not_started"');
    await service.markVerified();
    expect((await store.read(".agentwiki/push/t1/journal.json"))).toContain('"localCommitPhase":"verified"');
  });

  it("recovers a lost finalize response by querying without publishing twice", async () => {
    const remote = new FakePushRemote(capabilities, "r1");
    remote.loseFinalizeResponseOnce = true;
    const store = new MemoryControlStore();
    const service = new PushService(remote, store, ".agentwiki/push/t2");
    await expect(service.publish({ spaceId: "s", baseRevision: "r1", changes, capabilities })).rejects.toThrow(/response lost/);
    const result = await service.resume();
    expect(result?.status).toBe("published");
    expect(remote.finalizeCalls).toBe(1);
  });

  it("refuses to publish when remote head is ahead", async () => {
    const remote = new FakePushRemote(capabilities, "r2");
    await expect(new PushService(remote, new MemoryControlStore(), ".agentwiki/push/t3").publish({ spaceId: "s", baseRevision: "r1", changes, capabilities })).rejects.toThrow(/BASE_STALE/);
  });

  it("keeps confirmed bodies in payload files instead of the JSON journal", async () => {
    const remote = new FakePushRemote(capabilities, "r1"); const store = new MemoryControlStore();
    await new PushService(remote, store, ".agentwiki/push/t4").publish({ spaceId: "s", baseRevision: "r1", changes, capabilities });
    const journal = await store.read(".agentwiki/push/t4/journal.json");
    expect(journal).not.toContain("hello");
    expect(await store.read(".agentwiki/push/t4/payload/p1.md")).toBe("hello");
  });
});
