import {
  blobChunkHashV3,
  canonicalBytes,
  canonicalTreeRevisionManifestV2,
  treeCapabilitiesHashV3,
  treeRevisionContentHashV2,
} from "@neomei/agentwiki-sync-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Notice } from "obsidian";

import { capabilitiesHash, contentHash } from "../../src/agentwiki/protocol";
import { AgentWikiClient } from "../../src/agentwiki/client";
import { LocalImageUpgradeEntry } from "../../src/application/local-image-upgrade-entry";
import { ProtocolNegotiator } from "../../src/application/protocol-negotiator";
import type { SyncRuntime } from "../../src/application/sync-runtime";
import { resolvePageConflictV3 } from "../../src/application/tree-diff";
import {
  prepareLegacyUpgradePreview,
  projectLegacyBase,
  type UpgradePreview,
} from "../../src/application/local-image-upgrade-plan";
import { selectSpaceSyncRoute } from "../../src/application/space-sync-route";
import type { ConnectionState } from "../../src/application/connection-service";
import type { SpaceMapping } from "../../src/application/sync-coordinator";
import type { ModalTransition } from "../../src/obsidian/modal-handoff";
import { PreviewModal } from "../../src/obsidian/preview-modal";
import { SyncCenterModal } from "../../src/obsidian/sync-center-modal";
import { ObsidianControlStore } from "../../src/obsidian/adapters";
import { scanLocalTree } from "../../src/core/tree-scan";
import { idFileKey } from "../../src/core/identity-key";
import { ConfirmedUpgradePreviewRepository } from "../../src/storage/local-image-upgrade-confirmation";
import {
  LocalImageUpgradeRepository,
  type UpgradeIntent,
} from "../../src/storage/local-image-upgrade";
import { ProtocolSelectionRepository } from "../../src/storage/protocol-selection";
import { emptyTreeIdentityStateV2 } from "../../src/storage/tree-identities";
import AgentWikiSyncPlugin from "../../src/main";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { MemoryVault } from "../fakes/memory-vault";
import { FakeHttp } from "../fakes/fake-http";
import { requestUrlState } from "../fakes/obsidian-mock";
import type {
  MockElement,
  MockRequestUrlResponse,
} from "../fakes/obsidian-mock";
import { makePlugin, modalButton } from "../fakes/plugin-harness";
import { V3_CAPABILITIES } from "../fakes/fake-tree-remote";

const EMPTY_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const CONTROL_ROOT = ".agentwiki/devices/d-device/spaces/s-space";
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00,
]);
const V2_CAPABILITIES = {
  maxPageBytes: 1_048_576,
  maxBatchBytes: 4_194_304,
  maxBatchItems: 100,
  maxChangeCount: 100,
  maxConfirmationBytes: 4_194_304,
  maxClientSpacePages: 5_000,
  maxClientSpaceFolders: 10_000,
  maxSnapshotObjects: 15_000,
  maxClientManifestBytes: 4_194_304,
  maxClientTotalBodyBytes: 2_097_152,
  maxDeltaItems: 15_000,
  maxResponseBytes: 4_194_304,
  maxPageItems: 200,
  pushSessionTtlSeconds: 900,
};

const noticeMessages = (): string[] =>
  (Notice as unknown as { messages: string[] }).messages;

const originalUpgradeConfirm = (): LocalImageUpgradeEntry["confirm"] => {
  const value = Object.getOwnPropertyDescriptor(
    LocalImageUpgradeEntry.prototype,
    "confirm",
  )?.value as unknown;
  if (typeof value !== "function") throw new Error("missing confirm method");
  return value as LocalImageUpgradeEntry["confirm"];
};

async function makeUpgradeEntryFixture(
  input: {
    canPublish?: boolean;
    rootStatus?: "folder" | "missing" | "file";
    remoteBody?: string;
  } = {},
) {
  const store = new MemoryControlStore();
  const vault = new MemoryVault({});
  vault.seedMarkdown("Wiki/pages/note.md", "note\n![](../assets/used.png)\n");
  vault.seedFile("Wiki/assets/used.png", PNG);
  if (input.rootStatus) vault.setRootStatus(input.rootStatus);
  const http = new FakeHttp();
  const v2Hash = await capabilitiesHash(V2_CAPABILITIES);
  const v3Hash = await treeCapabilitiesHashV3(V3_CAPABILITIES);
  const remoteRevision = input.remoteBody === undefined ? "0" : "remote-text";
  const remotePages =
    input.remoteBody === undefined
      ? []
      : [
          {
            pageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            folderId: null,
            path: "pages/note.md",
            title: "note",
            body: input.remoteBody,
            contentHash: await contentHash(input.remoteBody),
            updatedAt: "2026-09-06T00:00:00.000Z",
          },
        ];
  const remoteHash = await treeRevisionContentHashV2({
    protocolVersion: "2",
    spaceId: "space-1",
    folders: [],
    pages: remotePages,
  });
  const remoteBodyBytes = remotePages.reduce(
    (total, page) => total + new TextEncoder().encode(page.body).byteLength,
    0,
  );
  const remoteManifestBytes = remotePages.length
    ? canonicalBytes(
        canonicalTreeRevisionManifestV2({
          protocolVersion: "2",
          spaceId: "space-1",
          folders: [],
          pages: remotePages,
        }),
      ).byteLength
    : 0;
  http.route("GET", "/api/integrations/obsidian/session", {
    status: 200,
    json: {
      protocolVersion: "1",
      serverInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      credentialId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      deviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      deviceName: "Test Device",
      vaultId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      createdAt: "2026-09-06T00:00:00.000Z",
      lastUsedAt: "2026-09-06T00:00:00.000Z",
      credentialStatus: "active",
      provisionalExpiresAt: null,
      user: { id: "user-1", displayName: "User" },
      capabilities: V2_CAPABILITIES,
    },
  });
  http.route("GET", "/api/sync/v3/capabilities", {
    status: 200,
    json: {
      protocolVersion: "3",
      capabilities: V3_CAPABILITIES,
      capabilitiesHash: v3Hash,
    },
  });
  http.route("GET", "/api/sync/v2/capabilities", {
    status: 200,
    json: {
      protocolVersion: "2",
      capabilities: V2_CAPABILITIES,
      capabilitiesHash: v2Hash,
    },
  });
  http.route("GET", "/api/sync/v3/spaces", {
    status: 200,
    json: {
      protocolVersion: "3",
      spaces: [
        {
          spaceId: "space-1",
          displayName: "Legacy Space",
          role: input.canPublish === false ? "viewer" : "owner",
          canRead: true,
          canPublish: input.canPublish !== false,
          syncMode: "legacy_v2",
          currentRevision: remoteRevision,
          folderCount: "0",
          pageCount: String(remotePages.length),
          attachmentCount: "0",
          revisionManifestByteLength: String(remoteManifestBytes),
          revisionBodyBytes: String(remoteBodyBytes),
          revisionAttachmentBytes: "0",
        },
      ],
    },
  });
  http.route("GET", "/api/sync/v2/spaces/space-1/head", {
    status: 200,
    json: {
      protocolVersion: "2",
      spaceId: "space-1",
      revision: remoteRevision,
      sequence: remoteRevision === "0" ? 0 : 1,
      revisionContentHash: remoteHash,
      folderCount: "0",
      pageCount: String(remotePages.length),
      revisionManifestByteLength: String(remoteManifestBytes),
      revisionBodyBytes: String(remoteBodyBytes),
      publishedAt: null,
    },
  });
  http.route("GET", "/api/sync/v2/spaces/space-1/snapshot", {
    status: 200,
    json: {
      protocolVersion: "2",
      spaceId: "space-1",
      revision: remoteRevision,
      sequence: remoteRevision === "0" ? 0 : 1,
      revisionContentHash: remoteHash,
      folderCount: "0",
      pageCount: String(remotePages.length),
      revisionManifestByteLength: String(remoteManifestBytes),
      revisionBodyBytes: String(remoteBodyBytes),
      folders: [],
      pages: remotePages,
      nextCursor: null,
    },
  });
  const client = new AgentWikiClient(
    "https://wiki.example.com",
    http,
    () => "secret",
  );
  const entry = await LocalImageUpgradeEntry.create({
    client,
    protocols: new ProtocolNegotiator(
      client,
      new ProtocolSelectionRepository(store),
    ),
    vault,
    control: store,
    controlRoot: CONTROL_ROOT,
    mapping: { spaceId: "space-1", rootPath: "Wiki", status: "active" },
    authority: {
      serverOrigin: "https://wiki.example.com",
      serverInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      pluginVersion: "0.4.0",
      deviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      credentialId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      vaultId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    },
  });
  return { entry, http, store, vault, v2Hash, v3Hash };
}

