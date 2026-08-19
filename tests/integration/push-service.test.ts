import { describe, expect, it } from "vitest";
import { PushService } from "../../src/application/push-service";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { FakePushRemote } from "../fakes/fake-push-remote";
import type {
  PushChange,
  SyncCapabilities,
} from "../../src/agentwiki/protocol";

const capabilities: SyncCapabilities = {
  maxPageBytes: 1048576,
  maxBatchBytes: 1048576,
  maxBatchItems: 1,
  maxChangeCount: 5000,
  maxConfirmationBytes: 4194304,
  maxClientSpacePages: 5000,
  maxClientManifestBytes: 4194304,
  maxClientTotalBodyBytes: 104857600,
  maxResponseBytes: 4194304,
  maxPageItems: 200,
  pushSessionTtlSeconds: 900,
};
const changes: PushChange[] = [
  {
    operation: "upsert",
    pageId: "p1",
    path: "A.md",
    title: "A",
    body: "hello",
    contentHash:
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  },
  { operation: "archive", pageId: "p2", previousPath: "B.md" },
];

describe("PushService", () => {
  it("persists confirmation payload, uploads deterministic batches and publishes", async () => {
    const remote = new FakePushRemote(capabilities, "r1");
    const store = new MemoryControlStore();
    const service = new PushService(remote, store, ".agentwiki/push/t1");
    const result = await service.publish({
      spaceId: "s",
      baseRevision: "r1",
      changes,
      capabilities,
    });
    expect(remote.batches).toHaveLength(2);
    expect(result.status).toBe("published");
    expect((await service.inspect())?.localCommitPhase).toBe("not_started");
    await service.markVerified();
    expect((await service.inspect())?.localCommitPhase).toBe("verified");
  });

  it("recovers a lost finalize response by querying without publishing twice", async () => {
    const remote = new FakePushRemote(capabilities, "r1");
    remote.loseFinalizeResponseOnce = true;
    const store = new MemoryControlStore();
    const service = new PushService(remote, store, ".agentwiki/push/t2");
    await expect(
      service.publish({
        spaceId: "s",
        baseRevision: "r1",
        changes,
        capabilities,
      }),
    ).rejects.toThrow(/response lost/);
    const result = await service.resume();
    expect(result?.status).toBe("published");
    expect(remote.finalizeCalls).toBe(1);
  });

  it("resumes an interrupted upload from persisted payloads", async () => {
    const remote = new FakePushRemote(capabilities, "r1");
    remote.loseFirstUploadOnce = true;
    const store = new MemoryControlStore();
    const service = new PushService(remote, store, ".agentwiki/push/resume");
    await expect(
      service.publish({
        spaceId: "s",
        baseRevision: "r1",
        changes,
        capabilities,
      }),
    ).rejects.toThrow(/interrupted/);
    const result = await service.resume();
    expect(result?.status).toBe("published");
    expect(remote.batches).toHaveLength(2);
  });

  it("refuses to publish when remote head is ahead", async () => {
    const remote = new FakePushRemote(capabilities, "r2");
    await expect(
      new PushService(
        remote,
        new MemoryControlStore(),
        ".agentwiki/push/t3",
      ).publish({ spaceId: "s", baseRevision: "r1", changes, capabilities }),
    ).rejects.toThrow(/BASE_STALE/);
  });

  it("keeps confirmed bodies in payload files instead of the JSON journal", async () => {
    const remote = new FakePushRemote(capabilities, "r1");
    const store = new MemoryControlStore();
    await new PushService(remote, store, ".agentwiki/push/t4").publish({
      spaceId: "s",
      baseRevision: "r1",
      changes,
      capabilities,
    });
    const journal = await store.read(".agentwiki/push/t4/journal.json");
    expect(journal).not.toContain("hello");
    // 现在使用可读路径 A.md 而不是哈希路径
    expect(await store.read(`.agentwiki/push/t4/payload/A.md`)).toBe("hello");
  });

  it("publishes a prepared sidecar payload without placing its body in preview metadata", async () => {
    const remote = new FakePushRemote(capabilities, "r1");
    const store = new MemoryControlStore();
    await store.write("preview/p1.md", "hello");
    const service = new PushService(remote, store, ".agentwiki/push/prepared");
    await service.publishPrepared({
      spaceId: "s",
      baseRevision: "r1",
      capabilities,
      changes: [
        {
          operation: "upsert",
          pageId: "p1",
          path: "A.md",
          title: "A",
          contentHash:
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          payloadPath: "preview/p1.md",
          bodyBytes: 5,
        },
      ],
    });
    expect(remote.batches[0]?.changes[0]).toMatchObject({ body: "hello" });
    expect(
      await store.read(".agentwiki/push/prepared/journal.json"),
    ).not.toContain("hello");
  });

  it("rejects a create response whose capabilities differ from the confirmed preview", async () => {
    const remote = new FakePushRemote(
      { ...capabilities, maxBatchItems: 2 },
      "r1",
    );
    await expect(
      new PushService(
        remote,
        new MemoryControlStore(),
        ".agentwiki/push/capability-change",
      ).publish({ spaceId: "s", baseRevision: "r1", changes, capabilities }),
    ).rejects.toThrow(/CAPABILITIES_CHANGED/);
    expect(remote.batches).toHaveLength(0);
  });

  it("records the credential that created a push session for rotation checks", async () => {
    const remote = new FakePushRemote(capabilities, "r1");
    const store = new MemoryControlStore();
    const service = new PushService(
      remote,
      store,
      ".agentwiki/push/credential",
    );
    await service.publish({
      spaceId: "s",
      baseRevision: "r1",
      changes,
      capabilities,
      credentialId: "cred-1",
    });
    expect((await service.inspect())?.credentialIdAtCreation).toBe("cred-1");
  });

  it("clears staged payloads and receipts once the local commit is verified", async () => {
    const remote = new FakePushRemote(capabilities, "r1");
    const store = new MemoryControlStore();
    const service = new PushService(remote, store, ".agentwiki/push/cleanup");
    await service.publish({
      spaceId: "s",
      baseRevision: "r1",
      changes,
      capabilities,
    });
    // 现在使用可读路径 A.md 而不是哈希路径
    const payloadPath = `.agentwiki/push/cleanup/payload/A.md`;
    expect(await store.read(payloadPath)).toBe("hello");
    await service.markVerified();
    expect(await store.read(payloadPath)).toBeNull();
  });

  it("cancels between upload batches and aborts the remote session", async () => {
    const remote = new FakePushRemote(capabilities, "r1");
    const store = new MemoryControlStore();
    await store.write("preview/a.md", "a");
    await store.write("preview/b.md", "b");
    const service = new PushService(remote, store, ".agentwiki/push/cancel");
    let stateAtRemoteAbort: string | undefined;
    remote.onAbort = async () => {
      stateAtRemoteAbort = (await service.inspect())?.remoteState;
    };
    const controller = new AbortController();
    const publishPrepared = service.publishPrepared.bind(service);
    const make = (pageId: string, path: string, body: string) => ({
      operation: "upsert" as const,
      pageId,
      path,
      title: pageId,
      contentHash:
        body === "a"
          ? "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"
          : "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d",
      payloadPath: `preview/${body}.md`,
      bodyBytes: 1,
    });
    await expect(
      publishPrepared(
        {
          spaceId: "s",
          baseRevision: "r1",
          capabilities,
          changes: [make("p1", "A.md", "a"), make("p2", "B.md", "b")],
        },
        {
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.phase === "upload" && progress.completed === 1)
              controller.abort();
          },
        },
      ),
    ).rejects.toThrow(/取消/);
    expect(remote.batches).toHaveLength(1);
    expect(remote.abortCalls).toBe(1);
    expect(stateAtRemoteAbort).toBe("superseded");
    expect(remote.finalizeCalls).toBe(0);
    expect((await service.inspect())?.remoteState).toBe("superseded");
  });

  it("supersedes a failed in-flight upload when cancellation races the failure", async () => {
    const remote = new FakePushRemote(capabilities, "r1");
    const store = new MemoryControlStore();
    await store.write("preview/a.md", "a");
    const service = new PushService(
      remote,
      store,
      ".agentwiki/push/cancel-race",
    );
    const controller = new AbortController();
    remote.loseFirstUploadOnce = true;
    remote.onUpload = async () => {
      controller.abort();
    };

    await expect(
      service.publishPrepared(
        {
          spaceId: "s",
          baseRevision: "r1",
          capabilities,
          changes: [
            {
              operation: "upsert",
              pageId: "p1",
              path: "A.md",
              title: "A",
              contentHash:
                "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
              payloadPath: "preview/a.md",
              bodyBytes: 1,
            },
          ],
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/取消/);
    expect((await service.inspect())?.remoteState).toBe("superseded");
    expect(remote.abortCalls).toBe(1);
    expect(remote.finalizeCalls).toBe(0);

    await expect(service.resume()).rejects.toThrow(/无法恢复/);
    expect(remote.batches).toHaveLength(0);
    expect(remote.finalizeCalls).toBe(0);
  });
});
