import { describe, expect, it, vi } from "vitest";
import { AgentWikiHttpError } from "../../src/agentwiki/client";
import { contentHash } from "../../src/agentwiki/protocol";
import { SyncRuntime } from "../../src/application/sync-runtime";
import { TreePushService } from "../../src/application/tree-push-service";
import { MutableControlRepository } from "../../src/storage/envelope";
import { isTreePushJournal } from "../../src/application/tree-push-service";
import { readPushProtocolRequirement } from "../../src/storage/push-journal-router";
import { FakeTreeRemote } from "../fakes/fake-tree-remote";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { MemoryVault } from "../fakes/memory-vault";
import { TreeIdentityRepository } from "../../src/storage/tree-identities";
import { makePlugin } from "../fakes/plugin-harness";
import {
  syncSummary,
  type SyncDiff,
} from "../../src/obsidian/sync-center-modal";

const folder = (
  folderId: string,
  path: string,
  parentFolderId: string | null = null,
) => ({
  folderId,
  path,
  parentFolderId,
  name: path.split("/").at(-1)!,
  sortOrder: 0,
  updatedAt: "2026-09-14T00:00:00.000Z",
});
const page = async (
  pageId: string,
  path: string,
  folderId: string | null = null,
) => ({
  pageId,
  path,
  folderId,
  title: pageId,
  body: pageId,
  contentHash: await contentHash(pageId),
  updatedAt: "2026-09-14T00:00:00.000Z",
});
async function fixture() {
  const remote = new FakeTreeRemote();
  await remote.seedTree({
    folders: [folder("a", "pages/A"), folder("b", "pages/A/B", "a")],
    pages: [
      await page("nested", "pages/A/B/nested.md", "b"),
      await page("root", "pages/root.md"),
    ],
  });
  const vault = new MemoryVault({});
  const control = new MemoryControlStore();
  const runtime = new SyncRuntime(vault, control, remote, {
    spaceId: "space",
    rootPath: "Wiki",
    status: "pending",
  });
  await runtime.applyPull(await runtime.previewPull());
  return { remote, vault, control, runtime };
}
const invalid = () =>
  new AgentWikiHttpError(400, {
    error: { code: "PAYLOAD_INVALID", retryable: false },
  });
async function rejectedFixture() {
  const f = await fixture();
  await f.vault.trashDirectory("Wiki/pages/A");
  await f.vault.trashFile("Wiki/pages/root.md");
  const preview = await f.runtime.previewPush();
  const service = new TreePushService(
    f.remote,
    f.control,
    ".agentwiki/test/push",
  );
  const getSession = f.remote.getSession.bind(f.remote);
  // A completed upload is ready, as on the real server.
  f.remote.getSession = async (id) => {
    const s = await getSession(id);
    return {
      ...s,
      status: s.status === "uploading" ? "ready_to_finalize" : s.status,
    };
  };
  return { ...f, preview, service };
}