async function pluginUpgradeHarness(
  input: {
    serverVersion?: "1" | "2" | "3";
    syncMode?: "legacy_v2" | "bootstrap_required" | "native_v3";
    spacesStatus?: 401 | 403 | 409 | 429 | 500;
    lateEditAfterFinalize?: boolean;
    remoteBody?: string;
    localBody?: string;
    includeLocalImage?: boolean;
  } = {},
) {
  const connection: ConnectionState = {
    schemaVersion: 1,
    serverUrl: "https://wiki.example.com",
    serverInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    credentialId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    credentialSecretId: "secret-1",
    deviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    vaultId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  };
  const includeLocalImage = input.includeLocalImage ?? true;
  const harness = await makePlugin({
    data: {
      schemaVersion: 2,
      serverUrl: connection.serverUrl,
      mappings: [{ spaceId: "space-1", rootPath: "Wiki", status: "active" }],
    },
    connection,
    vaultFiles: {
      ".agentwiki/vault.json": JSON.stringify({
        schemaVersion: 1,
        vaultId: connection.vaultId,
      }),
      "Wiki/pages/note.md":
        input.localBody ??
        (includeLocalImage
          ? "note\n![](../assets/used.png)\n"
          : "local text only\n"),
      ...(includeLocalImage ? { "Wiki/assets/used.png": PNG } : {}),
    },
  });
  await harness.plugin.onload();
  const v2Hash = await capabilitiesHash(V2_CAPABILITIES);
  const v3Hash = await treeCapabilitiesHashV3(V3_CAPABILITIES);
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  let publishPreview: UpgradePreview | null = null;
  let syncMode = input.syncMode ?? "legacy_v2";
  const sessionId = "77777777-7777-4777-8777-777777777777";
  let remoteRevision = input.remoteBody === undefined ? "0" : "remote-text";
  let remotePages =
    input.remoteBody === undefined
      ? []
      : [
          {
            pageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            folderId: null,
            path: "pages/note.md",
            title: "note",
            body: input.remoteBody,
            contentHash: await contentHash(input.remoteBody),
            updatedAt: "2026-09-06T00:00:00.000Z",
          },
        ];
  let uploadedV2Changes: Array<{
    operation: string;
    page?: (typeof remotePages)[number];
  }> = [];
  const remoteMetrics = async () => {
    const revisionContentHash = await treeRevisionContentHashV2({
      protocolVersion: "2",
      spaceId: "space-1",
      folders: [],
      pages: remotePages,
    });
    const revisionBodyBytes = remotePages.reduce(
      (total, page) => total + new TextEncoder().encode(page.body).byteLength,
      0,
    );
    const revisionManifestByteLength = remotePages.length
      ? canonicalBytes(
          canonicalTreeRevisionManifestV2({
            protocolVersion: "2",
            spaceId: "space-1",
            folders: [],
            pages: remotePages,
          }),
        ).byteLength
      : 0;
    return {
      revisionContentHash,
      revisionBodyBytes,
      revisionManifestByteLength,
    };
  };
  requestUrlState.impl = async (request): Promise<MockRequestUrlResponse> => {
    const value = request as { url: string; method: string; body?: unknown };
    const path = new URL(value.url).pathname;
    requests.push({ method: value.method, path, body: value.body });
    if (
      publishPreview &&
      value.method === "GET" &&
      path.includes("/revisions/revision-v3/attachments/") &&
      path.endsWith("/content")
    )
      return {
        status: 200,
        json: undefined,
        text: undefined,
        arrayBuffer: PNG.buffer.slice(
          PNG.byteOffset,
          PNG.byteOffset + PNG.byteLength,
        ),
        headers: {
          "content-length": String(PNG.byteLength),
        },
      };
    let json: unknown;
    if (path === "/api/integrations/obsidian/session")
      json = {
        protocolVersion: "1",
        serverInstanceId: connection.serverInstanceId,
        credentialId: connection.credentialId,
        deviceId: connection.deviceId,
        deviceName: "Test Device",
        vaultId: connection.vaultId,
        createdAt: "2026-09-06T00:00:00.000Z",
        lastUsedAt: "2026-09-06T00:00:00.000Z",
        credentialStatus: "active",
        provisionalExpiresAt: null,
        user: { id: "user-1", displayName: "User" },
        capabilities: V2_CAPABILITIES,
      };
    else if (path === "/api/sync/v3/capabilities") {
      if ((input.serverVersion ?? "3") !== "3")
        return {
          status: 404,
          json: { error: { code: "PROTOCOL_UNSUPPORTED" } },
          text: JSON.stringify({
            error: { code: "PROTOCOL_UNSUPPORTED" },
          }),
          arrayBuffer: new ArrayBuffer(0),
          headers: {},
        };
      json = {
        protocolVersion: "3",
        capabilities: V3_CAPABILITIES,
        capabilitiesHash: v3Hash,
      };
    } else if (path === "/api/sync/v2/capabilities") {
      if ((input.serverVersion ?? "3") === "1")
        return {
          status: 404,
          json: { error: { code: "PROTOCOL_UNSUPPORTED" } },
          text: JSON.stringify({
            error: { code: "PROTOCOL_UNSUPPORTED" },
          }),
          arrayBuffer: new ArrayBuffer(0),
          headers: {},
        };
      json = {
        protocolVersion: "2",
        capabilities: V2_CAPABILITIES,
        capabilitiesHash: v2Hash,
      };
    } else if (path === "/api/sync/v3/spaces")
      if (input.spacesStatus)
        return {
          status: input.spacesStatus,
          json: {
            protocolVersion: "3",
            error: {
              code: "SYNC_PROTOCOL_UPGRADE_REQUIRED",
              retryable:
                input.spacesStatus === 429 || input.spacesStatus === 500,
            },
          },
          text: JSON.stringify({
            protocolVersion: "3",
            error: {
              code: "SYNC_PROTOCOL_UPGRADE_REQUIRED",
              retryable:
                input.spacesStatus === 429 || input.spacesStatus === 500,
            },
          }),
          arrayBuffer: new ArrayBuffer(0),
          headers: {},
        };
      else
        json = {
          protocolVersion: "3",
          spaces: [
            {
              spaceId: "space-1",
              displayName: "Legacy Space",
              role: "owner",
              canRead: true,
              canPublish: true,
              syncMode,
              currentRevision: remoteRevision,
              folderCount: "0",
              pageCount: String(remotePages.length),
              attachmentCount: "0",
              revisionManifestByteLength: "0",
              revisionBodyBytes: "0",
              revisionAttachmentBytes: "0",
            },
          ],
        };
    else if (path === "/api/sync/v2/spaces/space-1/head") {
      const metrics = await remoteMetrics();
      json = {
        protocolVersion: "2",
        spaceId: "space-1",
        revision: remoteRevision,
        sequence: remoteRevision === "0" ? 0 : 1,
        revisionContentHash: metrics.revisionContentHash,
        folderCount: "0",
        pageCount: String(remotePages.length),
        revisionManifestByteLength: String(metrics.revisionManifestByteLength),
        revisionBodyBytes: String(metrics.revisionBodyBytes),
        publishedAt: null,
      };
    } else if (path === "/api/sync/v2/spaces/space-1/snapshot") {
      const metrics = await remoteMetrics();
      json = {
        protocolVersion: "2",
        spaceId: "space-1",
        revision: remoteRevision,
        sequence: remoteRevision === "0" ? 0 : 1,
        revisionContentHash: metrics.revisionContentHash,
        folderCount: "0",
        pageCount: String(remotePages.length),
        revisionManifestByteLength: String(metrics.revisionManifestByteLength),
        revisionBodyBytes: String(metrics.revisionBodyBytes),
        folders: [],
        pages: remotePages,
        nextCursor: null,
      };
    } else if (
      publishPreview &&
      value.method === "POST" &&
      path.endsWith("/push-sessions")
    )
      json = {
        protocolVersion: "3",
        sessionId,
        status: "uploading",
        expiresAt: "2099-01-01T00:00:00.000Z",
        missingContentHashes: publishPreview.candidate.attachments.map(
          (item) => item.contentHash,
        ),
      };
    else if (
      publishPreview &&
      value.method === "PUT" &&
      path.includes("/blobs/") &&
      path.includes("/chunks/")
    ) {
      const parts = path.split("/");
      const blobIndex = parts.indexOf("blobs");
      const contentHash = decodeURIComponent(parts[blobIndex + 1]!);
      const chunkIndex = Number(parts.at(-1));
      const body = new Uint8Array(value.body as ArrayBuffer);
      json = {
        contentHash,
        chunkIndex,
        chunkHash: await blobChunkHashV3(body),
        receipt: `chunk-${chunkIndex}`,
      };
    } else if (
      publishPreview &&
      value.method === "POST" &&
      path.endsWith("/complete")
    ) {
      const parts = path.split("/");
      const contentHash = decodeURIComponent(
        parts[parts.indexOf("blobs") + 1]!,
      );
      const attachment = publishPreview.candidate.attachments.find(
        (item) => item.contentHash === contentHash,
      );
      if (!attachment) throw new Error("missing attachment fixture");
      json = {
        contentHash: attachment.contentHash,
        sizeBytes: attachment.sizeBytes,
        mimeType: attachment.mimeType,
        width: attachment.width,
        height: attachment.height,
        verifiedAt: "2026-09-06T00:00:30.000Z",
      };
    } else if (
      publishPreview &&
      value.method === "PUT" &&
      path.includes("/batches/")
    ) {
      const body = JSON.parse(value.body as string) as {
        batchIndex: number;
        batchHash: string;
      };
      json = {
        protocolVersion: "3",
        sessionId,
        batchIndex: body.batchIndex,
        batchHash: body.batchHash,
        receipt: `batch-${body.batchIndex}`,
        receivedBatchCount: body.batchIndex + 1,
      };
    } else if (
      publishPreview &&
      value.method === "POST" &&
      path.endsWith("/finalize")
    ) {
      const bodyBytes = publishPreview.candidate.pages.reduce(
        (total, page) => total + new TextEncoder().encode(page.body).byteLength,
        0,
      );
      json = {
        protocolVersion: "3",
        status: "published",
        revision: "revision-v3",
        sequence: 1,
        revisionContentHash: publishPreview.candidateHash,
        folderCount: String(publishPreview.candidate.folders.length),
        pageCount: String(publishPreview.candidate.pages.length),
        attachmentCount: String(publishPreview.candidate.attachments.length),
        revisionManifestByteLength: String(
          canonicalBytes(publishPreview.candidate).byteLength,
        ),
        revisionBodyBytes: String(bodyBytes),
        revisionAttachmentBytes: String(
          publishPreview.candidate.attachments.reduce(
            (total, item) => total + Number(item.sizeBytes),
            0,
          ),
        ),
        publishedAt: "2026-09-06T00:01:00.000Z",
        changeSetId: null,
      };
      if (input.lateEditAfterFinalize)
        harness.adapter.files.set(
          "Wiki/pages/note.md",
          "late edit\n![](../assets/used.png)\n",
        );
    } else if (
      publishPreview &&
      value.method === "GET" &&
      path.endsWith("/snapshot")
    ) {
      const bodyBytes = publishPreview.candidate.pages.reduce(
        (total, page) => total + new TextEncoder().encode(page.body).byteLength,
        0,
      );
      json = {
        protocolVersion: "3",
        spaceId: "space-1",
        revision: "revision-v3",
        sequence: 1,
        revisionContentHash: publishPreview.candidateHash,
        folderCount: String(publishPreview.candidate.folders.length),
        pageCount: String(publishPreview.candidate.pages.length),
        attachmentCount: String(publishPreview.candidate.attachments.length),
        revisionManifestByteLength: String(
          canonicalBytes(publishPreview.candidate).byteLength,
        ),
        revisionBodyBytes: String(bodyBytes),
        revisionAttachmentBytes: String(
          publishPreview.candidate.attachments.reduce(
            (total, item) => total + Number(item.sizeBytes),
            0,
          ),
        ),
        folders: publishPreview.candidate.folders,
        pages: publishPreview.candidate.pages,
        attachments: publishPreview.candidate.attachments,
        nextCursor: null,
      };
    } else if (
      !publishPreview &&
      value.method === "POST" &&
      path === "/api/sync/v2/spaces/space-1/push-sessions"
    )
      json = {
        protocolVersion: "2",
        sessionId,
        status: "uploading",
        expiresAt: "2099-01-01T00:00:00.000Z",
        result: null,
      };
    else if (
      !publishPreview &&
      value.method === "PUT" &&
      path.includes("/api/sync/v2/spaces/space-1/push-sessions/") &&
      path.includes("/batches/")
    ) {
      const batch = JSON.parse(value.body as string) as {
        batchIndex: number;
        batchHash: string;
        changes: typeof uploadedV2Changes;
      };
      uploadedV2Changes = structuredClone(batch.changes);
      json = {
        protocolVersion: "2",
        sessionId,
        batchIndex: batch.batchIndex,
        batchHash: batch.batchHash,
        receipt: `v2-batch-${batch.batchIndex}`,
        receivedBatchCount: batch.batchIndex + 1,
      };
    } else if (
      !publishPreview &&
      value.method === "POST" &&
      path === `/api/sync/v2/spaces/space-1/push-sessions/${sessionId}/finalize`
    ) {
      for (const change of uploadedV2Changes)
        if (change.operation === "upsert_page" && change.page)
          remotePages = [structuredClone(change.page)];
      remoteRevision = "text-published";
      const metrics = await remoteMetrics();
      json = {
        protocolVersion: "2",
        status: "published",
        revision: remoteRevision,
        sequence: 2,
        publishedAt: "2026-09-06T00:02:00.000Z",
        revisionContentHash: metrics.revisionContentHash,
        folderCount: "0",
        pageCount: String(remotePages.length),
        revisionManifestByteLength: String(metrics.revisionManifestByteLength),
        revisionBodyBytes: String(metrics.revisionBodyBytes),
        changeSetId: null,
      };
    } else throw new Error(`unexpected ${value.method} ${path}`);
    return {
      status: 200,
      json,
      text: JSON.stringify(json),
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
    };
  };
  return {
    ...harness,
    connection,
    requests,
    setPublishPreview: (preview: UpgradePreview) => {
      publishPreview = structuredClone(preview);
    },
    setSyncMode: (value: "legacy_v2" | "bootstrap_required" | "native_v3") => {
      syncMode = value;
    },
    remotePages: () => structuredClone(remotePages),
  };
}

