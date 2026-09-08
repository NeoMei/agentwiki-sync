import { describe, expect, it } from "vitest";
import { SyncRuntime } from "../../src/application/sync-runtime";
import { resolvePageConflictV3 } from "../../src/application/tree-diff";
import {
  canonicalBytes,
  confirmationHash,
  contentHash,
  sha256Hex,
} from "../../src/agentwiki/protocol";
import { FakeTreeRemote, FakeTreeRemoteV3 } from "../fakes/fake-tree-remote";
import type { TreeDeltaV3 } from "../../src/ports/tree-remote";
import { FakeAgentWiki } from "../fakes/fake-agentwiki";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { MemoryVault } from "../fakes/memory-vault";
import { BaselineRepository } from "../../src/storage/baseline";
import { TreeBaselineRepository } from "../../src/storage/tree-baseline";
import { TreeIdentityRepository } from "../../src/storage/tree-identities";
import { PushService } from "../../src/application/push-service";
import type {
  TreeAttachment,
  TreeFolder,
  TreePage,
  TreePageV3,
} from "../../src/core/tree-model";

const PNG_2X3 = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0,
  0, 0, 3, 8, 6, 0, 0, 0, 0, 0, 0, 0,
]);

async function v3Attachment(
  attachmentId: string,
  path: string,
): Promise<TreeAttachment> {
  return {
    attachmentId,
    path,
    mimeType: "image/png",
    sizeBytes: String(PNG_2X3.byteLength),
    width: 2,
    height: 3,
    contentHash: await sha256Hex(PNG_2X3),
    updatedAt: "2026-09-05T00:00:00.000Z",
  };
}

async function v3Page(
  pageId: string,
  path: string,
  body: string,
  attachmentIds: string[],
): Promise<TreePageV3> {
  return {
    ...(await page(pageId, path, body)),
    referencedAttachmentIds: attachmentIds,
  };
}

function folder(
  folderId: string,
  parentFolderId: string | null,
  path: string,
  overrides: Partial<TreeFolder> = {},
): TreeFolder {
  return {
    folderId,
    parentFolderId,
    name: path.split("/").at(-1) ?? "Folder",
    path,
    sortOrder: 0,
    updatedAt: "2026-08-29T00:00:00Z",
    ...overrides,
  };
}