describe("recursive Wiki archives", () => {
  it("archives a deleted tree once and archives independent root pages", async () => {
    const { remote, vault, runtime } = await fixture();
    await vault.trashDirectory("Wiki/pages/A");
    await vault.trashFile("Wiki/pages/root.md");
    const preview = await runtime.previewPush();
    expect(preview.changes).toEqual([
      { operation: "archive_folder", folderId: "a", previousPath: "pages/A" },
      {
        operation: "archive_page",
        pageId: "root",
        previousPath: "pages/root.md",
      },
    ]);
    await runtime.applyPush(preview);
    expect(await remote.head()).toMatchObject({
      folderCount: "0",
      pageCount: "0",
    });
  });
  it("archives only the missing child when its parent survives", async () => {
    const { remote, vault, runtime } = await fixture();
    await vault.trashDirectory("Wiki/pages/A/B");
    const preview = await runtime.previewPush();
    expect(preview.changes).toEqual([
      { operation: "archive_folder", folderId: "b", previousPath: "pages/A/B" },
    ]);
    await runtime.applyPush(preview);
    expect(await remote.head()).toMatchObject({
      folderCount: "1",
      pageCount: "1",
    });
  });
  it.each(["page", "folder"])(
    "fails closed when a %s survives by moving outside an archived ancestor",
    async (kind) => {
      const { remote, vault, control, runtime } = await fixture();
      const from =
        kind === "page" ? "Wiki/pages/A/B/nested.md" : "Wiki/pages/A/B";
      const to = kind === "page" ? "Wiki/pages/nested.md" : "Wiki/pages/B";
      await vault.rename(from, to);
      await runtime.recordRename(from, to);
      if (kind === "folder") {
        // Existing durable IDs can represent a surviving/moved subtree. The
        // planner must protect it even though this fixture moves its parent.
        const identityPath = [...control.files.keys()].find((p) =>
          p.endsWith("/tree-identities.json"),
        )!;
        const repo = new TreeIdentityRepository(control, identityPath);
        const identities = (await repo.read())!.payload;
        identities.pendingFolders.b = {
          folderId: "b",
          path: "pages/B",
          pathKey: "pages/b",
        };
        identities.pendingPages.nested = {
          pageId: "nested",
          path: "pages/B/nested.md",
          contentHash: await contentHash("nested"),
        };
        await repo.write(identities);
      }
      await vault.trashDirectory("Wiki/pages/A");
      await expect(runtime.previewPush()).rejects.toThrow(
        /归档.*保留|保留.*归档/,
      );
      expect(await remote.head()).toMatchObject({
        folderCount: "2",
        pageCount: "2",
      });
    },
  );
  it("preserves moved folder contents when the existing scanner assigns new IDs", async () => {
    const { remote, vault, runtime } = await fixture();
    await vault.rename("Wiki/pages/A/B", "Wiki/pages/B");
    await runtime.recordRename("Wiki/pages/A/B", "Wiki/pages/B");
    await vault.trashDirectory("Wiki/pages/A");
    const preview = await runtime.previewPush();
    await runtime.applyPush(preview);
    const segments = [];
    for await (const segment of remote.snapshotPages()) segments.push(segment);
    expect(segments.flatMap((segment) => segment.pages)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "pages/B/nested.md", body: "nested" }),
        expect.objectContaining({ path: "pages/root.md", body: "root" }),
      ]),
    );
    expect(await remote.head()).toMatchObject({
      folderCount: "1",
      pageCount: "2",
    });
    expect(vault.text("Wiki/pages/B/nested.md")).toBe("nested");
    expect((await runtime.previewPush()).changes).toEqual([]);
  });
  it("fake server rejects descendant operations before mutating any content", async () => {
    const { remote } = await fixture();
    const before = await remote.head();
    const session = await remote.createPushSession({
      baseRevision: before.revision,
    } as never);
    await remote.uploadBatch(session.sessionId, {
      protocolVersion: "2",
      batchIndex: 0,
      batchHash: "x",
      changes: [
        { operation: "archive_folder", folderId: "a", previousPath: "pages/A" },
        {
          operation: "archive_page",
          pageId: "nested",
          previousPath: "pages/A/B/nested.md",
        },
      ],
    });
    await expect(remote.finalize(session.sessionId, "x")).rejects.toMatchObject(
      { body: { error: { code: "PAYLOAD_INVALID" } } },
    );
    expect(await remote.head()).toEqual(before);
  });
});