async function seedConfirmedUpgradeInPlugin(
  harness: Awaited<ReturnType<typeof pluginUpgradeHarness>>,
): Promise<void> {
  const subject = harness.plugin as unknown as {
    runtime: (mapping: SpaceMapping) => Promise<object>;
    runtimeRoutes: WeakMap<object, { upgrade: LocalImageUpgradeEntry | null }>;
  };
  const mapping = harness.plugin.settings.mappings[0]!;
  const runtime = await subject.runtime(mapping);
  const entry = subject.runtimeRoutes.get(runtime)?.upgrade;
  if (!entry) throw new Error("expected upgrade entry");
  const draft = await entry.prepare();
  if (draft.kind !== "upgrade_draft") throw new Error("expected draft");
  const preview = await entry.finalizePreview(draft);
  const deviceKey = await idFileKey(harness.connection.deviceId);
  const spaceKey = await idFileKey(mapping.spaceId);
  const root = `.agentwiki/devices/d-${deviceKey}/spaces/s-${spaceKey}`;
  const previewPath = `${root}/local-image-upgrade/${preview.binding.operationId}/payload/confirmed-preview.json`;
  const intent: UpgradeIntent = {
    schemaVersion: 1,
    binding: structuredClone(preview.binding),
    sourceRevision: preview.remoteBase.sourceRevision,
    sourceV2RevisionHash: preview.remoteBase.sourceV2RevisionHash,
    oldBaselineEvidenceHash: preview.oldBaselineEvidenceHash,
    projectedV3BaseHash: preview.remoteBase.projectedV3BaseHash,
    capabilitiesHash: preview.push.capabilitiesHash,
    confirmationHash: preview.push.confirmationHash,
    candidateHash: preview.candidateHash,
    localPlanHash: preview.localPlanHash,
    authorizationHash: preview.authorizationHash,
    payloadPaths: [
      ...preview.push.changes.flatMap((change) =>
        change.operation === "upsert_page" ? [change.page.payloadPath] : [],
      ),
      previewPath,
    ].sort(),
    pushOperationId: preview.binding.operationId,
    localTransactionId: "99999999-9999-4999-8999-999999999999",
    phase: "confirmed",
    verifiedPublication: null,
  };
  const store = new ObsidianControlStore(harness.app.vault.adapter as never);
  await new ConfirmedUpgradePreviewRepository(store, root).persist(
    intent,
    preview,
  );
  await new LocalImageUpgradeRepository(store, root, intent.binding).write(
    intent,
  );
}