async function page(
  pageId: string,
  path: string,
  body: string,
  overrides: Partial<TreePage> = {},
): Promise<TreePage> {
  const name = path.split("/").at(-1) ?? "Page";
  return {
    pageId,
    folderId: null,
    path,
    title: name.slice(0, name.lastIndexOf(".")),
    body,
    contentHash: await contentHash(body),
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

const mapping = (status: "pending" | "active" = "pending") => ({
  spaceId: "space",
  rootPath: "Wiki",
  status,
});

describe("SyncRuntime", () => {
  it("returns structured local image blockers in a non-publishable Push preview", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ revision: "rev-empty" });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedMarkdown("Wiki/pages/note.md", "![[assets/missing.png]]");

    const preview = await runtime.previewPushV3();

    expect(preview).toMatchObject({
      protocolVersion: "3",
      publishable: false,
      changes: [],
      blockers: [
        expect.objectContaining({
          code: "ATTACHMENT_MISSING",
          pagePath: "pages/note.md",
          path: "assets/missing.png",
        }),
      ],
    });
    await expect(runtime.applyPushV3(preview)).rejects.toThrow(
      /V3_PUSH_BLOCKED/u,
    );
    expect(remote.createInputs).toEqual([]);
  });

  it("honors cancellation while reading the v3 bootstrap preview", async () => {
    const remote = new FakeTreeRemoteV3();
    const runtime = SyncRuntime.v3(
      new MemoryVault({}),
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    const operation = new AbortController();
    operation.abort();

    await expect(
      runtime.previewBootstrapPullV3({ signal: operation.signal }),
    ).rejects.toThrow("同步已取消");
  });

  it("finishes a committed bootstrap into a fresh Pull preview after late cancellation", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ revision: "bootstrap-revision" });
    const runtime = SyncRuntime.v3(
      new MemoryVault({}),
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    const bootstrap = await runtime.previewBootstrapPullV3();
    const operation = new AbortController();
    const progress: Array<{
      cancellable: boolean;
      nonCancellableReason?: string;
    }> = [];
    const originalConfirm = remote.bootstrapConfirmed.bind(remote);
    remote.bootstrapConfirmed = async (input) => {
      const result = await originalConfirm(input);
      operation.abort();
      return result;
    };

    const preview = await runtime.confirmBootstrapPullV3(bootstrap, {
      signal: operation.signal,
      onProgress: (value) => progress.push(value),
    });

    expect(preview.revision).toBe("bootstrap-revision");
    expect(
      progress.some(
        (value) =>
          !value.cancellable && value.nonCancellableReason?.includes("已提交"),
      ),
    ).toBe(true);
  });

  it("reports referenced-image status through the strict v3 branch without publishing", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ revision: "rev-empty" });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedFile("Wiki/assets/image.png", PNG_2X3);
    vault.seedMarkdown("Wiki/pages/note.md", "![[assets/image.png]]");

    const status = await runtime.statusV3();
    const delta = await runtime.remoteDeltaV3();

    expect(status.protocolVersion).toBe("3");
    expect(status.local.attachmentsAdded).toHaveLength(1);
    expect(status.local.attachmentsAdded[0]?.path).toBe("assets/image.png");
    expect(
      status.local.attachmentPageCounts[
        status.local.attachmentsAdded[0]!.attachmentId
      ],
    ).toBe(1);
    expect(delta).toMatchObject({
      protocolVersion: "3",
      ahead: false,
      items: [],
    });
    expect(remote.createInputs).toEqual([]);
  });

  it("projects unchanged Page references onto the exact remote delta revision", async () => {
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const pageId = "22222222-2222-4222-8222-222222222222";
    const before = await v3Attachment(attachmentId, "assets/image.png");
    const unchangedPage = await v3Page(
      pageId,
      "pages/note.md",
      "![[assets/image.png]]",
      [attachmentId],
    );
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      revision: "rev-before",
      pages: [unchangedPage],
      attachments: [before],
      blobs: { [attachmentId]: PNG_2X3 },
    });
    const runtime = SyncRuntime.v3(
      new MemoryVault({}),
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPullV3(await runtime.previewPullV3());
    remote.downloads.length = 0;
    const replacement = { ...before, contentHash: "b".repeat(64) };
    await remote.seedTree({
      revision: "rev-after",
      pages: [unchangedPage],
      attachments: [replacement],
    });
    (remote as unknown as { delta: () => Promise<TreeDeltaV3> }).delta =
      async (): Promise<TreeDeltaV3> => ({
        toRevision: "rev-after",
        items: [
          {
            operation: "upsert_attachment" as const,
            attachment: replacement,
          },
        ],
      });
    remote.failAfterSnapshot = true;

    const delta = await runtime.remoteDeltaV3();

    expect(delta.remoteRevision).toBe("rev-after");
    expect(delta.resultingPages).toEqual([
      {
        pageId,
        path: "pages/note.md",
        referencedAttachmentIds: [attachmentId],
      },
    ]);
    expect(remote.downloads).toEqual([]);
  });

  it("fully verifies a v3 snapshot before downloading any Blob or persisting preview effects", async () => {
    const attachment = await v3Attachment(
      "11111111-1111-4111-8111-111111111111",
      "assets/image.png",
    );
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "![[assets/image.png]]",
          [attachment.attachmentId],
        ),
      ],
      attachments: [attachment],
      blobs: { [attachment.attachmentId]: PNG_2X3 },
    });
    remote.failAfterSnapshot = true;
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    const progress: string[] = [];

    await expect(
      runtime.previewPullV3({
        onProgress: (event) => progress.push(event.phase),
      }),
    ).rejects.toThrow(/SNAPSHOT_FINAL_HASH_MISMATCH/);
    expect(remote.downloads).toEqual([]);
    expect(vault.operations).toBe(0);
    expect(control.files.size).toBe(0);
    expect(control.binaryFiles.size).toBe(0);
    expect(progress).toEqual([]);
  });

  it("downloads and applies a v3 referenced image, then the same revision is a zero-operation pull", async () => {
    const attachment = await v3Attachment(
      "11111111-1111-4111-8111-111111111111",
      "assets/image.png",
    );
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "![[assets/image.png]]",
          [attachment.attachmentId],
        ),
      ],
      attachments: [attachment],
      blobs: { [attachment.attachmentId]: PNG_2X3 },
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());

    const first = await runtime.previewPullV3();
    await runtime.applyPullV3(first);
    expect(vault.exists("Wiki/assets/image.png")).toBe(true);
    expect(vault.text("Wiki/pages/note.md")).toBe("![[assets/image.png]]");
    expect(
      (
        await new TreeBaselineRepository(
          control,
          ".agentwiki/devices/d-local/spaces/s-space",
          "space",
          "Wiki",
        ).readSnapshot()
      ).protocolVersion,
    ).toBe("3");

    vault.operationLog.length = 0;
    const downloads = remote.downloads.length;
    const second = await runtime.previewPullV3();
    expect(second.actions).toEqual([]);
    await runtime.applyPullV3(second);
    expect(remote.downloads).toHaveLength(downloads);
    expect(vault.operationLog).toEqual([]);
    expect((await runtime.previewPushV3()).changes).toEqual([]);
  });

  it("restores a same-revision missing referenced image without absorbing unrelated local work", async () => {
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const attachment = await v3Attachment(attachmentId, "assets/image.png");
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      revision: "same-revision",
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "![[assets/image.png]]",
          [attachmentId],
        ),
      ],
      attachments: [attachment],
      blobs: { [attachmentId]: PNG_2X3 },
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    const identitiesBefore = await new TreeIdentityRepository(
      control,
      ".agentwiki/devices/d-local/spaces/s-space",
    ).read();
    await vault.trashFile("Wiki/assets/image.png");
    vault.seedMarkdown("Wiki/pages/local-only.md", "unrelated local edit");
    vault.seedFile("Wiki/assets/unreferenced.png", PNG_2X3);
    vault.operationLog.length = 0;
    const downloadsBefore = remote.downloads.length;

    const preview = await runtime.previewPullV3(undefined, {
      repairSameRevisionMissingRemoteAttachments: true,
    });

    expect(preview.revision).toBe("same-revision");
    expect(preview.sameRevisionMissingAttachmentIds).toEqual([attachmentId]);
    expect(preview.actions).toHaveLength(1);
    const repairAction = preview.actions[0];
    expect(repairAction?.kind).toBe("create_attachment");
    if (repairAction?.kind !== "create_attachment")
      throw new Error("missing attachment repair action");
    expect(repairAction.source).toBe("remote");
    expect(repairAction.attachment).toMatchObject({
      attachmentId,
      path: "assets/image.png",
      contentHash: attachment.contentHash,
    });
    expect(remote.downloads.slice(downloadsBefore)).toEqual([
      {
        revision: "same-revision",
        attachmentId,
        contentHash: attachment.contentHash,
      },
    ]);
    expect(vault.exists("Wiki/assets/image.png")).toBe(false);
    expect(vault.operationLog).toEqual([]);
    expect(remote.createInputs).toEqual([]);
    expect(remote.finalizeCalls).toBe(0);

    await runtime.applyPullV3(preview);

    expect(await vault.read("Wiki/assets/image.png")).toEqual(PNG_2X3);
    expect(vault.text("Wiki/pages/local-only.md")).toBe("unrelated local edit");
    expect(vault.exists("Wiki/assets/unreferenced.png")).toBe(true);
    expect(
      await new TreeIdentityRepository(
        control,
        ".agentwiki/devices/d-local/spaces/s-space",
      ).read(),
    ).toEqual(identitiesBefore);
    expect(
      (
        await new TreeBaselineRepository(
          control,
          ".agentwiki/devices/d-local/spaces/s-space",
          "space",
          "Wiki",
        ).readSnapshot()
      ).revision,
    ).toBe("same-revision");
    const localPush = await runtime.previewPushV3();
    expect(localPush.changes).toHaveLength(1);
    const localChange = localPush.changes[0];
    expect(localChange?.operation).toBe("upsert_page");
    if (localChange?.operation !== "upsert_page")
      throw new Error("unrelated local Page edit was absorbed");
    expect(localChange.page.path).toBe("pages/local-only.md");
    const downloadsAfterRepair = remote.downloads.length;
    const second = await runtime.previewPullV3(undefined, {
      repairSameRevisionMissingRemoteAttachments: true,
    });
    expect(second.actions).toEqual([]);
    expect(second.sameRevisionMissingAttachmentIds).toEqual([]);
    expect(remote.downloads).toHaveLength(downloadsAfterRepair);
    expect(remote.createInputs).toEqual([]);
    expect(remote.finalizeCalls).toBe(0);
  });

  it("rejects a same-revision missing-image preview when the user recreates the path", async () => {
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const attachment = await v3Attachment(attachmentId, "assets/image.png");
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      revision: "same-revision",
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "![[assets/image.png]]",
          [attachmentId],
        ),
      ],
      attachments: [attachment],
      blobs: { [attachmentId]: PNG_2X3 },
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    await vault.trashFile("Wiki/assets/image.png");
    const preview = await runtime.previewPullV3(undefined, {
      repairSameRevisionMissingRemoteAttachments: true,
    });
    vault.seedFile("Wiki/assets/image.png", Uint8Array.of(1, 2, 3));
    vault.operationLog.length = 0;

    await expect(runtime.applyPullV3(preview)).rejects.toThrow(
      /STALE_PULL_PREVIEW/,
    );

    expect(await vault.read("Wiki/assets/image.png")).toEqual(
      Uint8Array.of(1, 2, 3),
    );
    expect(vault.operationLog).toEqual([]);
    expect(remote.createInputs).toEqual([]);
    expect(remote.finalizeCalls).toBe(0);
  });

  it("does not repair a same-revision image after the local Page removes its last reference", async () => {
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const attachment = await v3Attachment(attachmentId, "assets/image.png");
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      revision: "same-revision",
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "![[assets/image.png]]",
          [attachmentId],
        ),
      ],
      attachments: [attachment],
      blobs: { [attachmentId]: PNG_2X3 },
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    await vault.trashFile("Wiki/assets/image.png");
    vault.seedMarkdown("Wiki/pages/note.md", "reference intentionally removed");
    const downloadsBefore = remote.downloads.length;

    const preview = await runtime.previewPullV3(undefined, {
      repairSameRevisionMissingRemoteAttachments: true,
    });

    expect(preview.sameRevisionMissingAttachmentIds).toEqual([]);
    expect(
      preview.actions.some(
        (action) =>
          action.kind === "create_attachment" &&
          action.attachment.attachmentId === attachmentId,
      ),
    ).toBe(false);
    expect(remote.downloads).toHaveLength(downloadsBefore);
    expect(vault.exists("Wiki/assets/image.png")).toBe(false);
    expect(vault.text("Wiki/pages/note.md")).toBe(
      "reference intentionally removed",
    );
  });

  it("pushes a referenced image through strict v3 and repeats as zero-operation", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ revision: "rev-empty" });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedFile("Wiki/assets/image.png", PNG_2X3);
    vault.seedMarkdown("Wiki/pages/note.md", "![[assets/image.png]]");

    const preview = await runtime.previewPushV3();
    expect(preview.changes.map((change) => change.operation)).toEqual([
      "upsert_attachment",
      "upsert_page",
    ]);
    await runtime.applyPushV3(preview);
    expect(remote.createInputs[0]).toMatchObject({
      protocolVersion: "3",
      attachmentCount: 1,
      transferBlobBytes: PNG_2X3.byteLength,
    });
    expect(remote.uploadedChunkIndexes).toEqual([0]);
    expect(remote.finalizeCalls).toBe(1);
    expect((await runtime.previewPushV3()).changes).toEqual([]);
    expect(remote.createInputs).toHaveLength(1);
  });

  it("retains an edit made after v3 finalize as the next push", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ revision: "rev-empty" });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedMarkdown("Wiki/pages/note.md", "first");
    const first = await runtime.previewPushV3();
    remote.onFinalize = () =>
      vault.seedMarkdown("Wiki/pages/note.md", "second");

    await runtime.applyPushV3(first);

    remote.onFinalize = undefined;
    const next = await runtime.previewPushV3();
    expect(next.changes).toHaveLength(1);
    expect(next.changes[0]).toMatchObject({
      operation: "upsert_page",
      page: { path: "pages/note.md" },
    });
  });

  it("rebuilds a v3 push once after capabilities change", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ revision: "rev-empty" });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedMarkdown("Wiki/pages/note.md", "body");
    const preview = await runtime.previewPushV3();
    remote.changeCapabilitiesOnCreate = 1;

    await runtime.applyPushV3(preview);

    expect(remote.createInputs).toHaveLength(2);
    expect(remote.createInputs[1]?.capabilitiesHash).not.toBe(
      remote.createInputs[0]?.capabilitiesHash,
    );
    expect(remote.finalizeCalls).toBe(1);
  });

  it("rebuilds after a locally detected stage capability change without requiring a journal", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ revision: "rev-empty" });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedMarkdown("Wiki/pages/note.md", "body");
    const preview = await runtime.previewPushV3();
    remote.setCapabilities({
      ...(await remote.capabilities()),
      maxBatchItems: 99,
    });

    await runtime.applyPushV3(preview);

    expect(remote.createInputs).toHaveLength(1);
    expect(remote.createInputs[0]?.capabilitiesHash).not.toBe(
      preview.capabilitiesHash,
    );
    expect(remote.finalizeCalls).toBe(1);
  });

  it("does not supersede an earlier verified terminal journal during capability rebuild", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ revision: "rev-empty" });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedMarkdown("Wiki/pages/note.md", "first");
    await runtime.applyPushV3(await runtime.previewPushV3());
    vault.seedMarkdown("Wiki/pages/note.md", "second");
    const preview = await runtime.previewPushV3();
    remote.setCapabilities({
      ...(await remote.capabilities()),
      maxBatchItems: 99,
    });

    await runtime.applyPushV3(preview);

    expect(remote.createInputs).toHaveLength(2);
    expect(remote.finalizeCalls).toBe(2);
  });

  it("requires a new explicit preview when capability rebuild sees new local content", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ revision: "rev-empty" });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedMarkdown("Wiki/pages/note.md", "approved");
    const preview = await runtime.previewPushV3();
    remote.setCapabilities({
      ...(await remote.capabilities()),
      maxBatchItems: 99,
    });
    vault.seedMarkdown("Wiki/pages/note.md", "not approved");

    await expect(runtime.applyPushV3(preview)).rejects.toThrow(
      /PUSH_CONFIRMATION_REQUIRED/,
    );

    expect(remote.createInputs).toEqual([]);
    expect(
      await control.read(
        ".agentwiki/devices/d-local/spaces/s-space/push/journal.json",
      ),
    ).toBeNull();
    expect(
      [...control.files.keys()].some((path) => path.includes("/push/payload/")),
    ).toBe(false);
  });

  it("aborts and rebuilds after a locally detected pre-finalize capability change", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ revision: "rev-empty" });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedMarkdown("Wiki/pages/note.md", "body");
    let changed = false;
    remote.onUploadBatch = async () => {
      if (changed) return;
      changed = true;
      remote.setCapabilities({
        ...(await remote.capabilities()),
        maxBatchItems: 99,
      });
    };

    await runtime.applyPushV3(await runtime.previewPushV3());

    expect(remote.abortCalls).toBe(1);
    expect(remote.createInputs).toHaveLength(2);
    expect(remote.finalizeCalls).toBe(1);
  });

  it("rejects a second locally detected capability change", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ revision: "rev-empty" });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedMarkdown("Wiki/pages/note.md", "body");
    remote.onUploadBatch = async () => {
      const current = await remote.capabilities();
      remote.setCapabilities({
        ...current,
        maxBatchItems: current.maxBatchItems - 1,
      });
    };

    await expect(
      runtime.applyPushV3(await runtime.previewPushV3()),
    ).rejects.toThrow(/CAPABILITIES_CHANGED/);

    expect(remote.abortCalls).toBe(2);
    expect(remote.createInputs).toHaveLength(2);
    expect(remote.finalizeCalls).toBe(0);
  });

  it("keeps terminal snapshot verification and local commit non-cancellable", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ revision: "rev-empty" });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedMarkdown("Wiki/pages/note.md", "body");
    const controller = new AbortController();
    const progress: Array<{ phase: string; cancellable: boolean }> = [];

    await runtime.applyPushV3(await runtime.previewPushV3(), {
      signal: controller.signal,
      onProgress: (event) => {
        progress.push({ phase: event.phase, cancellable: event.cancellable });
        if (event.phase === "finalize") controller.abort();
      },
    });

    expect(remote.createInputs).toHaveLength(1);
    expect(remote.uploadedBatches).toHaveLength(1);
    expect(remote.finalizeCalls).toBe(1);
    expect(
      progress.slice(progress.findIndex((event) => event.phase === "finalize")),
    ).not.toContainEqual(expect.objectContaining({ cancellable: true }));
    expect((await runtime.previewPushV3()).changes).toEqual([]);
    expect(await runtime.hasUnfinishedPush()).toBe(false);
  });

  it("aborts before finalize when a local image or page drifts during upload", async () => {
    for (const drift of ["image", "page"] as const) {
      const remote = new FakeTreeRemoteV3();
      await remote.seedTree({ revision: "rev-empty" });
      const vault = new MemoryVault({});
      const control = new MemoryControlStore();
      const runtime = SyncRuntime.v3(vault, control, remote, mapping());
      await runtime.applyPullV3(await runtime.previewPullV3());
      vault.seedFile("Wiki/assets/image.png", PNG_2X3);
      vault.seedMarkdown("Wiki/pages/note.md", "![[assets/image.png]]");
      const preview = await runtime.previewPushV3();
      if (drift === "image")
        remote.onUploadBlobChunk = () =>
          vault.seedFile(
            "Wiki/assets/image.png",
            Uint8Array.from([...PNG_2X3.slice(0, -1), 1]),
          );
      else
        remote.onUploadBatch = () =>
          vault.seedMarkdown("Wiki/pages/note.md", "changed");

      await expect(runtime.applyPushV3(preview)).rejects.toThrow(
        /CONFIRMATION_MISMATCH|V3_PUSH_BLOCKED/,
      );
      expect(remote.abortCalls).toBe(1);
      expect(remote.finalizeCalls).toBe(0);
    }
  });

  it("recovers a published v3 terminal result without re-finalizing", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ revision: "rev-empty" });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedMarkdown("Wiki/pages/note.md", "body");
    remote.loseFinalizeResponseOnce = true;
    await expect(
      runtime.applyPushV3(await runtime.previewPushV3()),
    ).rejects.toThrow(/finalize response lost/);
    expect(remote.finalizeCalls).toBe(1);

    await SyncRuntime.v3(vault, control, remote, mapping()).recover();

    expect(remote.finalizeCalls).toBe(1);
    expect(
      (await SyncRuntime.v3(vault, control, remote, mapping()).previewPushV3())
        .changes,
    ).toEqual([]);
  });

  it("detaches the last reference without deleting local files or reading unreferenced images", async () => {
    const attachment = await v3Attachment(
      "11111111-1111-4111-8111-111111111111",
      "assets/image.png",
    );
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      revision: "rev-before",
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "![[assets/image.png]]",
          [attachment.attachmentId],
        ),
      ],
      attachments: [attachment],
      blobs: { [attachment.attachmentId]: PNG_2X3 },
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedFile("Wiki/assets/unreferenced.png", PNG_2X3);
    vault.seedMarkdown("Wiki/pages/note.md", "no image");
    vault.readPaths.length = 0;

    const preview = await runtime.previewPushV3();
    expect(preview.changes.map((change) => change.operation)).toEqual([
      "upsert_page",
      "detach_attachment",
    ]);
    await runtime.applyPushV3(preview);
    expect((await remote.head()).attachmentCount).toBe("0");
    expect(vault.exists("Wiki/assets/image.png")).toBe(true);
    expect(vault.exists("Wiki/assets/unreferenced.png")).toBe(true);
    expect(vault.readPaths).not.toContain("Wiki/assets/unreferenced.png");
    expect(remote.createInputs[0]).toMatchObject({
      attachmentCount: 0,
      transferBlobBytes: 0,
      blobRequirements: [],
    });
  });

  it("does not require or upload an unchanged base attachment for a page edit", async () => {
    const attachment = await v3Attachment(
      "11111111-1111-4111-8111-111111111111",
      "assets/image.png",
    );
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      revision: "rev-before",
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "![[assets/image.png]]",
          [attachment.attachmentId],
        ),
      ],
      attachments: [attachment],
      blobs: { [attachment.attachmentId]: PNG_2X3 },
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedMarkdown("Wiki/pages/note.md", "edited\n![[assets/image.png]]");

    await runtime.applyPushV3(await runtime.previewPushV3());

    expect(remote.createInputs[0]).toMatchObject({
      attachmentCount: 0,
      transferBlobBytes: 0,
      blobRequirements: [],
    });
    expect(remote.uploadedChunkIndexes).toEqual([]);
  });

  it("re-verifies staged Blob bytes before any Vault or generation effect", async () => {
    const attachment = await v3Attachment(
      "11111111-1111-4111-8111-111111111111",
      "assets/image.png",
    );
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "![[assets/image.png]]",
          [attachment.attachmentId],
        ),
      ],
      attachments: [attachment],
      blobs: { [attachment.attachmentId]: PNG_2X3 },
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    const preview = await runtime.previewPullV3();
    const stagedPath =
      ".agentwiki/devices/d-local/spaces/s-space/pull-staging/complete/" +
      attachment.contentHash +
      ".bin";
    control.binaryFiles.set(stagedPath, Uint8Array.of(0));

    await expect(runtime.applyPullV3(preview)).rejects.toThrow(
      /complete verification failed/i,
    );

    expect(vault.operationLog).toEqual([]);
    expect(
      await new TreeBaselineRepository(
        control,
        ".agentwiki/devices/d-local/spaces/s-space",
        "space",
        "Wiki",
      ).readOptional(),
    ).toBeNull();
  });

  it("rejects an invalidated v3 preview before any apply-time control or Vault write", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      revision: "rev-before",
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "base",
          [],
        ),
      ],
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    await remote.seedTree({
      revision: "rev-after",
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "remote",
          [],
        ),
      ],
    });
    const preview = await runtime.previewPullV3();
    const beforeControl = new Map(control.files);
    vault.operationLog.length = 0;
    vault.seedMarkdown("Wiki/pages/note.md", "edited after preview");
    runtime.invalidate();

    await expect(runtime.applyPullV3(preview)).rejects.toThrow(
      /STALE_PULL_PREVIEW/,
    );

    expect(vault.operationLog).toEqual([]);
    expect(vault.text("Wiki/pages/note.md")).toBe("edited after preview");
    expect(control.files).toEqual(beforeControl);
  });

  it("binds a v3 preview to raw Markdown bytes even without an invalidate event", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      revision: "rev-before",
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "local\n",
          [],
        ),
      ],
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedMarkdown("Wiki/pages/note.md", "local\r\n");
    await remote.seedTree({
      revision: "rev-after",
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "remote",
          [],
        ),
      ],
    });
    const preview = await runtime.previewPullV3();
    const beforeControl = new Map(control.files);
    vault.operationLog.length = 0;
    vault.seedMarkdown("Wiki/pages/note.md", "local\n");

    await expect(runtime.applyPullV3(preview)).rejects.toThrow(
      /STALE_PULL_PREVIEW/,
    );

    expect(vault.operationLog).toEqual([]);
    expect(vault.text("Wiki/pages/note.md")).toBe("local\n");
    expect(control.files).toEqual(beforeControl);
  });

  it("keeps the scan epoch captured before a user edit during v3 download", async () => {
    const attachment = await v3Attachment(
      "11111111-1111-4111-8111-111111111111",
      "assets/image.png",
    );
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      revision: "rev-before",
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "base",
          [],
        ),
      ],
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    await remote.seedTree({
      revision: "rev-after",
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "remote ![[assets/image.png]]",
          [attachment.attachmentId],
        ),
      ],
      attachments: [attachment],
      blobs: { [attachment.attachmentId]: PNG_2X3 },
    });
    remote.onDownload = () => {
      vault.seedMarkdown("Wiki/pages/note.md", "edited during download");
      runtime.invalidate();
    };

    const preview = await runtime.previewPullV3();
    remote.onDownload = undefined;
    vault.operationLog.length = 0;
    await expect(runtime.applyPullV3(preview)).rejects.toThrow(
      /STALE_PULL_PREVIEW/,
    );

    expect(vault.operationLog).toEqual([]);
    expect(vault.text("Wiki/pages/note.md")).toBe("edited during download");
  });

  it("does not overwrite a newly occupied v3 action destination without an invalidate event", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/new.md",
          "remote",
          [],
        ),
      ],
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    const preview = await runtime.previewPullV3();
    vault.seedMarkdown("Wiki/pages/new.md", "user-created");
    vault.operationLog.length = 0;

    await expect(runtime.applyPullV3(preview)).rejects.toThrow(
      /STALE_PULL_PREVIEW/,
    );

    expect(vault.operationLog).toEqual([]);
    expect(vault.text("Wiki/pages/new.md")).toBe("user-created");
  });

  it("does not accept bytes changed after preflight as the transaction before-image", async () => {
    const pageId = "22222222-2222-4222-8222-222222222222";
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      revision: "rev-before",
      pages: [await v3Page(pageId, "pages/note.md", "base", [])],
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    await remote.seedTree({
      revision: "rev-after",
      pages: [await v3Page(pageId, "pages/note.md", "remote", [])],
    });
    const preview = await runtime.previewPullV3();
    const beforeControl = new Map(control.files);
    vault.operationLog.length = 0;
    vault.onRead = (path) => {
      if (path !== "Wiki/pages/note.md") return;
      vault.onRead = undefined;
      vault.seedMarkdown(path, "changed between checks");
    };

    await expect(runtime.applyPullV3(preview)).rejects.toThrow(
      /STALE_PULL_PREVIEW/,
    );

    expect(vault.operationLog).toEqual([]);
    expect(vault.text("Wiki/pages/note.md")).toBe("changed between checks");
    expect(control.files).toEqual(beforeControl);
    expect(control.binaryFiles.size).toBe(0);
  });

  it("rejects a referenced image byte change without reading detached images", async () => {
    const attachment = await v3Attachment(
      "11111111-1111-4111-8111-111111111111",
      "assets/image.png",
    );
    const pageId = "22222222-2222-4222-8222-222222222222";
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      revision: "rev-before",
      pages: [
        await v3Page(pageId, "pages/note.md", "![[assets/image.png]]", [
          attachment.attachmentId,
        ]),
      ],
      attachments: [attachment],
      blobs: { [attachment.attachmentId]: PNG_2X3 },
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedFile("Wiki/assets/detached.png", PNG_2X3);
    await remote.seedTree({
      revision: "rev-after",
      pages: [
        await v3Page(pageId, "pages/note.md", "remote\n![[assets/image.png]]", [
          attachment.attachmentId,
        ]),
      ],
      attachments: [attachment],
      blobs: { [attachment.attachmentId]: PNG_2X3 },
    });
    vault.readPaths.length = 0;
    const preview = await runtime.previewPullV3();
    expect(vault.readPaths).not.toContain("Wiki/assets/detached.png");
    const beforeControl = new Map(control.files);
    vault.operationLog.length = 0;
    vault.seedFile("Wiki/assets/image.png", new Uint8Array([1, 2, 3]));

    await expect(runtime.applyPullV3(preview)).rejects.toThrow(
      /STALE_PULL_PREVIEW/,
    );
    expect(vault.operationLog).toEqual([]);
    expect(vault.readPaths).not.toContain("Wiki/assets/detached.png");
    expect(control.files).toEqual(beforeControl);
  });

  it("rejects a byte change below a directory scheduled for deletion", async () => {
    const folderId = "11111111-1111-4111-8111-111111111111";
    const pageId = "22222222-2222-4222-8222-222222222222";
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      revision: "rev-before",
      folders: [folder(folderId, null, "pages/Old")],
      pages: [
        {
          ...(await v3Page(pageId, "pages/Old/note.md", "base", [])),
          folderId,
        },
      ],
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    await remote.seedTree({ revision: "rev-after" });
    const preview = await runtime.previewPullV3();
    vault.seedMarkdown("Wiki/pages/Old/note.md", "edited after preview");
    vault.operationLog.length = 0;

    await expect(runtime.applyPullV3(preview)).rejects.toThrow(
      /STALE_PULL_PREVIEW/,
    );
    expect(vault.operationLog).toEqual([]);
    expect(vault.text("Wiki/pages/Old/note.md")).toBe("edited after preview");
  });

  it("reuses cancelled v3 Pull staging on the next preview", async () => {
    const attachment = await v3Attachment(
      "11111111-1111-4111-8111-111111111111",
      "assets/image.png",
    );
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "![[assets/image.png]]",
          [attachment.attachmentId],
        ),
      ],
      attachments: [attachment],
      blobs: { [attachment.attachmentId]: PNG_2X3 },
    });
    const runtime = SyncRuntime.v3(
      new MemoryVault({}),
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    const abort = new AbortController();
    remote.onDownload = () => abort.abort();
    await expect(
      runtime.previewPullV3({ signal: abort.signal }),
    ).rejects.toThrow();
    remote.onDownload = undefined;

    await expect(runtime.previewPullV3()).resolves.toEqual(
      expect.objectContaining({ revision: "rev-3" }),
    );
  });

  it("reuses retryable-failed v3 Pull staging on the next preview", async () => {
    const attachment = await v3Attachment(
      "11111111-1111-4111-8111-111111111111",
      "assets/image.png",
    );
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "![[assets/image.png]]",
          [attachment.attachmentId],
        ),
      ],
      attachments: [attachment],
      blobs: { [attachment.attachmentId]: PNG_2X3 },
    });
    remote.downloadFailuresRemaining = 1;
    const runtime = SyncRuntime.v3(
      new MemoryVault({}),
      new MemoryControlStore(),
      remote,
      mapping(),
    );

    await expect(runtime.previewPullV3()).rejects.toThrow(/retryable/);
    await expect(runtime.previewPullV3()).resolves.toEqual(
      expect.objectContaining({ revision: "rev-3" }),
    );
  });

  it("reuses completed v3 Pull staging after runtime reconstruction", async () => {
    const attachment = await v3Attachment(
      "11111111-1111-4111-8111-111111111111",
      "assets/image.png",
    );
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "![[assets/image.png]]",
          [attachment.attachmentId],
        ),
      ],
      attachments: [attachment],
      blobs: { [attachment.attachmentId]: PNG_2X3 },
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const abort = new AbortController();
    await expect(
      SyncRuntime.v3(vault, control, remote, mapping()).previewPullV3({
        signal: abort.signal,
        onProgress: (progress) => {
          if (progress.phase === "merge") abort.abort();
        },
      }),
    ).rejects.toThrow(/取消/);
    const downloads = remote.downloads.length;

    await expect(
      SyncRuntime.v3(vault, control, remote, mapping()).previewPullV3(),
    ).resolves.toEqual(expect.objectContaining({ revision: "rev-3" }));
    expect(remote.downloads).toHaveLength(downloads);
  });

  it("retains staging owned by an active recoverable v3 Pull transaction", async () => {
    const attachment = await v3Attachment(
      "11111111-1111-4111-8111-111111111111",
      "assets/image.png",
    );
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "![[assets/image.png]]",
          [attachment.attachmentId],
        ),
      ],
      attachments: [attachment],
      blobs: { [attachment.attachmentId]: PNG_2X3 },
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    const preview = await runtime.previewPullV3();
    control.failNextTextWriteAt =
      ".agentwiki/devices/d-local/spaces/s-space/tree-v2/current.json.next";
    await expect(runtime.applyPullV3(preview)).rejects.toThrow();
    const before = [...control.binaryFiles.keys()].filter((path) =>
      path.includes("/pull-staging/"),
    );

    await expect(
      SyncRuntime.v3(vault, control, remote, mapping()).previewPullV3(),
    ).rejects.toThrow(/PULL_RECOVERY_REQUIRED/);
    expect(
      [...control.binaryFiles.keys()].filter((path) =>
        path.includes("/pull-staging/"),
      ),
    ).toEqual(before);
  });

  it("pulls a remote attachment rename without redownloading identical local bytes and preserves an independent local Markdown edit", async () => {
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const pageId = "22222222-2222-4222-8222-222222222222";
    const original = await v3Attachment(attachmentId, "assets/image.png");
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      revision: "rev-before",
      pages: [
        await v3Page(pageId, "pages/note.md", "![[assets/image.png]]", [
          attachmentId,
        ]),
      ],
      attachments: [original],
      blobs: { [attachmentId]: PNG_2X3 },
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    const downloads = remote.downloads.length;
    vault.seedMarkdown(
      "Wiki/pages/note.md",
      "Local note\n\n![[assets/image.png]]",
    );
    const renamed = await v3Attachment(attachmentId, "assets/renamed.png");
    await remote.seedTree({
      revision: "rev-after",
      pages: [
        await v3Page(pageId, "pages/note.md", "![[assets/renamed.png]]", [
          attachmentId,
        ]),
      ],
      attachments: [renamed],
      blobs: { [attachmentId]: PNG_2X3 },
    });

    const preview = await runtime.previewPullV3();
    expect(remote.downloads).toHaveLength(downloads);
    expect(preview.pageConflicts).toHaveLength(1);
    await resolvePageConflictV3(preview, preview.pageConflicts[0]!.conflictId, {
      choice: "local",
    });
    await runtime.applyPullV3(preview);

    expect(vault.exists("Wiki/assets/image.png")).toBe(false);
    expect(vault.exists("Wiki/assets/renamed.png")).toBe(true);
    expect(vault.text("Wiki/pages/note.md")).toBe(
      "Local note\n\n![[assets/renamed.png]]",
    );
    const retainedEdit = await runtime.previewPushV3();
    expect(retainedEdit.changes).toHaveLength(1);
    expect(retainedEdit.changes[0]).toMatchObject({
      operation: "upsert_page",
      page: {
        pageId,
        referencedAttachmentIds: [attachmentId],
      },
    });
  });

  it("recovers a verified v3 Pull after the generation pointer write fails", async () => {
    const attachment = await v3Attachment(
      "11111111-1111-4111-8111-111111111111",
      "assets/image.png",
    );
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "![[assets/image.png]]",
          [attachment.attachmentId],
        ),
      ],
      attachments: [attachment],
      blobs: { [attachment.attachmentId]: PNG_2X3 },
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    const preview = await runtime.previewPullV3();
    control.failNextTextWriteAt =
      ".agentwiki/devices/d-local/spaces/s-space/tree-v2/current.json.next";

    await expect(runtime.applyPullV3(preview)).rejects.toThrow(
      /injected text write failure/,
    );
    const restarted = SyncRuntime.v3(vault, control, remote, mapping());
    await restarted.recover();

    expect(
      (
        await new TreeBaselineRepository(
          control,
          ".agentwiki/devices/d-local/spaces/s-space",
          "space",
          "Wiki",
        ).readSnapshot()
      ).protocolVersion,
    ).toBe("3");
    expect(
      (
        await new TreeIdentityRepository(
          control,
          ".agentwiki/devices/d-local/spaces/s-space/tree-identities.json",
        ).read()
      )?.payload.schemaVersion,
    ).toBe(2);
  });

  it("rolls back an uncommitted v3 Pull when generation writing fails", async () => {
    const attachment = await v3Attachment(
      "11111111-1111-4111-8111-111111111111",
      "assets/image.png",
    );
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "![[assets/image.png]]",
          [attachment.attachmentId],
        ),
      ],
      attachments: [attachment],
      blobs: { [attachment.attachmentId]: PNG_2X3 },
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    const preview = await runtime.previewPullV3();
    control.failWhenTextPathIncludes = "/tree-v2/generations/";

    await expect(runtime.applyPullV3(preview)).rejects.toThrow(
      /injected text write failure/,
    );
    expect(vault.operationLog).toEqual([
      "write:Wiki/assets/image.png",
      "write:Wiki/pages/note.md",
      "trash:Wiki/pages/note.md",
      "trash:Wiki/assets/image.png",
    ]);
    expect(
      [...control.binaryFiles.keys()].some((path) =>
        path.includes("/pull-staging/"),
      ),
    ).toBe(false);
    control.failWhenTextPathIncludes = null;
    const restarted = SyncRuntime.v3(vault, control, remote, mapping());
    await restarted.recover();

    expect(vault.exists("Wiki/pages/note.md")).toBe(false);
    expect(vault.exists("Wiki/assets/image.png")).toBe(false);
    expect(
      await new TreeBaselineRepository(
        control,
        ".agentwiki/devices/d-local/spaces/s-space",
        "space",
        "Wiki",
      ).readOptional(),
    ).toBeNull();
    expect(
      (
        await new TreeIdentityRepository(
          control,
          ".agentwiki/devices/d-local/spaces/s-space/tree-identities.json",
        ).read()
      )?.payload.schemaVersion,
    ).not.toBe(2);
  });

  it("does not switch the generation pointer when the user edits after generation write", async () => {
    const pageId = "22222222-2222-4222-8222-222222222222";
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      pages: [await v3Page(pageId, "pages/note.md", "remote", [])],
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    const preview = await runtime.previewPullV3();
    let injected = false;
    control.onTextWrite = async (path) => {
      if (injected || !path.endsWith("/manifest.json")) return;
      injected = true;
      vault.seedMarkdown("Wiki/pages/note.md", "user edit");
    };

    await expect(runtime.applyPullV3(preview)).rejects.toThrow(
      /TREE_TRANSACTION_AMBIGUOUS/,
    );

    expect(vault.text("Wiki/pages/note.md")).toBe("user edit");
    expect(
      await new TreeBaselineRepository(
        control,
        ".agentwiki/devices/d-local/spaces/s-space",
        "space",
        "Wiki",
      ).readOptional(),
    ).toBeNull();
  });

  it("records a stable attachment rename at an empty mapping root and ignores transaction temp renames", async () => {
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const attachment = await v3Attachment(attachmentId, "assets/image.png");
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      pages: [
        await v3Page(
          "22222222-2222-4222-8222-222222222222",
          "pages/note.md",
          "![[assets/image.png]]",
          [attachmentId],
        ),
      ],
      attachments: [attachment],
      blobs: { [attachmentId]: PNG_2X3 },
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, {
      spaceId: "space",
      rootPath: "",
      status: "pending",
    });
    await runtime.applyPullV3(await runtime.previewPullV3());
    await vault.rename("assets/image.png", "assets/renamed.png");
    vault.seedMarkdown("pages/note.md", "![[assets/renamed.png]]");

    await runtime.recordRename(
      "assets/.agentwiki-tmp-image.png",
      "assets/ignored.png",
    );
    await runtime.recordRename("assets/image.png", "assets/renamed.png");
    const preview = await runtime.previewPullV3();

    expect(preview.local.attachments).toContainEqual(
      expect.objectContaining({ attachmentId, path: "assets/renamed.png" }),
    );
  });

  it("preserves a stable page ID when the user renames a page under v3", async () => {
    const pageId = "22222222-2222-4222-8222-222222222222";
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      pages: [await v3Page(pageId, "pages/Before.md", "body", [])],
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    await vault.rename("Wiki/pages/Before.md", "Wiki/pages/After.md");
    await runtime.recordRename("Wiki/pages/Before.md", "Wiki/pages/After.md");

    const preview = await runtime.previewPullV3();

    expect(preview.local.pages).toContainEqual(
      expect.objectContaining({ pageId, path: "pages/After.md" }),
    );
  });

  it("does not turn its own v3 transaction rename event into a user move hint", async () => {
    const pageId = "22222222-2222-4222-8222-222222222222";
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      revision: "rev-before",
      pages: [await v3Page(pageId, "pages/Before.md", "body", [])],
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    await remote.seedTree({
      revision: "rev-after",
      pages: [await v3Page(pageId, "pages/After.md", "body", [])],
    });
    vault.onRename = (fromPath, toPath) =>
      runtime.recordRename(fromPath, toPath);

    await runtime.applyPullV3(await runtime.previewPullV3());

    expect(
      [...control.files.keys()].some((path) =>
        path.endsWith("/move-hints.json"),
      ),
    ).toBe(false);
  });

  it.each([
    ["local", "Local ![image](../assets/missing.png)", ""],
    ["remote", "", "Remote ![image](../assets/missing.png)"],
    ["unsupported", "", "Remote ![image](../assets/missing.svg)"],
  ])(
    "fails closed on a %s managed image candidate when using legacy sync",
    async (_side, localBody, remoteBody) => {
      const remote = new FakeTreeRemote();
      if (remoteBody)
        await remote.seed([await page("p1", "pages/Note.md", remoteBody)]);
      const vault = new MemoryVault(
        localBody ? { "Wiki/pages/Local.md": localBody } : {},
      );
      const control = new MemoryControlStore();
      const runtime = new SyncRuntime(vault, control, remote, mapping());

      await expect(runtime.previewPull()).rejects.toThrow(
        /SYNC_PROTOCOL_UPGRADE_REQUIRED/,
      );
      expect(control.files.size).toBe(0);
    },
  );

  it("ignores image candidates in Markdown outside the managed pages tree", async () => {
    const runtime = new SyncRuntime(
      new MemoryVault({
        "Wiki/README.md": "![[assets/readme.png]]",
        "Wiki/notes/foo.md": "![note](../assets/note.png)",
      }),
      new MemoryControlStore(),
      new FakeTreeRemote(),
      mapping(),
    );

    await expect(runtime.previewPull()).resolves.toEqual(
      expect.objectContaining({ actions: [] }),
    );
  });

  it("keeps external image references compatible with legacy sync", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([
      await page(
        "p1",
        "pages/Remote.md",
        "![remote](https://example.com/image.png)",
      ),
    ]);
    const runtime = new SyncRuntime(
      new MemoryVault({
        "Wiki/pages/Local.md": "![inline](data:image/png;base64,AA==)",
      }),
      new MemoryControlStore(),
      remote,
      mapping(),
    );

    await expect(runtime.previewPull()).resolves.toBeDefined();
  });
  it("pulls, moves, pushes, and re-pulls an empty folder tree", async () => {
    const remote = new FakeTreeRemote();
    await remote.seedTree({
      folders: [folder("f1", null, "pages/A")],
      pages: [],
    });
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    expect(vault.hasDirectory("Wiki/pages/A")).toBe(true);
    await vault.rename("Wiki/pages/A", "Wiki/pages/B");
    await runtime.applyPush(await runtime.previewPush());
    expect(remote.tree().folders[0]?.path).toBe("pages/B");
    await runtime.applyPull(await runtime.previewPull());
    expect(remote.tree().folders[0]?.path).toBe("pages/B");
  });

  it("reports remote delta items since the base revision", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/Guide.md", "hello")]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());

    const clean = await runtime.remoteDelta();
    expect(clean.ahead).toBe(false);
    expect(clean.items).toHaveLength(0);

    await remote.replace([await page("p1", "pages/Guide.md", "hello v2")]);
    const ahead = await runtime.remoteDelta();
    expect(ahead.ahead).toBe(true);
    expect(ahead.listed).toBe(true);
    expect(ahead.items).toHaveLength(1);
    expect(ahead.items[0]).toMatchObject({
      operation: "upsert_page",
      page: { path: "pages/Guide.md" },
    });
  });

  it("clones a pending remote mapping, then reports clean", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/Guide.md", "hello")]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    const preview = await runtime.previewPull();
    await runtime.applyPull(preview);
    expect(vault.text("Wiki/pages/Guide.md")).toBe("hello");
    expect((await runtime.status()).local.added).toHaveLength(0);
  });

  it("rejects guarded text Pull late edits before writing baseline or transaction sidecars", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/Guide.md", "base")]);
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = new SyncRuntime(vault, control, remote, mapping());
    await runtime.applyPull(await runtime.previewPull());
    await remote.replace([await page("p1", "pages/Guide.md", "remote")]);
    const preview = await runtime.previewPull();
    const expectedPathStates = {
      "Wiki/pages/Guide.md": {
        kind: "file" as const,
        hash: await sha256Hex(new TextEncoder().encode("base")),
      },
    };
    const controlBefore = new Map(control.files);

    await expect(
      runtime.applyPull(preview, undefined, {
        expectedPathStates,
        revalidate: async () => {
          await vault.write(
            "Wiki/pages/Guide.md",
            new TextEncoder().encode("late local edit"),
          );
        },
      }),
    ).rejects.toThrow("STALE_PULL_PREVIEW");

    expect(vault.text("Wiki/pages/Guide.md")).toBe("late local edit");
    expect(control.files).toEqual(controlBefore);
  });

  it("rechecks guarded text Pull state after yielding progress and before baseline writes", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/Guide.md", "base")]);
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = new SyncRuntime(vault, control, remote, mapping());
    await runtime.applyPull(await runtime.previewPull());
    await remote.replace([await page("p1", "pages/Guide.md", "remote")]);
    const preview = await runtime.previewPull();
    const expectedPathStates = {
      "Wiki/pages/Guide.md": {
        kind: "file" as const,
        hash: await sha256Hex(new TextEncoder().encode("base")),
      },
    };
    const controlBefore = new Map(control.files);
    let edited = false;

    await expect(
      runtime.applyPull(
        preview,
        {
          onProgress: () => {
            if (edited) return;
            edited = true;
            void vault.write(
              "Wiki/pages/Guide.md",
              new TextEncoder().encode("progress-race edit"),
            );
          },
        },
        { expectedPathStates, revalidate: async () => undefined },
      ),
    ).rejects.toThrow("STALE_PULL_PREVIEW");

    expect(vault.text("Wiki/pages/Guide.md")).toBe("progress-race edit");
    expect(control.files).toEqual(controlBefore);
  });

  it("previews and pushes local edits only after explicit apply", async () => {
    const remote = new FakeTreeRemote();
    const vault = new MemoryVault({ "Wiki/pages/New.md": "new" });
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.establishEmptyBase();
    const preview = await runtime.previewPush();
    expect(preview.changes).toHaveLength(1);
    expect((await remote.snapshot()).items).toHaveLength(0);
    await runtime.applyPush(preview);
    expect((await remote.snapshot()).items[0]?.body).toBe("new");
  });

  it("first-publishes local content from a relation-only nonzero remote head", async () => {
    const remote = new FakeTreeRemote();
    await remote.advanceEmptyRevision();
    const vault = new MemoryVault({ "Wiki/pages/New.md": "new" });
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    const preview = await runtime.previewPush();
    expect(preview.baseRevision).toBe("1");
    expect(preview.changes).toHaveLength(1);
    await runtime.applyPush(preview);
    expect((await remote.snapshot()).items[0]?.body).toBe("new");
  });

  it("requires initial Pull before pending local content can be pushed over remote pages", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/Remote.md", "remote")]);
    const runtime = new SyncRuntime(
      new MemoryVault({ "Wiki/pages/Local.md": "local" }),
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await expect(runtime.previewPush()).rejects.toThrow(
      /INITIAL_PULL_REQUIRED/,
    );
  });

  it("three-way merges non-overlapping local and remote edits", async () => {
    const remote = new FakeTreeRemote();
    const original = "top\nmiddle\nbottom";
    await remote.seed([await page("p1", "pages/Guide.md", original)]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    await vault.write(
      "Wiki/pages/Guide.md",
      new TextEncoder().encode("TOP\nmiddle\nbottom"),
    );
    const remoteEdit = "top\nmiddle\nBOTTOM";
    await remote.replace([await page("p1", "pages/Guide.md", remoteEdit)]);
    const preview = await runtime.previewPull();
    expect(preview.pageConflicts).toHaveLength(0);
    expect(preview.actions[0]).toMatchObject({ kind: "write_page" });
    await runtime.applyPull(preview);
    expect(vault.text("Wiki/pages/Guide.md")).toBe("TOP\nmiddle\nBOTTOM");
    expect((await runtime.status()).local.modified).toHaveLength(1);
  });

  it("blocks Pull application until structured conflicts are resolved", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/A.md", "same")]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    await vault.write("Wiki/pages/A.md", new TextEncoder().encode("local"));
    await remote.replace([await page("p1", "pages/A.md", "remote")]);
    const preview = await runtime.previewPull();
    expect(preview.pageConflicts).toHaveLength(1);
    expect(preview.pageConflicts[0]).toMatchObject({
      base: "same",
      local: "local",
      remote: "remote",
    });
    await expect(runtime.applyPull(preview)).rejects.toThrow(/冲突/);
    preview.pageConflictResolutions[preview.pageConflicts[0]!.conflictId] = {
      choice: "remote",
    };
    await runtime.applyPull(preview);
    expect(vault.text("Wiki/pages/A.md")).toBe("remote");
  });

  it("treats remote archive versus local edit as a conflict", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/A.md", "base")]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    await vault.write(
      "Wiki/pages/A.md",
      new TextEncoder().encode("local edit"),
    );
    await remote.replace([]);
    const preview = await runtime.previewPull();
    expect(preview.pageConflicts).toHaveLength(1);
    expect(preview.actions).toHaveLength(0);
  });

  it("preserves the archived page identity when Local is chosen for an archive conflict", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/A.md", "base")]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    await vault.write("Wiki/pages/A.md", new TextEncoder().encode("local"));
    await remote.replace([]);
    const preview = await runtime.previewPull();
    preview.pageConflictResolutions[preview.pageConflicts[0]!.conflictId] = {
      choice: "local",
    };
    await runtime.applyPull(preview);
    expect(vault.text("Wiki/pages/A.md")).toBe("local");
    expect((await runtime.status()).local.deleted).toHaveLength(0);
  });

  it("keeps the local file with manual content when Manual is chosen for an archive conflict", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/A.md", "base")]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    await vault.write("Wiki/pages/A.md", new TextEncoder().encode("local"));
    await remote.replace([]);
    const preview = await runtime.previewPull();
    preview.pageConflictResolutions[preview.pageConflicts[0]!.conflictId] = {
      choice: "manual",
      manualValue: "manual final",
    };
    await runtime.applyPull(preview);
    expect(vault.text("Wiki/pages/A.md")).toBe("manual final");
  });

  it("moves the existing page when the remote renames the same pageId", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/Old.md", "body")]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    await remote.replace([await page("p1", "pages/New.md", "body")]);
    const preview = await runtime.previewPull();
    expect(preview.actions[0]).toMatchObject({
      kind: "move_page",
      fromPath: "pages/Old.md",
      path: "pages/New.md",
    });
    await runtime.applyPull(preview);
    expect(vault.exists("Wiki/pages/Old.md")).toBe(false);
    expect(vault.text("Wiki/pages/New.md")).toBe("body");
  });

  it("returns clean without creating an empty push session", async () => {
    const remote = new FakeTreeRemote();
    const runtime = new SyncRuntime(
      new MemoryVault({}),
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.establishEmptyBase();
    const preview = await runtime.previewPush();
    expect(preview.changes).toHaveLength(0);
    await runtime.applyPush(preview);
    expect(remote.sessionCount()).toBe(0);
  });

  it("imports the v1 baseline only after confirmation", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/A.md", "base")]);
    const vault = new MemoryVault({ "Wiki/pages/A.md": "base" });
    const control = new MemoryControlStore();
    const root = ".agentwiki/devices/d-local/spaces/s-space";
    const treeBaseline = new TreeBaselineRepository(
      control,
      root,
      "space",
      "Wiki",
    );
    const legacyBaseline = new BaselineRepository(
      control,
      root,
      "space",
      "Wiki",
    );
    await legacyBaseline.prepare(
      "1",
      [await page("p1", "pages/A.md", "base")],
      "pull",
    );
    await legacyBaseline.commit();
    const runtime = new SyncRuntime(vault, control, remote, mapping());
    expect(await treeBaseline.readOptional()).toBeNull();
    const preview = await runtime.previewPull();
    expect(await treeBaseline.readOptional()).toBeNull();
    await runtime.applyPull(preview);
    expect((await treeBaseline.read()).protocolVersion).toBe("2");
    expect((await legacyBaseline.read()).revision).toBe("1");
  });

  it("blocks a missing mapping root without deleting the mapping", async () => {
    const remote = new FakeTreeRemote();
    const vault = new MemoryVault({});
    vault.setRootStatus("missing");
    const m = mapping("active");
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, m);
    await expect(runtime.status()).rejects.toThrow("MAPPING_ROOT_MISSING");
    expect(m).toEqual({ spaceId: "space", rootPath: "Wiki", status: "active" });
  });

  it("blocks a file used as the mapping root without deleting the mapping", async () => {
    const remote = new FakeTreeRemote();
    const vault = new MemoryVault({});
    vault.setRootStatus("file");
    const m = mapping("pending");
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, m);
    await expect(runtime.previewPush()).rejects.toThrow(
      "MAPPING_ROOT_NOT_DIRECTORY",
    );
    expect(m).toEqual({
      spaceId: "space",
      rootPath: "Wiki",
      status: "pending",
    });
  });

  it("rejects a truncated remote snapshot before planning destructive Pull actions", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/A.md", "base")]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    remote.truncateNextSnapshot = true;
    await expect(runtime.previewPull()).rejects.toThrow(
      /快照(完整性|字节数|对象数量)/,
    );
    expect(vault.text("Wiki/pages/A.md")).toBe("base");
  });

  it("rejects a remote page whose body does not match its content hash", async () => {
    const remote = new FakeTreeRemote();
    const body = "base";
    await remote.seed([
      {
        pageId: "p1",
        path: "pages/A.md",
        title: "A",
        body: "tampered",
        contentHash: await contentHash(body),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const runtime = new SyncRuntime(
      new MemoryVault({}),
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await expect(runtime.previewPull()).rejects.toThrow(/内容哈希不匹配/);
  });

  it("preserves the archived page identity across a local-wins archive", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/A.md", "base")]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    await vault.write("Wiki/pages/A.md", new TextEncoder().encode("local"));
    await remote.replace([]);
    const preview = await runtime.previewPull();
    preview.pageConflictResolutions[preview.pageConflicts[0]!.conflictId] = {
      choice: "local",
    };
    await runtime.applyPull(preview);
    const push = await runtime.previewPush();
    expect(push.changes[0]).toMatchObject({
      operation: "upsert_page",
      page: { pageId: "p1", path: "pages/A.md" },
    });
  });

  it("binds a same-path local document during initial pull and keeps it dirty", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("p1", "pages/A.md", "remote")]);
    const vault = new MemoryVault({ "Wiki/pages/A.md": "local" });
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    const preview = await runtime.previewPull();
    expect(preview.pageConflicts).toHaveLength(1);
    await expect(runtime.applyPull(preview)).rejects.toThrow(/冲突/);
    preview.pageConflictResolutions[preview.pageConflicts[0]!.conflictId] = {
      choice: "local",
    };
    await runtime.applyPull(preview);
    expect(vault.text("Wiki/pages/A.md")).toBe("local");
    expect((await runtime.status()).local.modified).toHaveLength(1);
  });

  it("uses a v1 confirmation hash for the v1 tree adapter", async () => {
    const remote = new FakeTreeRemote();
    remote.setProtocol("1");
    const vault = new MemoryVault({ "Wiki/pages/New.md": "new" });
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.establishEmptyBase();
    const preview = await runtime.previewPush();
    const upsert = preview.changes.find(
      (change) => change.operation === "upsert_page",
    )!;
    await runtime.applyPush(preview);
    expect((await remote.snapshot()).items[0]?.body).toBe("new");
    const manifest = {
      protocolVersion: "1" as const,
      spaceId: "space",
      baseRevision: "0",
      changes: [
        {
          operation: "upsert" as const,
          pageId: upsert.page.pageId,
          path: "pages/New.md",
          title: "New",
          contentHash: upsert.page.contentHash,
        },
      ],
    };
    expect(remote.lastCreateInput?.confirmationHash).toBe(
      await confirmationHash(manifest),
    );
  });

  it("does not delete unfinished journals before recovering", async () => {
    const remote = new FakeTreeRemote();
    const vault = new MemoryVault({ "Wiki/pages/A.md": "a" });
    const control = new MemoryControlStore();
    const runtime = new SyncRuntime(vault, control, remote, mapping());
    await runtime.establishEmptyBase();
    remote.canPublish = false;
    const preview = await runtime.previewPush();
    await expect(runtime.applyPush(preview)).rejects.toThrow(/SPACE_READ_ONLY/);
    const journalPath =
      ".agentwiki/devices/d-local/spaces/s-space/push/journal.json";
    expect(await control.read(journalPath)).not.toBeNull();
    remote.canPublish = true;
    await runtime.recover();
    expect(await control.read(journalPath)).not.toBeNull();
  });

  it("fails closed on an unknown future push journal version", async () => {
    const remote = new FakeTreeRemote();
    const control = new MemoryControlStore();
    const runtime = new SyncRuntime(
      new MemoryVault({}),
      control,
      remote,
      mapping(),
    );
    await control.write(
      ".agentwiki/devices/d-local/spaces/s-space/push/journal.json",
      JSON.stringify({
        envelopeSchemaVersion: 1,
        writeGeneration: 1,
        payloadHash: "x".repeat(64),
        payload: { schemaVersion: 9, spaceId: "space" },
      }),
    );
    await expect(runtime.recover()).rejects.toThrow(
      "检测到未知或未来的控制 payload 版本",
    );
  });

  it("clones an empty-bodied page without treating it as a missing sidecar", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("empty", "pages/Empty.md", "")]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    expect(vault.text("Wiki/pages/Empty.md")).toBe("");
  });

  it("supersedes an unfinished Push after credential rotation instead of replaying it", async () => {
    const remote = new FakeTreeRemote();
    const vault = new MemoryVault({ "Wiki/pages/A.md": "a" });
    const control = new MemoryControlStore();
    const m = mapping();
    const runtimeA = new SyncRuntime(
      vault,
      control,
      remote,
      m,
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
      m,
      "device",
      "space",
      "cred-b",
    );
    await runtimeB.recover();
    expect(await runtimeB.hasUnfinishedPush()).toBe(false);
  });

  it("does not block disconnect after a cancelled Push is superseded", async () => {
    const remote = new FakeTreeRemote();
    const runtime = new SyncRuntime(
      new MemoryVault({ "Wiki/pages/A.md": "a" }),
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.establishEmptyBase();
    const preview = await runtime.previewPush();
    const controller = new AbortController();
    await expect(
      runtime.applyPush(preview, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === "upload" && progress.completed >= 1)
            controller.abort();
        },
      }),
    ).rejects.toThrow(/取消/);
    expect(await runtime.hasUnfinishedPush()).toBe(false);
    expect((await runtime.status()).local.added).toHaveLength(1);
  });

  it("yields and cancels while scanning local files before creating a Push", async () => {
    const remote = new FakeTreeRemote();
    const vault = new MemoryVault(
      Object.fromEntries(
        Array.from({ length: 60 }, (_, index) => [
          "Wiki/pages/P" + index + ".md",
          "page " + index,
        ]),
      ),
    );
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    const controller = new AbortController();
    await expect(
      runtime.previewPush({
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === "scan" && progress.completed >= 50)
            controller.abort();
        },
      }),
    ).rejects.toThrow(/取消/);
    expect(remote.sessionCount()).toBe(0);
  });

  it("yields and cancels while planning local archives", async () => {
    const remote = new FakeTreeRemote();
    const pages = await Promise.all(
      Array.from({ length: 60 }, async (_, index) =>
        page("p" + index, "pages/P" + index + ".md", "page " + index),
      ),
    );
    await remote.seed(pages);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    for (let index = 0; index < 60; index += 1)
      await vault.remove("Wiki/pages/P" + index + ".md");
    const controller = new AbortController();
    await expect(
      runtime.previewPush({
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === "merge" && progress.completed >= 50)
            controller.abort();
        },
      }),
    ).rejects.toThrow(/取消/);
  });

  it("routes a schema-1 push journal through the legacy push service", async () => {
    const legacyRemote = new FakeAgentWiki();
    const control = new MemoryControlStore();
    const root = ".agentwiki/devices/d-device/spaces/s-space";
    const v1 = new PushService(legacyRemote, control, root + "/push");
    legacyRemote.canPublish = false;
    await expect(
      v1.publish({
        spaceId: "space",
        baseRevision: "0",
        capabilities: legacyRemote.capabilities,
        changes: [
          {
            operation: "upsert",
            pageId: "p1",
            path: "pages/A.md",
            title: "A",
            body: "a",
            contentHash: await contentHash("a"),
          },
        ],
      }),
    ).rejects.toThrow(/SPACE_READ_ONLY/);
    legacyRemote.canPublish = true;
    const runtime = new SyncRuntime(
      new MemoryVault({}),
      control,
      new FakeTreeRemote(),
      mapping(),
      "device",
      "space",
      "cred",
      legacyRemote,
    );
    expect(await runtime.hasUnfinishedPush()).toBe(true);
    await runtime.recover();
    expect(await runtime.hasUnfinishedPush()).toBe(false);
  });

  it("rejects malformed candidates before routing even when a newer candidate exists", async () => {
    const remote = new FakeTreeRemote();
    const control = new MemoryControlStore();
    const runtime = new SyncRuntime(
      new MemoryVault({}),
      control,
      remote,
      mapping(),
    );
    const base = ".agentwiki/devices/d-local/spaces/s-space/push";
    await control.write(
      base + "/journal.json",
      JSON.stringify({
        envelopeSchemaVersion: 1,
        writeGeneration: 1,
        payloadHash: "x".repeat(64),
        payload: { schemaVersion: 1 },
      }),
    );
    await control.write(
      base + "/journal.json.next",
      JSON.stringify({
        envelopeSchemaVersion: 1,
        writeGeneration: 2,
        payloadHash: "x".repeat(64),
        payload: { schemaVersion: 3 },
      }),
    );
    const before = [...control.files];
    await expect(runtime.recover()).rejects.toThrow(
      "检测到未知或未来的控制 payload 版本",
    );
    expect([...control.files]).toEqual(before);
  });

  it("applies a legacy pull-control-after state during recovery", async () => {
    const control = new MemoryControlStore();
    const root = ".agentwiki/devices/d-local/spaces/s-space";
    const runtime = new SyncRuntime(
      new MemoryVault({}),
      control,
      new FakeTreeRemote(),
      mapping(),
    );
    const writeEnvelope = async (path: string, payload: unknown) => {
      await control.write(
        path,
        JSON.stringify({
          envelopeSchemaVersion: 1,
          writeGeneration: 1,
          payloadHash: await sha256Hex(canonicalBytes(payload)),
          payload,
        }),
      );
    };
    await writeEnvelope(root + "/pull/journal.json", {
      schemaVersion: 1,
      transactionId: "tx1",
      state: "committed",
      scanEpoch: 0,
      actions: [],
      snapshots: [],
      temporaryPaths: [],
      materialized: [],
    });
    await writeEnvelope(root + "/pull-control-after.json", {
      schemaVersion: 1,
      transactionId: "tx1",
      phase: "pending",
      identities: {
        schemaVersion: 1,
        entries: {
          p1: {
            intent: "restore",
            pageId: "p1",
            path: "pages/A.md",
            contentHash: "h".repeat(64),
            archivedBasePath: "pages/A.md",
            archivedBaseTitle: "A",
            archivedBaseContentHash: "h".repeat(64),
          },
        },
      },
      moveHints: {
        schemaVersion: 1,
        hints: [
          {
            pageId: "p1",
            fromPath: "pages/A.md",
            toPath: "pages/B.md",
            observedVaultByteHash: "h".repeat(64),
          },
        ],
      },
    });
    await runtime.recover();
    const identities = JSON.parse(
      (await control.read(root + "/tree-identities.json"))!,
    ) as {
      payload: {
        pendingPages: Record<string, { pageId: string; path: string }>;
      };
    };
    expect(identities.payload.pendingPages.p1).toMatchObject({
      pageId: "p1",
      path: "pages/A.md",
    });
    const moveHints = JSON.parse(
      (await control.read(root + "/move-hints.json"))!,
    ) as { payload: { hints: Array<{ pageId: string; toPath: string }> } };
    expect(moveHints.payload.hints[0]).toMatchObject({
      pageId: "p1",
      toPath: "pages/B.md",
    });
  });

  it("pushes a v1 nested page path without folder changes", async () => {
    const remote = new FakeTreeRemote();
    remote.setProtocol("1");
    const vault = new MemoryVault({ "Wiki/pages/A/P.md": "# p" });
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.establishEmptyBase();
    const preview = await runtime.previewPush();
    expect(
      preview.changes.filter((change) => change.operation === "upsert_folder"),
    ).toHaveLength(0);
    expect(
      preview.changes.some(
        (change) =>
          change.operation === "upsert_page" &&
          change.page.path === "pages/A/P.md",
      ),
    ).toBe(true);
    await runtime.applyPush(preview);
    expect((await remote.snapshot()).items[0]?.path).toBe("pages/A/P.md");
  });

  it("rejects a snapshot whose page exceeds the body byte limit", async () => {
    const remote = new FakeTreeRemote();
    const huge = "x".repeat(2 * 1024 * 1024);
    await remote.seed([
      {
        pageId: "p1",
        path: "pages/A.md",
        title: "A",
        body: huge,
        contentHash: await contentHash(huge),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const runtime = new SyncRuntime(
      new MemoryVault({}),
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await expect(runtime.previewPull()).rejects.toThrow(/PAGE_TOO_LARGE/);
  });

  it("keeps v1 nested pages folder-less across the full sync cycle", async () => {
    const remote = new FakeTreeRemote();
    remote.setProtocol("1");
    const vault = new MemoryVault({ "Wiki/pages/A/P.md": "# p" });
    const runtime = new SyncRuntime(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.establishEmptyBase();
    const initial = await runtime.previewPush();
    const upsert = initial.changes.find(
      (change) => change.operation === "upsert_page",
    )!;
    const pageId = upsert.page.pageId;
    await runtime.applyPush(initial);

    await runtime.applyPull(await runtime.previewPull());
    const status = await runtime.status();
    expect(status.local.added).toHaveLength(0);
    expect(status.local.modified).toHaveLength(0);
    expect(status.local.renamed).toHaveLength(0);
    expect((await runtime.previewPush()).changes).toHaveLength(0);

    await remote.replace([
      {
        pageId,
        path: "pages/A/P.md",
        title: "P",
        body: "remote v2",
        contentHash: await contentHash("remote v2"),
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const preview = await runtime.previewPull();
    expect(
      preview.actions.some(
        (action) => action.kind === "trash_page" || action.kind === "move_page",
      ),
    ).toBe(false);
    expect(
      preview.actions.some(
        (action) => action.kind === "write_page" && action.pageId === pageId,
      ),
    ).toBe(true);
  });
});
