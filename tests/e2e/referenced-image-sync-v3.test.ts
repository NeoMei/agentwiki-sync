import { describe, expect, it } from "vitest";
import { SyncRuntime } from "../../src/application/sync-runtime";
import { AgentWikiClient } from "../../src/agentwiki/client";
import { V2TreeRemote } from "../../src/agentwiki/v2-tree-remote";
import {
  canonicalBytes,
  contentHash,
  sha256Hex,
} from "../../src/agentwiki/protocol";
import { treeRevisionContentHashV2 } from "@neomei/agentwiki-sync-protocol";
import { resolvePageConflictV3 } from "../../src/application/tree-diff";
import { resolveAttachmentConflict } from "../../src/application/tree-diff";
import { inspectImageMetadata } from "../../src/core/image-metadata";
import type { TreeAttachment, TreePageV3 } from "../../src/core/tree-model";
import { FakeTreeRemote, FakeTreeRemoteV3 } from "../fakes/fake-tree-remote";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { MemoryVault } from "../fakes/memory-vault";
import { FakeHttp } from "../fakes/fake-http";

const IMAGE = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  ),
  (value) => value.charCodeAt(0),
);
const REPLACEMENT = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAQAAABeK7cBAAAADUlEQVR42mNk+M/wHwAF/gL+G1T4WQAAAABJRU5ErkJggg==",
  ),
  (value) => value.charCodeAt(0),
);
const REMOTE_REPLACEMENT = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/l5u2AAAAAElFTkSuQmCC",
  ),
  (value) => value.charCodeAt(0),
);
const ATTACHMENT_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID = "22222222-2222-4222-8222-222222222222";
const mapping = () => ({
  spaceId: "space",
  rootPath: "Wiki",
  status: "pending" as const,
});
const LEGACY_V2_CAPABILITIES = {
  ...FakeHttp.capabilities,
  maxClientSpaceFolders: 10_000,
  maxSnapshotObjects: 15_000,
  maxDeltaItems: 15_000,
};

class FailingWriteVault extends MemoryVault {
  failNextWriteAt: string | null = null;
  override async write(path: string, bytes: Uint8Array): Promise<void> {
    if (path === this.failNextWriteAt) {
      this.failNextWriteAt = null;
      throw new Error(`injected Vault write failure: ${path}`);
    }
    await super.write(path, bytes);
  }
}

async function attachment(
  bytes = IMAGE,
  path = "assets/image.png",
): Promise<TreeAttachment> {
  const metadata = inspectImageMetadata(bytes, {
    maxImageDimension: 10_000,
    maxDecodedPixels: 40_000_000,
    allowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  });
  return {
    attachmentId: ATTACHMENT_ID,
    path,
    mimeType: metadata.mimeType,
    sizeBytes: String(bytes.byteLength),
    width: metadata.width,
    height: metadata.height,
    contentHash: await sha256Hex(bytes),
    updatedAt: "2026-09-06T00:00:00.000Z",
  };
}

async function page(
  body: string,
  references: string[] = [],
): Promise<TreePageV3> {
  return {
    pageId: PAGE_ID,
    folderId: null,
    path: "pages/Note.md",
    title: "Note",
    body,
    contentHash: await contentHash(body),
    updatedAt: "2026-09-06T00:00:00.000Z",
    referencedAttachmentIds: references,
  };
}