async function confirmedPreviewFixture(): Promise<{
  store: MemoryControlStore;
  repository: ConfirmedUpgradePreviewRepository;
  preview: UpgradePreview;
  intent: UpgradeIntent;
  previewPath: string;
}> {
  const store = new MemoryControlStore();
  const vault = new MemoryVault({});
  const body = "note\n![](../assets/used.png)\n";
  vault.seedMarkdown("Wiki/pages/note.md", body);
  vault.seedFile("Wiki/assets/used.png", PNG);
  const remote = await projectLegacyBase({
    protocolVersion: "2",
    spaceId: "space-1",
    revision: "0",
    revisionContentHash: EMPTY_HASH,
    folders: [],
    pages: [],
  });
  const identities = emptyTreeIdentityStateV2();
  const local = await scanLocalTree(
    vault,
    "Wiki",
    remote.projected,
    identities,
    {
      ...V3_CAPABILITIES,
      maxFolders: V3_CAPABILITIES.maxClientSpaceFolders,
      maxPages: V3_CAPABILITIES.maxClientSpacePages,
    },
  );
  const capabilitiesHash = await treeCapabilitiesHashV3(V3_CAPABILITIES);
  const preview = await prepareLegacyUpgradePreview({
    binding: {
      operationId: OPERATION_ID,
      serverInstanceId: "server-1",
      spaceId: "space-1",
      deviceId: "device-1",
      credentialId: "credential-1",
      mappingRootKey: "Wiki",
    },
    base: remote,
    remote,
    local,
    identities,
    scanEpoch: 1,
    oldBaselineEvidenceHash: await treeRevisionContentHashV2({
      protocolVersion: "2",
      spaceId: "space-1",
      folders: [],
      pages: [],
    }),
    capabilities: V3_CAPABILITIES,
    capabilitiesHash,
    control: store,
    controlRoot: CONTROL_ROOT,
  });
  const previewPath = `${CONTROL_ROOT}/local-image-upgrade/${OPERATION_ID}/payload/confirmed-preview.json`;
  const intent: UpgradeIntent = {
    schemaVersion: 1,
    binding: structuredClone(preview.binding),
    sourceRevision: preview.remoteBase.sourceRevision,
    sourceV2RevisionHash: preview.remoteBase.sourceV2RevisionHash,
    oldBaselineEvidenceHash: preview.oldBaselineEvidenceHash,
    projectedV3BaseHash: preview.remoteBase.projectedV3BaseHash,
    capabilitiesHash: preview.push.capabilitiesHash,
    confirmationHash: preview.push.confirmationHash,
    candidateHash: preview.candidateHash,
    localPlanHash: preview.localPlanHash,
    authorizationHash: preview.authorizationHash,
    payloadPaths: [
      ...preview.push.changes.flatMap((change) =>
        change.operation === "upsert_page" ? [change.page.payloadPath] : [],
      ),
      previewPath,
    ].sort(),
    pushOperationId: OPERATION_ID,
    localTransactionId: "local-transaction-1",
    phase: "confirmed",
    verifiedPublication: null,
  };
  return {
    store,
    repository: new ConfirmedUpgradePreviewRepository(store, CONTROL_ROOT),
    preview,
    intent,
    previewPath,
  };
}