describe("unpublished PAYLOAD_INVALID recovery", () => {
  it("retires a rejected confirmation durably, preserving changes and the original hash", async () => {
    const { remote, control, preview, service } = await rejectedFixture();
    const finalize = vi.spyOn(remote, "finalize").mockRejectedValue(invalid());
    await expect(service.publishPrepared(preview)).rejects.toMatchObject({
      body: { error: { code: "PAYLOAD_INVALID" } },
    });
    expect(await service.inspect()).toMatchObject({
      remoteState: "superseded",
    });
    const repo = new MutableControlRepository(
      control,
      ".agentwiki/test/push/journal.json",
      isTreePushJournal,
    );
    const original = (await repo.read())!.payload;
    expect(original.changes).toEqual(preview.changes);
    await control.remove(".agentwiki/test/push/journal.json");
    expect(await service.inspect()).toMatchObject({
      remoteState: "superseded",
    });
    expect((await repo.read())!.payload.confirmationHash).toBe(
      original.confirmationHash,
    );
    await expect(
      readPushProtocolRequirement(control, ".agentwiki/test", {
        spaceId: "space",
      }),
    ).resolves.toMatchObject({ schemaVersion: 2 });
    expect(finalize).toHaveBeenCalledTimes(1);
  });
  it("recovers an old overlapping journal without rewriting its confirmation", async () => {
    const { remote, control, preview, service, runtime } =
      await rejectedFixture();
    preview.changes.push(
      { operation: "archive_folder", folderId: "b", previousPath: "pages/A/B" },
      {
        operation: "archive_page",
        pageId: "nested",
        previousPath: "pages/A/B/nested.md",
      },
    );
    const finalize = vi
      .spyOn(remote, "finalize")
      .mockRejectedValue(new Error("transport lost"));
    await expect(service.publishPrepared(preview)).rejects.toThrow(
      "transport lost",
    );
    const repo = new MutableControlRepository(
      control,
      ".agentwiki/test/push/journal.json",
      isTreePushJournal,
    );
    const old = (await repo.read())!.payload;
    finalize.mockRejectedValue(invalid());
    await expect(service.resume()).resolves.toBeNull();
    expect((await repo.read())!.payload).toMatchObject({
      changes: old.changes,
      confirmationHash: old.confirmationHash,
      remoteState: "superseded",
    });
    expect(finalize).toHaveBeenCalledTimes(2);
    finalize.mockRestore();
    await expect(
      service.publishPrepared(await runtime.previewPush()),
    ).resolves.toMatchObject({
      status: "published",
    });
    const history = await control.list(".agentwiki/test/push/operations");
    expect(history.folders.length).toBeGreaterThan(0);
    await expect(
      readPushProtocolRequirement(control, ".agentwiki/test", {
        spaceId: "space",
      }),
    ).resolves.toMatchObject({ schemaVersion: 2 });
  });
  it("retains rejected payload bytes when a fresh confirmation replaces the same page", async () => {
    const { remote, vault, control, runtime } = await fixture();
    const service = new TreePushService(
      remote,
      control,
      ".agentwiki/payload-history/push",
    );
    vault.seedMarkdown("Wiki/pages/root.md", "first confirmed body");
    const finalize = vi
      .spyOn(remote, "finalize")
      .mockRejectedValueOnce(invalid());
    await expect(
      service.publishPrepared(await runtime.previewPush()),
    ).rejects.toBeInstanceOf(AgentWikiHttpError);
    const repo = new MutableControlRepository(
      control,
      ".agentwiki/payload-history/push/journal.json",
      isTreePushJournal,
    );
    const original = (await repo.read())!.payload;
    const change = original.changes.find((c) => c.operation === "upsert_page")!;
    if (change.operation !== "upsert_page")
      throw new Error("fixture upsert missing");
    vault.seedMarkdown(
      "Wiki/pages/root.md",
      "second explicitly confirmed body",
    );
    await service.publishPrepared(await runtime.previewPush());
    await service.markVerified();
    expect(await control.read(change.page.payloadPath)).toBe(
      "first confirmed body",
    );
    const terminalPath = [...control.files.keys()].find(
      (p) => p.includes("/operations/") && p.endsWith("/terminal.json"),
    )!;
    expect(
      JSON.parse((await control.read(terminalPath))!).payload,
    ).toMatchObject({
      confirmationHash: original.confirmationHash,
      changes: original.changes,
      remoteState: "superseded",
    });
    expect(finalize).toHaveBeenCalledTimes(2);
  });
  it("does not re-finalize a known rejection when abort transport fails", async () => {
    const { remote, preview, service } = await rejectedFixture();
    const finalize = vi.spyOn(remote, "finalize").mockRejectedValue(invalid());
    const abort = vi
      .spyOn(remote, "abort")
      .mockRejectedValueOnce(new Error("offline"));
    await expect(service.publishPrepared(preview)).rejects.toBeInstanceOf(
      AgentWikiHttpError,
    );
    expect(await service.inspect()).toMatchObject({
      remoteState: "finalizing",
    });
    await expect(service.resume()).resolves.toBeNull();
    expect(await service.inspect()).toMatchObject({
      remoteState: "superseded",
    });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(2);
  });
  it("retains ambiguous failures and reconciles a result already published", async () => {
    const { remote, preview, service } = await rejectedFixture();
    const publish = remote.finalize.bind(remote);
    const finalize = vi
      .spyOn(remote, "finalize")
      .mockImplementationOnce(async (id, hash) => {
        await publish(id, hash);
        throw new Error("response lost");
      });
    const abort = vi.spyOn(remote, "abort");
    await expect(service.publishPrepared(preview)).rejects.toThrow(
      "response lost",
    );
    expect(await service.inspect()).toMatchObject({
      remoteState: "finalizing",
    });
    await expect(service.resume()).resolves.toMatchObject({
      status: "published",
    });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
  });
  it("reconciles a published result even if finalize reported PAYLOAD_INVALID", async () => {
    const { remote, preview, service } = await rejectedFixture();
    const publish = remote.finalize.bind(remote);
    vi.spyOn(remote, "finalize").mockImplementationOnce(async (id, hash) => {
      await publish(id, hash);
      throw invalid();
    });
    const abort = vi.spyOn(remote, "abort");
    await expect(service.publishPrepared(preview)).resolves.toMatchObject({
      status: "published",
    });
    expect(await service.inspect()).toMatchObject({ remoteState: "published" });
    expect(abort).not.toHaveBeenCalled();
  });
  it.each(["expired", "missing"])(
    "explicit cancel never rebuilds a %s session",
    async (kind) => {
      const { remote, preview, service } = await rejectedFixture();
      const finalize = vi
        .spyOn(remote, "finalize")
        .mockRejectedValue(new Error("offline"));
      await expect(service.publishPrepared(preview)).rejects.toThrow("offline");
      const create = vi.spyOn(remote, "createPushSession");
      remote.getSession = async () => {
        if (kind === "missing")
          throw new AgentWikiHttpError(404, {
            error: { code: "PUSH_SESSION_NOT_FOUND" },
          });
        return {
          sessionId: "session-1",
          status: "expired",
          expiresAt: "2020-01-01T00:00:00Z",
          receivedBatchIndexes: [],
          result: null,
        };
      };
      if (kind === "missing") {
        await expect(service.cancelPending()).rejects.toThrow(
          /归属或终态.*保留原确认/,
        );
        expect(await service.inspect()).toMatchObject({
          remoteState: "finalizing",
        });
      } else {
        await expect(service.cancelPending()).resolves.toBeNull();
        expect(await service.inspect()).toMatchObject({
          remoteState: "superseded",
        });
      }
      expect(create).not.toHaveBeenCalled();
      expect(finalize).toHaveBeenCalledTimes(1);
    },
  );
  it("explicit cancel reconciles a result published while abort was in flight", async () => {
    const { remote, preview, service } = await rejectedFixture();
    const publish = remote.finalize.bind(remote);
    const finalize = vi
      .spyOn(remote, "finalize")
      .mockRejectedValue(new Error("offline"));
    await expect(service.publishPrepared(preview)).rejects.toThrow("offline");
    vi.spyOn(remote, "abort").mockImplementationOnce(async (id) => {
      await publish(id, "x");
      throw new Error("abort raced publish");
    });
    await expect(service.cancelPending()).resolves.toMatchObject({
      status: "published",
    });
    expect(await service.inspect()).toMatchObject({ remoteState: "published" });
    expect(finalize).toHaveBeenCalledTimes(1);
  });
  it("explicit cancel retains a finalizing server session instead of discarding it", async () => {
    const { remote, preview, service } = await rejectedFixture();
    vi.spyOn(remote, "finalize").mockRejectedValue(new Error("offline"));
    await expect(service.publishPrepared(preview)).rejects.toThrow("offline");
    remote.getSession = async () => ({
      sessionId: "session-1",
      status: "finalizing",
      expiresAt: "2099-01-01T00:00:00Z",
      receivedBatchIndexes: [],
      result: null,
    });
    const abort = vi.spyOn(remote, "abort");
    await expect(service.cancelPending()).rejects.toThrow(/尚未确定/);
    expect(await service.inspect()).toMatchObject({
      remoteState: "finalizing",
    });
    expect(abort).not.toHaveBeenCalled();
  });
  it("uses abort as a fence before retiring an expired read while finalize publishes", async () => {
    const { remote, preview, service } = await rejectedFixture();
    const publish = remote.finalize.bind(remote);
    vi.spyOn(remote, "finalize").mockRejectedValue(new Error("offline"));
    await expect(service.publishPrepared(preview)).rejects.toThrow("offline");
    const getSession = remote.getSession.bind(remote);
    let first = true;
    remote.getSession = async (id) => {
      const status = await getSession(id);
      if (first) {
        first = false;
        return { ...status, status: "expired" };
      }
      return status;
    };
    const abort = vi
      .spyOn(remote, "abort")
      .mockImplementationOnce(async (id) => {
        await publish(id, "x");
        throw new AgentWikiHttpError(409, {
          error: { code: "PUSH_SESSION_STATE_INVALID" },
        });
      });
    await expect(service.cancelPending()).resolves.toMatchObject({
      status: "published",
    });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(await service.inspect()).toMatchObject({ remoteState: "published" });
  });
  it("does not retire an expired read if the abort fence has a network failure", async () => {
    const { remote, preview, service } = await rejectedFixture();
    vi.spyOn(remote, "finalize").mockRejectedValue(new Error("offline"));
    await expect(service.publishPrepared(preview)).rejects.toThrow("offline");
    remote.getSession = async () => ({
      sessionId: "session-1",
      status: "expired",
      expiresAt: "2020-01-01T00:00:00Z",
      receivedBatchIndexes: [],
      result: null,
    });
    vi.spyOn(remote, "abort").mockRejectedValue(new Error("fence offline"));
    await expect(service.cancelPending()).rejects.toThrow("fence offline");
    expect(await service.inspect()).toMatchObject({
      remoteState: "finalizing",
    });
  });
  it("does not treat an abort ownership NOT_FOUND as proof of expiration", async () => {
    const { remote, preview, service } = await rejectedFixture();
    vi.spyOn(remote, "finalize").mockRejectedValue(new Error("offline"));
    await expect(service.publishPrepared(preview)).rejects.toThrow("offline");
    remote.getSession = async () => ({
      sessionId: "session-1",
      status: "expired",
      expiresAt: "2020-01-01T00:00:00Z",
      receivedBatchIndexes: [],
      result: null,
    });
    vi.spyOn(remote, "abort").mockRejectedValue(
      new AgentWikiHttpError(404, {
        error: { code: "PUSH_SESSION_NOT_FOUND" },
      }),
    );
    await expect(service.cancelPending()).rejects.toThrow(
      /归属或终态.*保留原确认/,
    );
    expect(await service.inspect()).toMatchObject({
      remoteState: "finalizing",
    });
  });
  it("retires after a locked abort reports EXPIRED and terminal readback agrees", async () => {
    const { remote, preview, service } = await rejectedFixture();
    vi.spyOn(remote, "finalize").mockRejectedValue(new Error("offline"));
    await expect(service.publishPrepared(preview)).rejects.toThrow("offline");
    remote.getSession = async () => ({
      sessionId: "session-1",
      status: "expired",
      expiresAt: "2020-01-01T00:00:00Z",
      receivedBatchIndexes: [],
      result: null,
    });
    vi.spyOn(remote, "abort").mockRejectedValue(
      new AgentWikiHttpError(410, { error: { code: "PUSH_SESSION_EXPIRED" } }),
    );
    await expect(service.cancelPending()).resolves.toBeNull();
    expect(await service.inspect()).toMatchObject({
      remoteState: "superseded",
    });
  });
  it("does not recreate an expired destructive confirmation during recovery", async () => {
    const { remote, preview, service } = await rejectedFixture();
    const finalize = vi
      .spyOn(remote, "finalize")
      .mockRejectedValue(new Error("offline"));
    await expect(service.publishPrepared(preview)).rejects.toThrow("offline");
    const create = vi.spyOn(remote, "createPushSession");
    remote.getSession = async () => ({
      sessionId: "session-1",
      status: "expired",
      expiresAt: "2020-01-01T00:00:00Z",
      receivedBatchIndexes: [],
      result: null,
    });
    await expect(service.resume()).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledTimes(1);
  });
  it("explicit cancel preserves an ambiguous session until abort is confirmed", async () => {
    const { remote, preview, service } = await rejectedFixture();
    vi.spyOn(remote, "finalize").mockRejectedValue(new Error("offline"));
    await expect(service.publishPrepared(preview)).rejects.toThrow("offline");
    vi.spyOn(remote, "abort").mockRejectedValue(new Error("abort offline"));
    await expect(service.cancelPending()).rejects.toThrow("abort offline");
    expect(await service.inspect()).toMatchObject({
      remoteState: "finalizing",
    });
  });
  it("runtime cancellation reconciles an already published result before completing", async () => {
    const { remote, vault, runtime } = await fixture();
    await vault.trashDirectory("Wiki/pages/A");
    const publish = remote.finalize.bind(remote);
    const finalize = vi
      .spyOn(remote, "finalize")
      .mockImplementationOnce(async (id, hash) => {
        await publish(id, hash);
        throw new Error("response lost");
      });
    await expect(
      runtime.applyPush(await runtime.previewPush()),
    ).rejects.toThrow("response lost");
    await runtime.cancelPendingTreePush();
    expect(await runtime.hasUnfinishedPush()).toBe(false);
    expect((await runtime.previewPush()).changes).toEqual([]);
    expect((await runtime.remoteDelta()).ahead).toBe(false);
    expect(finalize).toHaveBeenCalledTimes(1);
  });
  it("shows persisted pending archive operations instead of an empty local diff", async () => {
    const { remote, vault, runtime } = await fixture();
    await vault.trashDirectory("Wiki/pages/A");
    await vault.trashFile("Wiki/pages/root.md");
    vi.spyOn(remote, "finalize").mockRejectedValue(
      new Error("network unavailable"),
    );
    const before = await remote.head();
    const preview = await runtime.previewPush();
    // Simulate an already-confirmed journal from the old planner. Display its
    // actual redundant operations, never deduplicate or rewrite that journal.
    preview.changes.push(
      { operation: "archive_folder", folderId: "b", previousPath: "pages/A/B" },
      {
        operation: "archive_page",
        pageId: "nested",
        previousPath: "pages/A/B/nested.md",
      },
    );
    await expect(runtime.applyPush(preview)).rejects.toThrow(
      "network unavailable",
    );
    const harness = await makePlugin({
      data: {
        schemaVersion: 2,
        serverUrl: "https://wiki.example.com",
        mappings: [{ spaceId: "space", rootPath: "Wiki", status: "active" }],
      },
    });
    await harness.plugin.onload();
    const subject = harness.plugin as unknown as {
      runtime: () => Promise<SyncRuntime>;
      collectSyncDiff: (id: string, options: object) => Promise<SyncDiff>;
      cancelPendingPush: (id: string) => Promise<void>;
    };
    subject.runtime = async () => runtime;
    const diff = await subject.collectSyncDiff("space", {});
    expect(diff).toMatchObject({
      recoveryPending: true,
      localFoldersDeleted: ["pages/A", "pages/A/B"],
      localDeleted: ["pages/root.md", "pages/A/B/nested.md"],
      recoveryCanCancel: true,
    });
    expect(syncSummary(diff)).toMatch(/待恢复.*归档目录 2.*归档页面 2/);
    await subject.cancelPendingPush("space");
    expect(await runtime.hasUnfinishedPush()).toBe(false);
    expect(await remote.head()).toEqual(before);
    await runtime.applyPull(
      await runtime.previewPull(undefined, { restoreServer: true }),
    );
    expect((await runtime.previewPush()).changes).toEqual([]);
    expect((await runtime.remoteDelta()).ahead).toBe(false);
    expect(await remote.head()).toEqual(before);
  });
});