async function runCompatibilityFixture(
  server: string,
  plugin: string,
  fixture: string,
): Promise<"sync" | "fallback" | "block" | "upgrade"> {
  const hasImages = fixture === "with images";
  if (server.startsWith("v3") && plugin === "v2 plugin") {
    const http = new FakeHttp();
    const client = new AgentWikiClient(
      "https://wiki.example.com",
      http,
      () => "test-credential",
    );
    const remote = new V2TreeRemote(client, "space", {
      version: "2",
      capabilities: LEGACY_V2_CAPABILITIES,
      capabilitiesHash: "c".repeat(64),
    });
    const headPath = "/api/sync/v2/spaces/space/head";
    if (hasImages) {
      http.route("GET", headPath, {
        status: 409,
        json: {
          protocolVersion: "3",
          error: {
            code: "SYNC_PROTOCOL_UPGRADE_REQUIRED",
            retryable: false,
          },
        },
      });
      await expect(
        new SyncRuntime(
          new MemoryVault({}),
          new MemoryControlStore(),
          remote,
          mapping(),
        ).previewPull(),
      ).rejects.toMatchObject({
        status: 409,
        body: {
          error: { code: "SYNC_PROTOCOL_UPGRADE_REQUIRED" },
        },
      });
      expect(http.calls.map((call) => call.path)).toEqual([headPath]);
      return "upgrade";
    }
    const emptyManifest = {
      protocolVersion: "2" as const,
      spaceId: "space",
      folders: [],
      pages: [],
    };
    const revisionContentHash = await treeRevisionContentHashV2(emptyManifest);
    const revisionManifestByteLength = String(
      canonicalBytes(emptyManifest).byteLength,
    );
    const metadata = {
      protocolVersion: "2" as const,
      spaceId: "space",
      revision: "v3-empty-projection",
      sequence: 1,
      revisionContentHash,
      folderCount: "0",
      pageCount: "0",
      revisionManifestByteLength,
      revisionBodyBytes: "0",
    };
    http.route("GET", headPath, {
      status: 200,
      json: { ...metadata, publishedAt: "2026-09-06T00:00:00.000Z" },
    });
    http.route("GET", "/api/sync/v2/spaces/space/snapshot", {
      status: 200,
      json: { ...metadata, folders: [], pages: [], nextCursor: null },
    });
    const runtime = new SyncRuntime(
      new MemoryVault({}),
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPull(await runtime.previewPull());
    expect(http.calls.map((call) => call.path)).toEqual([
      headPath,
      "/api/sync/v2/spaces/space/snapshot?revision=v3-empty-projection",
    ]);
    return "sync";
  }
  if (server === "v3 server") {
    const remote = new FakeTreeRemoteV3();
    const image = await attachment();
    await remote.seedTree(
      hasImages
        ? {
            pages: [await page("![[assets/image.png]]", [ATTACHMENT_ID])],
            attachments: [image],
            blobs: { [ATTACHMENT_ID]: IMAGE },
          }
        : { pages: [await page("plain text")] },
    );
    const vault = new MemoryVault({});
    const runtime = SyncRuntime.v3(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPullV3(await runtime.previewPullV3());
    if (hasImages)
      expect(await vault.read("Wiki/assets/image.png")).toEqual(IMAGE);
    return "sync";
  }
  const remote = new FakeTreeRemote();
  remote.setProtocol(server === "v1 server" ? "1" : "2");
  const remoteBody =
    fixture === "with remote candidate" ? "![[assets/image.png]]" : "plain";
  await remote.seed([
    {
      pageId: PAGE_ID,
      path: "pages/Note.md",
      title: "Note",
      body: remoteBody,
      contentHash: await contentHash(remoteBody),
      updatedAt: "2026-09-06T00:00:00.000Z",
    },
  ]);
  const vault = new MemoryVault(
    fixture === "with local candidate"
      ? { "Wiki/pages/Local.md": "![[assets/image.png]]" }
      : {},
  );
  const runtime = new SyncRuntime(
    vault,
    new MemoryControlStore(),
    remote,
    mapping(),
  );
  try {
    await runtime.applyPull(await runtime.previewPull());
  } catch (error) {
    if (String(error).includes("SYNC_PROTOCOL_UPGRADE_REQUIRED"))
      return "block";
    throw error;
  }
  return "fallback";
}

describe("referenced image sync v3 compatibility", () => {
  it.each([
    ["v3 server", "v3 plugin", "with images", "sync"],
    ["v3 server", "v3 plugin", "without images", "sync"],
    ["v2 server", "v3 plugin", "without candidates", "fallback"],
    ["v2 server", "v3 plugin", "with local candidate", "block"],
    ["v2 server", "v3 plugin", "with remote candidate", "block"],
    ["v1 server", "v3 plugin", "without candidates", "fallback"],
    ["v1 server", "v3 plugin", "with remote candidate", "block"],
    ["v3 attached revision", "v2 plugin", "with images", "upgrade"],
    ["v3 empty projection", "v2 plugin", "without images", "sync"],
  ] as const)(
    "handles %s + %s + %s as %s",
    async (server, plugin, fixture, result) => {
      expect(await runCompatibilityFixture(server, plugin, fixture)).toBe(
        result,
      );
    },
  );
});

describe("referenced image sync v3 end to end", () => {
  it("round-trips web Pull, local replacement Push, and a second device Pull", async () => {
    const remote = new FakeTreeRemoteV3();
    const firstImage = await attachment();
    await remote.seedTree({
      pages: [await page("![[assets/image.png]]", [ATTACHMENT_ID])],
      attachments: [firstImage],
      blobs: { [ATTACHMENT_ID]: IMAGE },
    });
    const desktopVault = new MemoryVault({});
    const desktopControl = new MemoryControlStore();
    const desktop = SyncRuntime.v3(
      desktopVault,
      desktopControl,
      remote,
      mapping(),
      "desktop",
    );
    await desktop.applyPullV3(await desktop.previewPullV3());
    expect(await desktopVault.read("Wiki/assets/image.png")).toEqual(IMAGE);

    desktopVault.seedFile("Wiki/assets/image.png", REPLACEMENT);
    await desktop.applyPushV3(await desktop.previewPushV3());

    const mobileVault = new MemoryVault({});
    const mobile = SyncRuntime.v3(
      mobileVault,
      new MemoryControlStore(),
      remote,
      mapping(),
      "mobile",
    );
    await mobile.applyPullV3(await mobile.previewPullV3());
    expect(await mobileVault.read("Wiki/assets/image.png")).toEqual(
      REPLACEMENT,
    );
  });

  it("resolves a simultaneous page edit without silently dropping either side", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      revision: "base",
      pages: [await page("top\nmiddle\nbottom")],
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedMarkdown("Wiki/pages/Note.md", "LOCAL\nmiddle\nbottom");
    await remote.seedTree({
      revision: "remote",
      pages: [await page("top\nmiddle\nREMOTE")],
    });
    const preview = await runtime.previewPullV3();
    expect(preview.pageConflicts).toHaveLength(0);
    await runtime.applyPullV3(preview);
    expect(vault.text("Wiki/pages/Note.md")).toBe("LOCAL\nmiddle\nREMOTE");
  });

  it("applies an explicit remote choice for overlapping dual-side page edits", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ revision: "base", pages: [await page("base")] });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedMarkdown("Wiki/pages/Note.md", "local");
    await remote.seedTree({
      revision: "remote",
      pages: [await page("remote")],
    });
    const preview = await runtime.previewPullV3();
    expect(preview.pageConflicts).toHaveLength(1);
    await resolvePageConflictV3(preview, preview.pageConflicts[0]!.conflictId, {
      choice: "remote",
    });
    await runtime.applyPullV3(preview);
    expect(vault.text("Wiki/pages/Note.md")).toBe("remote");
    expect((await runtime.previewPushV3()).changes).toEqual([]);
  });

  it("does not transfer detached or never-referenced local images", async () => {
    const remote = new FakeTreeRemoteV3();
    const image = await attachment();
    await remote.seedTree({
      revision: "before",
      pages: [await page("![[assets/image.png]]", [ATTACHMENT_ID])],
      attachments: [image],
      blobs: { [ATTACHMENT_ID]: IMAGE },
    });
    const vault = new MemoryVault({});
    const runtime = SyncRuntime.v3(
      vault,
      new MemoryControlStore(),
      remote,
      mapping(),
    );
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedFile("Wiki/assets/unused.png", REPLACEMENT);
    vault.seedMarkdown("Wiki/pages/Note.md", "plain text");
    vault.readPaths.length = 0;
    await runtime.applyPushV3(await runtime.previewPushV3());
    expect(vault.exists("Wiki/assets/image.png")).toBe(true);
    expect(vault.exists("Wiki/assets/unused.png")).toBe(true);
    expect(vault.readPaths).not.toContain("Wiki/assets/unused.png");
    expect(remote.uploadedChunkIndexes).toEqual([]);
    expect((await remote.head()).attachmentCount).toBe("0");
  });

  it("propagates remote and local attachment renames without changing bytes", async () => {
    const remote = new FakeTreeRemoteV3();
    const original = await attachment();
    await remote.seedTree({
      revision: "base",
      pages: [await page("![[assets/image.png]]", [ATTACHMENT_ID])],
      attachments: [original],
      blobs: { [ATTACHMENT_ID]: IMAGE },
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());

    await remote.seedTree({
      revision: "remote-rename",
      pages: [await page("![[assets/remote.png]]", [ATTACHMENT_ID])],
      attachments: [await attachment(IMAGE, "assets/remote.png")],
      blobs: { [ATTACHMENT_ID]: IMAGE },
    });
    await runtime.applyPullV3(await runtime.previewPullV3());
    expect(vault.exists("Wiki/assets/image.png")).toBe(false);
    expect(await vault.read("Wiki/assets/remote.png")).toEqual(IMAGE);

    await vault.rename("Wiki/assets/remote.png", "Wiki/assets/local.png");
    vault.seedMarkdown("Wiki/pages/Note.md", "![[assets/local.png]]");
    await runtime.recordRename(
      "Wiki/assets/remote.png",
      "Wiki/assets/local.png",
    );
    await runtime.applyPushV3(await runtime.previewPushV3());
    expect((await remote.head()).attachmentCount).toBe("1");
    const follower = new MemoryVault({});
    const followerRuntime = SyncRuntime.v3(
      follower,
      new MemoryControlStore(),
      remote,
      mapping(),
      "follower",
    );
    await followerRuntime.applyPullV3(await followerRuntime.previewPullV3());
    expect(await follower.read("Wiki/assets/local.png")).toEqual(IMAGE);
    expect(follower.text("Wiki/pages/Note.md")).toBe("![[assets/local.png]]");
  });

  it.each(["local", "remote"] as const)(
    "keeps both conflicting image contents with %s as primary through Push and a new-device Pull",
    async (primary) => {
      const secondPageId = "33333333-3333-4333-8333-333333333333";
      const secondaryAttachmentId = "44444444-4444-4444-8444-444444444444";
      const secondaryPath =
        primary === "local"
          ? "assets/image-remote.png"
          : "assets/image-local.png";
      const primaryBytes =
        primary === "local" ? REPLACEMENT : REMOTE_REPLACEMENT;
      const secondaryBytes =
        primary === "local" ? REMOTE_REPLACEMENT : REPLACEMENT;
      const makePage = async (pageId: string, path: string) => ({
        ...(await page("![[assets/image.png]]", [ATTACHMENT_ID])),
        pageId,
        path,
        title: path.endsWith("One.md") ? "One" : "Two",
      });
      const remote = new FakeTreeRemoteV3();
      await remote.seedTree({
        revision: "base",
        pages: [
          await makePage(PAGE_ID, "pages/One.md"),
          await makePage(secondPageId, "pages/Two.md"),
        ],
        attachments: [await attachment()],
        blobs: { [ATTACHMENT_ID]: IMAGE },
      });
      const vault = new MemoryVault({});
      const control = new MemoryControlStore();
      const runtime = SyncRuntime.v3(vault, control, remote, mapping());
      await runtime.applyPullV3(await runtime.previewPullV3());
      vault.seedFile("Wiki/assets/image.png", REPLACEMENT);
      await remote.seedTree({
        revision: "remote-change",
        pages: [
          await makePage(PAGE_ID, "pages/One.md"),
          await makePage(secondPageId, "pages/Two.md"),
        ],
        attachments: [await attachment(REMOTE_REPLACEMENT)],
        blobs: { [ATTACHMENT_ID]: REMOTE_REPLACEMENT },
      });

      const preview = await runtime.previewPullV3();
      expect(preview.attachmentConflicts).toHaveLength(1);
      await resolveAttachmentConflict(
        preview,
        preview.attachmentConflicts[0]!.conflictId,
        {
          choice: "keep_both",
          primary,
          secondaryAttachmentId,
          secondaryPath,
          redirectPageIds: [secondPageId],
        },
      );
      await runtime.applyPullV3(preview);
      expect(await vault.read("Wiki/assets/image.png")).toEqual(primaryBytes);
      expect(await vault.read(`Wiki/${secondaryPath}`)).toEqual(secondaryBytes);
      expect(vault.text("Wiki/pages/One.md")).toBe("![[assets/image.png]]");
      expect(vault.text("Wiki/pages/Two.md")).toBe(`![[${secondaryPath}]]`);

      await runtime.applyPushV3(await runtime.previewPushV3());
      const follower = new MemoryVault({});
      const followerRuntime = SyncRuntime.v3(
        follower,
        new MemoryControlStore(),
        remote,
        mapping(),
        `follower-${primary}`,
      );
      await followerRuntime.applyPullV3(await followerRuntime.previewPullV3());
      expect(await follower.read("Wiki/assets/image.png")).toEqual(
        primaryBytes,
      );
      expect(await follower.read(`Wiki/${secondaryPath}`)).toEqual(
        secondaryBytes,
      );
      expect(follower.text("Wiki/pages/Two.md")).toBe(`![[${secondaryPath}]]`);
    },
  );

  it.each(["local", "manual", "remote"] as const)(
    "keeps a resolved %s Page body choice while redirecting its attachment to the keep-both copy",
    async (pageChoice) => {
      const secondPageId = "33333333-3333-4333-8333-333333333333";
      const secondaryAttachmentId = "44444444-4444-4444-8444-444444444444";
      const secondaryPath = "assets/image-remote.png";
      const makePage = async (
        pageId: string,
        path: string,
        label: "base" | "local" | "remote",
      ) => ({
        ...(await page(`${label} ${path}\n![[assets/image.png]]`, [
          ATTACHMENT_ID,
        ])),
        pageId,
        path,
        title: path.endsWith("One.md") ? "One" : "Two",
      });
      const remote = new FakeTreeRemoteV3();
      await remote.seedTree({
        revision: "base",
        pages: [
          await makePage(PAGE_ID, "pages/One.md", "base"),
          await makePage(secondPageId, "pages/Two.md", "base"),
        ],
        attachments: [await attachment()],
        blobs: { [ATTACHMENT_ID]: IMAGE },
      });
      const vault = new MemoryVault({});
      const runtime = SyncRuntime.v3(
        vault,
        new MemoryControlStore(),
        remote,
        mapping(),
      );
      await runtime.applyPullV3(await runtime.previewPullV3());
      vault.seedMarkdown(
        "Wiki/pages/One.md",
        "local pages/One.md\n![[assets/image.png]]",
      );
      vault.seedMarkdown(
        "Wiki/pages/Two.md",
        "local pages/Two.md\n![[assets/image.png]]",
      );
      vault.seedFile("Wiki/assets/image.png", REPLACEMENT);
      await remote.seedTree({
        revision: "remote-change",
        pages: [
          await makePage(PAGE_ID, "pages/One.md", "remote"),
          await makePage(secondPageId, "pages/Two.md", "remote"),
        ],
        attachments: [await attachment(REMOTE_REPLACEMENT)],
        blobs: { [ATTACHMENT_ID]: REMOTE_REPLACEMENT },
      });

      const sourcePreview = await runtime.previewPullV3();
      expect(sourcePreview.pageConflicts).toHaveLength(2);
      const resolvedPagesPreview = structuredClone(sourcePreview);
      for (const conflict of sourcePreview.pageConflicts) {
        const selectedBody =
          pageChoice === "manual"
            ? `manual ${conflict.pageId}\n![[assets/image.png]]`
            : undefined;
        await resolvePageConflictV3(
          resolvedPagesPreview,
          conflict.conflictId,
          pageChoice === "manual"
            ? { choice: "manual", manualValue: selectedBody }
            : { choice: pageChoice },
        );
      }
      // The modal serializes each choice by recomputing from its immutable
      // source preview, then copies the accumulated resolution maps across.
      const preview = structuredClone(sourcePreview);
      preview.pageConflictResolutions = structuredClone(
        resolvedPagesPreview.pageConflictResolutions,
      );
      expect(preview.attachmentConflicts).toHaveLength(1);
      await resolveAttachmentConflict(
        preview,
        preview.attachmentConflicts[0]!.conflictId,
        {
          choice: "keep_both",
          primary: "local",
          secondaryAttachmentId,
          secondaryPath,
          redirectPageIds: [secondPageId],
        },
      );

      const firstBody =
        pageChoice === "manual"
          ? `manual ${PAGE_ID}\n![[assets/image.png]]`
          : `${pageChoice} pages/One.md\n![[assets/image.png]]`;
      const secondBody =
        pageChoice === "manual"
          ? `manual ${secondPageId}\n![[${secondaryPath}]]`
          : `${pageChoice} pages/Two.md\n![[${secondaryPath}]]`;
      expect(
        preview.resolvedPages.find((item) => item.pageId === PAGE_ID),
      ).toMatchObject({
        body: firstBody,
        referencedAttachmentIds: [ATTACHMENT_ID],
      });
      expect(
        preview.resolvedPages.find((item) => item.pageId === secondPageId),
      ).toMatchObject({
        body: secondBody,
        referencedAttachmentIds: [secondaryAttachmentId],
      });
      expect(preview.actions).toContainEqual(
        expect.objectContaining({
          kind: "write_page",
          pageId: secondPageId,
          path: "pages/Two.md",
        }),
      );

      await runtime.applyPullV3(preview);
      expect(vault.text("Wiki/pages/One.md")).toBe(firstBody);
      expect(vault.text("Wiki/pages/Two.md")).toBe(secondBody);
      const primaryBytes = (await vault.read("Wiki/assets/image.png"))!;
      const secondaryBytes = (await vault.read(`Wiki/${secondaryPath}`))!;
      expect(primaryBytes).toEqual(REPLACEMENT);
      expect(secondaryBytes).toEqual(REMOTE_REPLACEMENT);
      expect(await sha256Hex(primaryBytes)).toBe(await sha256Hex(REPLACEMENT));
      expect(await sha256Hex(secondaryBytes)).toBe(
        await sha256Hex(REMOTE_REPLACEMENT),
      );

      await runtime.applyPushV3(await runtime.previewPushV3());
      const followerVault = new MemoryVault({});
      const follower = SyncRuntime.v3(
        followerVault,
        new MemoryControlStore(),
        remote,
        mapping(),
        `resolved-${pageChoice}`,
      );
      await follower.applyPullV3(await follower.previewPullV3());
      expect(followerVault.text("Wiki/pages/One.md")).toBe(firstBody);
      expect(followerVault.text("Wiki/pages/Two.md")).toBe(secondBody);
      expect(await followerVault.read("Wiki/assets/image.png")).toEqual(
        REPLACEMENT,
      );
      expect(await followerVault.read(`Wiki/${secondaryPath}`)).toEqual(
        REMOTE_REPLACEMENT,
      );
    },
  );
});