describe("local image upgrade plugin entry", () => {
  beforeEach(() => {
    noticeMessages().length = 0;
  });
  it.each([
    [
      "pending recovery wins",
      "3",
      "native_v3",
      "3",
      true,
      false,
      false,
      "recover_upgrade",
    ],
    [
      "native v3 stays native without images",
      "3",
      "native_v3",
      "1",
      false,
      false,
      false,
      "native_v3",
    ],
    [
      "v3 bootstrap routes before head or delta",
      "3",
      "bootstrap_required",
      "1",
      false,
      false,
      false,
      "bootstrap",
    ],
    [
      "legacy text stays on v2",
      "3",
      "legacy_v2",
      "1",
      false,
      false,
      false,
      "legacy",
    ],
    [
      "legacy local image upgrades",
      "3",
      "legacy_v2",
      "2",
      false,
      true,
      false,
      "upgrade",
    ],
    [
      "old text server stays legacy",
      "2",
      null,
      "1",
      false,
      false,
      false,
      "legacy",
    ],
  ] as const)(
    "%s",
    (
      _name,
      serverVersion,
      syncMode,
      requiredVersion,
      pendingUpgrade,
      localImageCandidate,
      remoteImageCandidate,
      expected,
    ) => {
      expect(
        selectSpaceSyncRoute({
          serverVersion,
          syncMode,
          requiredVersion,
          pendingUpgrade,
          localImageCandidate,
          remoteImageCandidate,
        }),
      ).toBe(expected);
    },
  );

  it.each([
    [
      "old server with local image",
      "2",
      null,
      "1",
      true,
      false,
      "SYNC_PROTOCOL_UPGRADE_REQUIRED",
    ],
    [
      "old server with remote image",
      "1",
      null,
      "1",
      false,
      true,
      "SYNC_PROTOCOL_UPGRADE_REQUIRED",
    ],
    [
      "v3 baseline reported as legacy",
      "3",
      "legacy_v2",
      "3",
      false,
      false,
      "SPACE_PROTOCOL_INCONSISTENT",
    ],
    ["unknown mode", "3", null, "1", false, false, "SPACE_MODE_INVALID"],
    [
      "remote image under stale legacy mode",
      "3",
      "legacy_v2",
      "1",
      false,
      true,
      "SPACE_MODE_REFRESH_REQUIRED",
    ],
  ] as const)(
    "fails closed for %s",
    (
      _name,
      serverVersion,
      syncMode,
      requiredVersion,
      localImageCandidate,
      remoteImageCandidate,
      code,
    ) => {
      expect(() =>
        selectSpaceSyncRoute({
          serverVersion,
          syncMode,
          requiredVersion,
          pendingUpgrade: false,
          localImageCandidate,
          remoteImageCandidate,
        }),
      ).toThrow(code);
    },
  );

  it("preserves strict v3 Space mode and permission through the real plugin discovery entry", async () => {
    const connection: ConnectionState = {
      schemaVersion: 1,
      serverUrl: "https://wiki.example.com",
      serverInstanceId: "server-1",
      credentialId: "credential-1",
      credentialSecretId: "secret-1",
      deviceId: "11111111-1111-4111-8111-111111111111",
      vaultId: "22222222-2222-4222-8222-222222222222",
    };
    const harness = await makePlugin({
      data: {
        schemaVersion: 2,
        serverUrl: connection.serverUrl,
        mappings: [],
      },
      connection,
    });
    await harness.plugin.onload();
    const capabilitiesHash = await treeCapabilitiesHashV3(V3_CAPABILITIES);
    requestUrlState.impl = async (request) => {
      const path = new URL((request as { url: string }).url).pathname;
      if (path === "/api/sync/v3/capabilities")
        return {
          status: 200,
          json: {
            protocolVersion: "3",
            capabilities: V3_CAPABILITIES,
            capabilitiesHash,
          },
          headers: {},
        };
      if (path === "/api/sync/v3/spaces")
        return {
          status: 200,
          json: {
            protocolVersion: "3",
            spaces: [
              {
                spaceId: "space-1",
                displayName: "Legacy Space",
                role: "viewer",
                canRead: true,
                canPublish: false,
                syncMode: "legacy_v2",
                currentRevision: "revision-1",
                folderCount: "0",
                pageCount: "0",
                attachmentCount: "0",
                revisionManifestByteLength: "0",
                revisionBodyBytes: "0",
                revisionAttachmentBytes: "0",
              },
            ],
          },
          headers: {},
        };
      throw new Error(`unexpected ${path}`);
    };

    await expect(harness.plugin.listAccessibleSpaces()).resolves.toMatchObject([
      { spaceId: "space-1", syncMode: "legacy_v2", canPublish: false },
    ]);
  });

  it.each(["1", "2"] as const)(
    "blocks an actual old v%s factory before head when local Markdown references an image",
    async (serverVersion) => {
      const harness = await pluginUpgradeHarness({ serverVersion });
      const subject = harness.plugin as unknown as {
        runtime: (mapping: SpaceMapping) => Promise<unknown>;
      };

      await expect(
        subject.runtime(harness.plugin.settings.mappings[0]!),
      ).rejects.toThrow("SYNC_PROTOCOL_UPGRADE_REQUIRED");
      expect(
        harness.requests.some(
          (request) =>
            request.path.includes("/head") ||
            request.path.includes("/snapshot") ||
            request.path.includes("/delta"),
        ),
      ).toBe(false);
    },
  );

  it("blocks an actual old v2 remote Markdown image through the factory runtime", async () => {
    const harness = await pluginUpgradeHarness({
      serverVersion: "2",
      includeLocalImage: false,
      remoteBody: "remote\n![](../assets/remote.png)\n",
    });
    const subject = harness.plugin as unknown as {
      runtime: (mapping: SpaceMapping) => Promise<SyncRuntime>;
    };
    const runtime = await subject.runtime(harness.plugin.settings.mappings[0]!);

    await expect(runtime.previewPull()).rejects.toThrow(
      "SYNC_PROTOCOL_UPGRADE_REQUIRED",
    );
    expect(harness.businessWrites).toEqual([]);
    expect(harness.requests.every((request) => request.method === "GET")).toBe(
      true,
    );
  });

  it("constructs the actual strict v2 adapter for a legacy Space without local images", async () => {
    const harness = await pluginUpgradeHarness({ includeLocalImage: false });
    const subject = harness.plugin as unknown as {
      runtime: (
        mapping: SpaceMapping,
      ) => Promise<{ protocolVersion: "1" | "2" | "3" }>;
    };

    await expect(
      subject.runtime(harness.plugin.settings.mappings[0]!),
    ).resolves.toMatchObject({ protocolVersion: "2" });
    expect(
      harness.requests.some((request) =>
        request.path.includes("/api/sync/v2/capabilities"),
      ),
    ).toBe(true);
    expect(
      harness.requests.some(
        (request) =>
          request.path.includes("/head") || request.path.includes("/delta"),
      ),
    ).toBe(false);
  });

  it("constructs the actual strict v3 adapter for a native Space with zero attachments", async () => {
    const harness = await pluginUpgradeHarness({
      syncMode: "native_v3",
      includeLocalImage: false,
    });
    const subject = harness.plugin as unknown as {
      runtime: (
        mapping: SpaceMapping,
      ) => Promise<{ protocolVersion: "1" | "2" | "3" }>;
    };

    await expect(
      subject.runtime(harness.plugin.settings.mappings[0]!),
    ).resolves.toMatchObject({ protocolVersion: "3" });
    expect(
      harness.requests.some((request) =>
        request.path.includes("/api/sync/v2/"),
      ),
    ).toBe(false);
    expect(
      harness.requests.some(
        (request) =>
          request.path.includes("/head") || request.path.includes("/delta"),
      ),
    ).toBe(false);
  });

  it("rejects a confirmed preview whose stored merge materialization no longer matches its fixed decisions", async () => {
    const fixture = await confirmedPreviewFixture();
    await fixture.repository.persist(fixture.intent, fixture.preview);
    const stored = JSON.parse(
      (await fixture.store.read(fixture.previewPath))!,
    ) as UpgradePreview;
    stored.merge.resolvedPages[0] = {
      ...stored.merge.resolvedPages[0]!,
      body: "tampered merge body\n",
      contentHash: await contentHash("tampered merge body\n"),
    };
    await fixture.store.write(fixture.previewPath, JSON.stringify(stored));

    await expect(fixture.repository.load(fixture.intent)).rejects.toThrow(
      "UPGRADE_PREVIEW_MATERIALIZATION_MISMATCH",
    );
  });

  it("prepares a no-baseline local-image draft from fresh public v2/v3 authority without writes", async () => {
    const { entry, http, store, vault } = await makeUpgradeEntryFixture();

    await expect(entry.prepare()).resolves.toMatchObject({
      kind: "upgrade_draft",
      fixed: {
        base: { sourceRevision: "0", projected: { attachments: [] } },
        remote: { sourceRevision: "0" },
        rawLocal: {
          pages: [expect.objectContaining({ path: "pages/note.md" })],
          attachments: [expect.objectContaining({ path: "assets/used.png" })],
        },
      },
    });
    expect(http.calls.every((call) => call.method === "GET")).toBe(true);
    expect(vault.operationLog).toEqual([]);
    expect(store.files.size).toBe(0);
  });

  it("allows a viewer to inspect an upgrade draft but not confirm it", async () => {
    const { entry, http } = await makeUpgradeEntryFixture({
      canPublish: false,
    });

    const draft = await entry.prepare();
    expect(draft.kind).toBe("upgrade_draft");
    if (draft.kind !== "upgrade_draft") throw new Error("expected draft");
    const preview = await entry.finalizePreview(draft);

    await expect(
      entry.confirm(preview, preview.authorizationHash),
    ).rejects.toThrow("SPACE_READ_ONLY");
    expect(http.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("binds the fresh v2 capability hash into confirmation revalidation", async () => {
    const { entry, http } = await makeUpgradeEntryFixture();
    const draft = await entry.prepare();
    if (draft.kind !== "upgrade_draft") throw new Error("expected draft");
    const preview = await entry.finalizePreview(draft);
    const changed = { ...V2_CAPABILITIES, maxPageItems: 199 };
    http.route("GET", "/api/sync/v2/capabilities", {
      status: 200,
      json: {
        protocolVersion: "2",
        capabilities: changed,
        capabilitiesHash: await capabilitiesHash(changed),
      },
    });

    await expect(
      entry.confirm(preview, preview.authorizationHash),
    ).rejects.toThrow("STALE_UPGRADE_PREVIEW");
    expect(http.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("rebuilds an all-images-cancelled draft as a strict text sync preview without writes", async () => {
    const { entry, http, store, vault } = await makeUpgradeEntryFixture({
      remoteBody: "server text only\n",
    });
    const required = await entry.prepare();
    expect(required.kind).toBe("initial_binding_required");
    if (required.kind !== "initial_binding_required")
      throw new Error("expected initial binding");
    const draft = await entry.resolveInitialBindings(
      required,
      required.requirements.map((item) => ({
        kind: item.kind,
        localId: item.localId,
        remoteId: item.remoteId,
      })),
    );
    const pageConflict = draft.merge.pageConflicts[0];
    if (!pageConflict) throw new Error("expected page conflict");
    await resolvePageConflictV3(draft.merge, pageConflict.conflictId, {
      choice: "remote",
    });
    const recomputed = await entry.recompute(draft);
    expect(recomputed.kind).toBe("text_preview_required");
    if (recomputed.kind !== "text_preview_required")
      throw new Error("expected text preview requirement");

    const preview = await entry.prepareTextSyncPreview(recomputed);

    expect(preview).toMatchObject({
      kind: "text_sync_preview",
      pull: {
        revision: "remote-text",
        resolvedPages: [
          expect.objectContaining({
            pageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            body: "server text only\n",
          }),
        ],
      },
      candidate: {
        protocolVersion: "2",
        spaceId: "space-1",
        pages: [expect.objectContaining({ body: "server text only\n" })],
      },
    });
    expect(preview.draft.merge.resolvedAttachments).toEqual([]);
    expect(http.calls.every((call) => call.method === "GET")).toBe(true);
    expect(vault.operationLog).toEqual([]);
    expect(store.files.size).toBe(0);
  });

  it("fails before scanning when the mapped Vault root is missing", async () => {
    const { entry, vault } = await makeUpgradeEntryFixture({
      rootStatus: "missing",
    });

    await expect(entry.prepare()).rejects.toThrow("MAPPING_ROOT_MISSING");
    expect(vault.readPaths).toEqual([]);
  });

  it("routes the real plugin strategy to one upgrade preview before any remote or Vault write", async () => {
    const harness = await pluginUpgradeHarness();
    const subject = harness.plugin as unknown as {
      runSyncStrategy: (
        spaceId: string,
        strategy: "auto",
        options: unknown,
      ) => Promise<ModalTransition | void>;
    };
    let opened: PreviewModal | null = null;
    const open = vi
      .spyOn(PreviewModal.prototype, "open")
      .mockImplementation(function (this: PreviewModal) {
        this.onOpen();
      });

    const transition = await subject.runSyncStrategy("space-1", "auto", {});
    transition?.();
    opened = open.mock.instances.at(-1) ?? null;

    const content = (opened as unknown as { contentEl: MockElement }).contentEl;
    expect(content.textContent).toContain("Sync v2 → Sync v3");
    expect(content.textContent).toContain("assets/used.png");
    expect(
      content.queryAll(
        (item) => item.tag === "button" && item.text === "确认升级并同步",
      ),
    ).toHaveLength(1);
    expect(
      harness.requests.filter((request) => request.method !== "GET"),
    ).toEqual([]);
    expect(harness.businessWrites).toEqual([]);
    open.mockRestore();
  });

  it("disables the real upgrade confirmation when a Vault event invalidates its draft", async () => {
    const harness = await pluginUpgradeHarness();
    const subject = harness.plugin as unknown as {
      runSyncStrategy: (
        spaceId: string,
        strategy: "auto",
        options: unknown,
      ) => Promise<ModalTransition | void>;
    };
    const open = vi
      .spyOn(PreviewModal.prototype, "open")
      .mockImplementation(function (this: PreviewModal) {
        this.onOpen();
      });

    const transition = await subject.runSyncStrategy("space-1", "auto", {});
    transition?.();
    const modal = open.mock.instances.at(-1) as unknown as PreviewModal;
    const button = modalButton(modal, "确认升级并同步");
    expect(button.disabled).toBe(false);

    harness.emitVault("modify");

    expect(modalButton(modal, "确认升级并同步").disabled).toBe(true);
    expect(modal.contentEl.textContent).toContain("预览已失效");
    open.mockRestore();
  });

  it("uses the same upgrade route for real sync-center diff loading without legacy status writes", async () => {
    const harness = await pluginUpgradeHarness();
    const subject = harness.plugin as unknown as {
      collectSyncDiff: (
        spaceId: string,
        options: unknown,
      ) => Promise<{
        protocolLabel: string;
        attachmentChanges: { uploads: number; items: Array<{ path: string }> };
      }>;
    };

    const diff = await subject.collectSyncDiff("space-1", {});

    expect(diff.protocolLabel).toBe("Sync v2 → Sync v3");
    expect(diff.attachmentChanges).toMatchObject({
      uploads: 1,
      items: [expect.objectContaining({ path: "assets/used.png" })],
    });
    expect(harness.requests.every((request) => request.method === "GET")).toBe(
      true,
    );
    expect(harness.businessWrites).toEqual([]);
  });

  it("loads a real bootstrap sync-center route without requesting head or delta", async () => {
    const harness = await pluginUpgradeHarness({
      syncMode: "bootstrap_required",
    });
    const subject = harness.plugin as unknown as {
      collectSyncDiff: (
        spaceId: string,
        options: unknown,
      ) => Promise<{ protocolLabel: string }>;
    };

    await expect(subject.collectSyncDiff("space-1", {})).resolves.toMatchObject(
      { protocolLabel: "Sync v3" },
    );
    expect(
      harness.requests.some(
        (request) =>
          request.path.includes("/head") ||
          request.path.includes("/delta") ||
          request.path.includes("/api/sync/v2/"),
      ),
    ).toBe(false);
  });

  it.each([401, 403, 409, 429, 500] as const)(
    "does not downgrade an actual strict v3 Space failure with status %s",
    async (spacesStatus) => {
      const harness = await pluginUpgradeHarness({ spacesStatus });
      const subject = harness.plugin as unknown as {
        collectSyncDiff: (
          spaceId: string,
          options: unknown,
        ) => Promise<unknown>;
      };

      await expect(subject.collectSyncDiff("space-1", {})).rejects.toThrow();
      expect(
        harness.requests.some((request) =>
          request.path.includes("/api/sync/v2/"),
        ),
      ).toBe(false);
    },
  );

  it("rejects an unknown public Space mode before any v2 fallback", async () => {
    const harness = await pluginUpgradeHarness({
      syncMode: "future_mode" as never,
    });
    const subject = harness.plugin as unknown as {
      collectSyncDiff: (spaceId: string, options: unknown) => Promise<unknown>;
    };

    await expect(subject.collectSyncDiff("space-1", {})).rejects.toThrow();
    expect(
      harness.requests.some((request) =>
        request.path.includes("/api/sync/v2/"),
      ),
    ).toBe(false);
  });

  it("reports an unfinished persisted upgrade without performing recovery writes while loading a diff", async () => {
    const harness = await pluginUpgradeHarness();
    await seedConfirmedUpgradeInPlugin(harness);
    harness.requests.length = 0;
    const restarted = new AgentWikiSyncPlugin(
      harness.app as never,
      harness.plugin.manifest,
    );
    await restarted.onload();
    const subject = restarted as unknown as {
      collectSyncDiff: (
        spaceId: string,
        options: unknown,
      ) => Promise<{ protocolLabel: string; recoveryPending?: boolean }>;
    };

    await expect(subject.collectSyncDiff("space-1", {})).resolves.toMatchObject(
      {
        protocolLabel: "Sync v2 → Sync v3",
        recoveryPending: true,
      },
    );
    expect(
      harness.requests.filter((request) => request.method !== "GET"),
    ).toEqual([]);
    expect(harness.businessWrites).toEqual([]);
  });

  it("blocks mapping removal and disconnect while an image upgrade is unfinished", async () => {
    const harness = await pluginUpgradeHarness();
    await seedConfirmedUpgradeInPlugin(harness);
    harness.requests.length = 0;
    const restarted = new AgentWikiSyncPlugin(
      harness.app as never,
      harness.plugin.manifest,
    );
    await restarted.onload();

    await expect(restarted.removeMapping("space-1")).rejects.toThrow(
      /未完成的图片同步升级/u,
    );
    await expect(restarted.disconnect()).rejects.toThrow(
      /未完成的图片同步升级/u,
    );
    expect(restarted.settings.mappings).toHaveLength(1);
    expect(
      harness.requests.filter((request) => request.method !== "GET"),
    ).toEqual([]);
  });

  it("publishes and commits the upgrade through exactly one real modal confirmation", async () => {
    const harness = await pluginUpgradeHarness();
    const subject = harness.plugin as unknown as {
      runSyncStrategy: (
        spaceId: string,
        strategy: "auto",
        options: unknown,
      ) => Promise<ModalTransition | void>;
    };
    const originalConfirm = originalUpgradeConfirm();
    let confirmation: Promise<void> | null = null;
    const confirm = vi
      .spyOn(LocalImageUpgradeEntry.prototype, "confirm")
      .mockImplementation(function (
        this: LocalImageUpgradeEntry,
        preview,
        authorizationHash,
        options,
      ) {
        harness.setPublishPreview(preview);
        confirmation = originalConfirm.call(
          this,
          preview,
          authorizationHash,
          options,
        );
        return confirmation;
      });
    const open = vi
      .spyOn(PreviewModal.prototype, "open")
      .mockImplementation(function (this: PreviewModal) {
        this.onOpen();
      });

    const transition = await subject.runSyncStrategy("space-1", "auto", {});
    transition?.();
    const opened = open.mock.instances.at(-1)!;
    expect(
      harness.requests.filter((request) => request.method !== "GET"),
    ).toEqual([]);
    expect(harness.businessWrites).toEqual([]);

    const button = modalButton(opened, "确认升级并同步");
    button.dispatchEvent({ type: "click" });

    await vi.waitFor(() => expect(confirmation).not.toBeNull());
    await Promise.resolve(confirmation);
    await vi.waitFor(() => {
      expect(
        harness.requests.filter((request) =>
          request.path.endsWith("/finalize"),
        ),
      ).toHaveLength(1);
    });
    await vi.waitFor(() => {
      expect(
        [...harness.adapter.files.keys()].some((path) =>
          path.endsWith("/tree-v2/current.json"),
        ),
      ).toBe(true);
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(
      harness.requests.filter(
        (request) =>
          request.method === "POST" && request.path.endsWith("/push-sessions"),
      ),
    ).toHaveLength(1);
    expect(
      harness.requests.some((request) => request.path.includes("/chunks/")),
    ).toBe(true);
    expect(
      harness.requests.some((request) => request.path.includes("/batches/")),
    ).toBe(true);
    expect(button.disabled).toBe(true);

    harness.setSyncMode("legacy_v2");
    harness.requests.length = 0;
    const restarted = new AgentWikiSyncPlugin(
      harness.app as never,
      harness.plugin.manifest,
    );
    await restarted.onload();
    const restartedSubject = restarted as unknown as {
      runtime: (mapping: SpaceMapping) => Promise<{ protocolVersion: string }>;
    };
    await expect(
      restartedSubject.runtime(restarted.settings.mappings[0]!),
    ).rejects.toThrow("SPACE_PROTOCOL_INCONSISTENT");
    expect(
      harness.requests.some(
        (request) =>
          request.path.includes("/head") || request.path.includes("/delta"),
      ),
    ).toBe(false);

    harness.setSyncMode("native_v3");
    harness.requests.length = 0;
    await expect(
      restartedSubject.runtime(restarted.settings.mappings[0]!),
    ).resolves.toMatchObject({ protocolVersion: "3" });
    expect(
      harness.requests.some(
        (request) =>
          request.path.includes("/api/sync/v2/") ||
          request.path.includes("/head") ||
          request.path.includes("/delta"),
      ),
    ).toBe(false);
    confirm.mockRestore();
    open.mockRestore();
  });

  it("returns an all-images-cancelled upgrade to confirmed v2 text Pull and Push while retaining the image file", async () => {
    const harness = await pluginUpgradeHarness({
      remoteBody: "server text only\n",
    });
    const subject = harness.plugin as unknown as {
      runSyncStrategy: (
        spaceId: string,
        strategy: "auto",
        options: unknown,
      ) => Promise<ModalTransition | void>;
    };
    const open = vi
      .spyOn(PreviewModal.prototype, "open")
      .mockImplementation(function (this: PreviewModal) {
        this.onOpen();
      });

    const transition = await subject.runSyncStrategy("space-1", "auto", {});
    transition?.();
    const binding = open.mock.instances.at(-1) as unknown as PreviewModal;
    modalButton(binding, "应用身份绑定并继续").dispatchEvent({ type: "click" });
    await vi.waitFor(() => expect(open.mock.instances.length).toBe(2));

    const upgrade = open.mock.instances.at(-1) as unknown as PreviewModal;
    const upgradeContent = upgrade.contentEl as unknown as MockElement;
    const conflict = upgradeContent.queryAll((item) =>
      item.classes.has("agentwiki-sync-conflict-setting"),
    )[0]!;
    const mode = conflict.queryAll((item) => item.tag === "select")[0]!;
    const manual = conflict.queryAll((item) => item.tag === "textarea")[0]!;
    mode.value = "manual";
    mode.dispatchEvent({ type: "change" });
    manual.value = "chosen text only\n";
    manual.dispatchEvent({ type: "change" });
    const applyManual = conflict.queryAll(
      (item) => item.tag === "button" && item.text === "应用手动内容",
    )[0]!;
    applyManual.dispatchEvent({ type: "click" });
    await vi.waitFor(() =>
      expect(modalButton(upgrade, "确认升级并同步").disabled).toBe(false),
    );
    modalButton(upgrade, "确认升级并同步").dispatchEvent({ type: "click" });

    await vi.waitFor(() => expect(open.mock.instances.length).toBe(3));
    const textPull = open.mock.instances.at(-1) as unknown as PreviewModal;
    expect(textPull.contentEl.textContent).toContain("Sync v2 文字合并");
    expect(harness.businessWrites).toEqual([]);
    expect(
      harness.requests.filter((request) => request.method !== "GET"),
    ).toEqual([]);

    modalButton(textPull, "确认文字合并").dispatchEvent({ type: "click" });
    await vi.waitFor(() => expect(open.mock.instances.length).toBe(4));
    const push = open.mock.instances.at(-1) as unknown as PreviewModal;
    expect(push.contentEl.textContent).toContain("Sync v2 推送预览");
    expect(
      new TextDecoder().decode(
        harness.adapter.bytes("Wiki/pages/note.md") ?? new Uint8Array(),
      ),
    ).toBe("chosen text only\n");
    expect(harness.adapter.binaryFiles.get("Wiki/assets/used.png")).toEqual(
      PNG,
    );

    modalButton(push, "确认执行").dispatchEvent({ type: "click" });
    await vi.waitFor(() =>
      expect(
        harness.requests.filter(
          (request) =>
            request.method === "POST" &&
            request.path.includes("/api/sync/v2/") &&
            request.path.endsWith("/finalize"),
        ),
      ).toHaveLength(1),
    );
    await vi.waitFor(() =>
      expect(harness.remotePages()[0]?.body).toBe("chosen text only\n"),
    );
    expect(
      harness.requests.some(
        (request) =>
          request.path.includes("/api/sync/v3/") && request.method !== "GET",
      ),
    ).toBe(false);
    expect(harness.adapter.binaryFiles.get("Wiki/assets/used.png")).toEqual(
      PNG,
    );
    open.mockRestore();
  });

  it("surfaces late local application as recoverable after publish without a second finalize", async () => {
    const harness = await pluginUpgradeHarness({ lateEditAfterFinalize: true });
    const subject = harness.plugin as unknown as {
      runSyncStrategy: (
        spaceId: string,
        strategy: "auto",
        options: unknown,
      ) => Promise<ModalTransition | void>;
    };
    const originalConfirm = originalUpgradeConfirm();
    let confirmation: Promise<void> | null = null;
    const confirm = vi
      .spyOn(LocalImageUpgradeEntry.prototype, "confirm")
      .mockImplementation(function (
        this: LocalImageUpgradeEntry,
        preview,
        authorizationHash,
        options,
      ) {
        harness.setPublishPreview(preview);
        confirmation = originalConfirm.call(
          this,
          preview,
          authorizationHash,
          options,
        );
        return confirmation;
      });
    const previewOpen = vi
      .spyOn(PreviewModal.prototype, "open")
      .mockImplementation(function (this: PreviewModal) {
        this.onOpen();
      });
    const transition = await subject.runSyncStrategy("space-1", "auto", {});
    transition?.();
    modalButton(
      previewOpen.mock.instances.at(-1)!,
      "确认升级并同步",
    ).dispatchEvent({ type: "click" });
    await vi.waitFor(() => expect(confirmation).not.toBeNull());
    await expect(confirmation).rejects.toThrow(
      "UPGRADE_REMOTE_PUBLISHED_LOCAL_PENDING",
    );
    await vi.waitFor(() =>
      expect(noticeMessages().join("\n")).toContain("恢复已确认升级"),
    );
    expect(harness.adapter.files.get("Wiki/pages/note.md")).toContain(
      "late edit",
    );
    const finalizeCount = () =>
      harness.requests.filter((request) => request.path.endsWith("/finalize"))
        .length;
    expect(finalizeCount()).toBe(1);

    const restarted = new AgentWikiSyncPlugin(
      harness.app as never,
      harness.plugin.manifest,
    );
    await restarted.onload();
    const centerOpen = vi
      .spyOn(SyncCenterModal.prototype, "open")
      .mockImplementation(function (this: SyncCenterModal) {
        this.onOpen();
      });
    (restarted as unknown as { openSyncCenter: () => void }).openSyncCenter();
    const center = centerOpen.mock.instances.at(-1)!;
    await vi.waitFor(() =>
      expect(modalButton(center, "恢复已确认升级")).toBeTruthy(),
    );
    noticeMessages().length = 0;
    modalButton(center, "恢复已确认升级").dispatchEvent({
      type: "click",
    });
    await vi.waitFor(() =>
      expect(noticeMessages().join("\n")).toContain("恢复已确认升级"),
    );
    expect(harness.adapter.files.get("Wiki/pages/note.md")).toContain(
      "late edit",
    );
    expect(finalizeCount()).toBe(1);
    centerOpen.mockRestore();
    previewOpen.mockRestore();
    confirm.mockRestore();
  });
});