describe("referenced image sync v3 fault recovery", () => {
  it("resumes a failed Blob upload after restart", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ revision: "empty" });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedFile("Wiki/assets/image.png", IMAGE);
    vault.seedMarkdown("Wiki/pages/Note.md", "![[assets/image.png]]");
    remote.onUploadBlobChunk = () => {
      throw new Error("injected Blob upload failure");
    };

    await expect(
      runtime.applyPushV3(await runtime.previewPushV3()),
    ).rejects.toThrow(/injected Blob upload failure/);
    remote.onUploadBlobChunk = undefined;
    await SyncRuntime.v3(vault, control, remote, mapping()).recover();

    expect((await remote.head()).attachmentCount).toBe("1");
    expect(remote.finalizeCalls).toBe(1);
  });

  it("retries a Blob download after restart without partial Vault writes", async () => {
    const remote = new FakeTreeRemoteV3();
    const image = await attachment();
    await remote.seedTree({
      pages: [await page("![[assets/image.png]]", [ATTACHMENT_ID])],
      attachments: [image],
      blobs: { [ATTACHMENT_ID]: IMAGE },
    });
    remote.downloadFailuresRemaining = 1;
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    await expect(
      SyncRuntime.v3(vault, control, remote, mapping()).previewPullV3(),
    ).rejects.toThrow(/retryable/);
    expect(vault.operationLog).toEqual([]);
    const restarted = SyncRuntime.v3(vault, control, remote, mapping());
    await restarted.applyPullV3(await restarted.previewPullV3());
    expect(await vault.read("Wiki/assets/image.png")).toEqual(IMAGE);
  });

  it("recovers a lost finalize response without publishing twice", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ revision: "empty" });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedFile("Wiki/assets/image.png", IMAGE);
    vault.seedMarkdown("Wiki/pages/Note.md", "![[assets/image.png]]");
    remote.loseFinalizeResponseOnce = true;
    await expect(
      runtime.applyPushV3(await runtime.previewPushV3()),
    ).rejects.toThrow(/finalize response lost/);
    await SyncRuntime.v3(vault, control, remote, mapping()).recover();
    expect(remote.finalizeCalls).toBe(1);
    expect((await remote.head()).attachmentCount).toBe("1");
  });

  it("rolls back image and Markdown writes when generation staging fails", async () => {
    const remote = new FakeTreeRemoteV3();
    const image = await attachment();
    await remote.seedTree({
      pages: [await page("![[assets/image.png]]", [ATTACHMENT_ID])],
      attachments: [image],
      blobs: { [ATTACHMENT_ID]: IMAGE },
    });
    const vault = new MemoryVault({});
    const control = new MemoryControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    const preview = await runtime.previewPullV3();
    control.failWhenTextPathIncludes = "/tree-v2/generations/";
    await expect(runtime.applyPullV3(preview)).rejects.toThrow(
      /injected text write failure/,
    );
    expect(vault.exists("Wiki/assets/image.png")).toBe(false);
    expect(vault.exists("Wiki/pages/Note.md")).toBe(false);
  });

  it.each(["Wiki/assets/image.png", "Wiki/pages/Note.md"])(
    "recovers after a %s Vault write failure",
    async (path) => {
      const remote = new FakeTreeRemoteV3();
      const image = await attachment();
      await remote.seedTree({
        pages: [await page("![[assets/image.png]]", [ATTACHMENT_ID])],
        attachments: [image],
        blobs: { [ATTACHMENT_ID]: IMAGE },
      });
      const vault = new FailingWriteVault({});
      const control = new MemoryControlStore();
      const runtime = SyncRuntime.v3(vault, control, remote, mapping());
      const preview = await runtime.previewPullV3();
      vault.failNextWriteAt = path;
      await expect(runtime.applyPullV3(preview)).rejects.toThrow(
        /injected Vault write failure/,
      );

      const restarted = SyncRuntime.v3(vault, control, remote, mapping());
      await restarted.recover();
      await restarted.applyPullV3(await restarted.previewPullV3());
      expect(await vault.read("Wiki/assets/image.png")).toEqual(IMAGE);
      expect(vault.text("Wiki/pages/Note.md")).toBe("![[assets/image.png]]");
    },
  );

  it("finishes the verified Pull after a generation pointer switch failure", async () => {
    const remote = new FakeTreeRemoteV3();
    const image = await attachment();
    await remote.seedTree({
      pages: [await page("![[assets/image.png]]", [ATTACHMENT_ID])],
      attachments: [image],
      blobs: { [ATTACHMENT_ID]: IMAGE },
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

    await SyncRuntime.v3(vault, control, remote, mapping()).recover();

    expect(await vault.read("Wiki/assets/image.png")).toEqual(IMAGE);
    expect((await remote.head()).revision).toBe("rev-3");
  });
});
