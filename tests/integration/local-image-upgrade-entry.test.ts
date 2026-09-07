import {
  blobChunkHashV3,
  canonicalBytes,
  canonicalTreeRevisionManifestV2,
  treeCapabilitiesHashV3,
  treeRevisionContentHashV2,
} from "@neomei/agentwiki-sync-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Notice } from "obsidian";

import {
  capabilitiesHash,
  contentHash,
  sha256Hex,
} from "../../src/agentwiki/protocol";
import { AgentWikiClient } from "../../src/agentwiki/client";
import { AgentWikiPushRemote } from "../../src/agentwiki/push-remote";
import { PushService } from "../../src/application/push-service";
import { LocalImageUpgradeEntry } from "../../src/application/local-image-upgrade-entry";
import { ProtocolNegotiator } from "../../src/application/protocol-negotiator";
import type { SyncRuntime } from "../../src/application/sync-runtime";
import { resolvePageConflictV3 } from "../../src/application/tree-diff";
import {
  prepareLegacyUpgradePreview,
  hashUpgradeLocalPlan,
  hashUpgradeAuthorization,
  projectLegacyBase,
  type UpgradePreview,
} from "../../src/application/local-image-upgrade-plan";
import { selectSpaceSyncRoute } from "../../src/application/space-sync-route";
import {
  isConnectionState,
  type ConnectionState,
} from "../../src/application/connection-service";
import type { SpaceMapping } from "../../src/application/sync-coordinator";
import type { ModalTransition } from "../../src/obsidian/modal-handoff";
import { PreviewModal } from "../../src/obsidian/preview-modal";
import { SyncCenterModal } from "../../src/obsidian/sync-center-modal";
import {
  ObsidianControlStore,
  ObsidianLocalControlStore,
  RequestUrlHttp,
} from "../../src/obsidian/adapters";
import { MutableControlRepository } from "../../src/storage/envelope";
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
const V1_CAPABILITIES = {
  ...V2_CAPABILITIES,
  maxChangeCount: 5000,
  maxClientTotalBodyBytes: 104_857_600,
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
    else if (publishPreview && path === "/api/sync/v3/spaces/space-1/head") {
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
        revisionBodyBytes: String(
          publishPreview.candidate.pages.reduce(
            (n, p) => n + new TextEncoder().encode(p.body).byteLength,
            0,
          ),
        ),
        revisionAttachmentBytes: String(
          publishPreview.candidate.attachments.reduce(
            (n, a) => n + Number(a.sizeBytes),
            0,
          ),
        ),
        publishedAt: "2026-09-06T00:01:00.000Z",
      };
    } else if (/^\/api\/sync\/v[12]\/spaces\/space-1\/head$/.test(path)) {
      const metrics = await remoteMetrics();
      json = {
        protocolVersion: path.includes("/v1/") ? "1" : "2",
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
      /^\/api\/sync\/v[12]\/spaces\/space-1\/push-sessions$/.test(path)
    )
      json = {
        protocolVersion: path.includes("/v1/") ? "1" : "2",
        ...(path.includes("/v1/") ? { capabilities: V1_CAPABILITIES } : {}),
        sessionId,
        status: "uploading",
        expiresAt: "2099-01-01T00:00:00.000Z",
        result: null,
      };
    else if (
      !publishPreview &&
      value.method === "PUT" &&
      /^\/api\/sync\/v[12]\/spaces\/space-1\/push-sessions\//.test(path) &&
      path.includes("/batches/")
    ) {
      const batch = JSON.parse(value.body as string) as {
        batchIndex: number;
        batchHash: string;
        changes: typeof uploadedV2Changes;
      };
      uploadedV2Changes = path.includes("/v1/")
        ? (
            batch.changes as unknown as {
              operation: string;
              pageId: string;
              path: string;
              title: string;
              body: string;
              contentHash: string;
            }[]
          ).map((change) => ({
            operation: "upsert_page",
            page: {
              pageId: change.pageId,
              path: change.path,
              title: change.title,
              body: change.body,
              contentHash: change.contentHash,
              folderId: null,
              updatedAt: "2026-09-06T00:00:00.000Z",
            },
          }))
        : structuredClone(batch.changes);
      json = {
        protocolVersion: path.includes("/v1/") ? "1" : "2",
        sessionId,
        batchIndex: batch.batchIndex,
        batchHash: batch.batchHash,
        receipt: `v2-batch-${batch.batchIndex}`,
        receivedBatchCount: batch.batchIndex + 1,
      };
    } else if (
      !publishPreview &&
      value.method === "POST" &&
      (path ===
        `/api/sync/v2/spaces/space-1/push-sessions/${sessionId}/finalize` ||
        path ===
          `/api/sync/v1/spaces/space-1/push-sessions/${sessionId}/finalize`)
    ) {
      for (const change of uploadedV2Changes)
        if (change.operation === "upsert_page" && change.page)
          remotePages = [structuredClone(change.page)];
      remoteRevision = "text-published";
      const metrics = await remoteMetrics();
      json = {
        protocolVersion: path.includes("/v1/") ? "1" : "2",
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
  legacyShape = false,
): Promise<UpgradePreview> {
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
  const preview = structuredClone(await entry.finalizePreview(draft));
  if (legacyShape) {
    // Reconstruct the exact old scanner shape: it retained bytes for non-MD
    // files under pages, before unmanaged metadata was introduced.
    for (const [path, bytes] of harness.adapter.binaryFiles) {
      if (!path.startsWith("Wiki/pages/") || path.toLowerCase().endsWith(".md"))
        continue;
      const relativePath = path.slice("Wiki/".length);
      const state = { kind: "file" as const, hash: await sha256Hex(bytes) };
      preview.merge.local.rawPathStates[relativePath] = state;
      preview.localPlanEvidence.rawPathStates[relativePath] = state;
      preview.localPlanEvidence.initialBindings!.originalLocal.rawPathStates[
        relativePath
      ] = state;
    }
    delete preview.localPlanEvidence.unmanagedPaths;
    delete preview.localPlanEvidence.normalizations;
    delete (preview.merge.local as Partial<typeof preview.merge.local>)
      .normalizations;
    delete preview.merge.local.unmanagedPaths;
    const original = preview.localPlanEvidence.initialBindings!.originalLocal;
    delete (original as Partial<typeof original>).normalizations;
    delete original.unmanagedPaths;
    preview.localPlanHash = await hashUpgradeLocalPlan(
      preview.localPlanEvidence,
    );
    preview.authorizationHash = await hashUpgradeAuthorization({
      binding: preview.binding,
      sourceRevision: preview.remoteBase.sourceRevision,
      sourceV2RevisionHash: preview.remoteBase.sourceV2RevisionHash,
      projectedV3BaseHash: preview.remoteBase.projectedV3BaseHash,
      oldBaselineEvidenceHash: preview.oldBaselineEvidenceHash,
      candidateHash: preview.candidateHash,
      localPlanHash: preview.localPlanHash,
      confirmationHash: preview.push.confirmationHash,
    });
  }
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
  return preview;
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
  it("rejects oversized Markdown in the real factory image probe before its first read", async () => {
    const h = await pluginUpgradeHarness({
      localBody: "x".repeat(V2_CAPABILITIES.maxPageBytes + 1),
    });
    h.adapter.readPaths.length = 0;
    const subject = h.plugin as unknown as {
      runtime: (mapping: SpaceMapping) => Promise<SyncRuntime>;
    };
    await expect(
      subject.runtime(h.plugin.settings.mappings[0]!),
    ).rejects.toThrow("SPACE_TOO_LARGE");
    expect(h.adapter.readPaths).not.toContain("Wiki/pages/note.md");
    expect(h.businessWrites).toEqual([]);
  });
  it.each([
    "same",
    "revoked",
    "serverInstanceId",
    "credentialId",
    "deviceId",
    "vaultId",
    "serverOrigin",
    "localCredential",
    "readOnlyRemotePush",
  ])(
    "rechecks actual factory authority before ordinary modal confirmation: %s",
    async (change) => {
      const h = await pluginUpgradeHarness();
      const subject = h.plugin as unknown as {
        runtime: (mapping: SpaceMapping) => Promise<SyncRuntime>;
        runtimeRoutes: WeakMap<
          SyncRuntime,
          { upgrade: LocalImageUpgradeEntry | null }
        >;
        openPushPreviewV3: (
          runtime: SyncRuntime,
          flow: unknown,
          title: string,
        ) => Promise<ModalTransition>;
      };
      const mapping = h.plugin.settings.mappings[0]!;
      const carrier = await subject.runtime(mapping);
      const entry = subject.runtimeRoutes.get(carrier)?.upgrade;
      if (!entry) throw new Error("missing upgrade");
      const draft = await entry.prepare();
      if (draft.kind !== "upgrade_draft") throw new Error("missing draft");
      const upgrade = await entry.finalizePreview(draft);
      h.setPublishPreview(upgrade);
      await entry.confirm(upgrade, upgrade.authorizationHash);
      h.setSyncMode("native_v3");
      const runtime = await subject.runtime(mapping);
      const canonical = h.adapter.files.get("Wiki/pages/note.md")!;
      const raw =
        (change === "readOnlyRemotePush" ? "changed " : "") +
        canonical.replace("../assets/used.png", "used.png");
      h.adapter.files.set("Wiki/pages/note.md", raw);
      const open = vi.spyOn(PreviewModal.prototype, "open");
      (
        await subject.openPushPreviewV3(
          runtime,
          { phaseRelease: () => () => {}, finish: () => {} },
          "Push",
        )
      )();
      const modal = open.mock.instances.at(-1) as unknown as PreviewModal;
      const original = requestUrlState.impl;
      requestUrlState.impl = async (request) => {
        const response = await original(request);
        const path = new URL((request as { url: string }).url).pathname;
        if (
          path.endsWith("/session") &&
          [
            "revoked",
            "serverInstanceId",
            "credentialId",
            "deviceId",
            "vaultId",
          ].includes(change)
        ) {
          const json = {
            ...(response.json as Record<string, unknown>),
            [change === "revoked" ? "credentialStatus" : change]:
              change === "revoked"
                ? "revoked"
                : "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          };
          return { ...response, json, text: JSON.stringify(json) };
        }
        if (path === "/api/sync/v3/spaces" && change === "readOnlyRemotePush") {
          const body = response.json as {
            spaces: Array<Record<string, unknown>>;
          };
          const json = {
            ...body,
            spaces: body.spaces.map((space) => ({
              ...space,
              canPublish: false,
            })),
          };
          return { ...response, json, text: JSON.stringify(json) };
        }
        return response;
      };
      if (change === "serverOrigin")
        h.plugin.settings.serverUrl = "https://different.example.com";
      if (change === "localCredential") {
        const connection = new MutableControlRepository(
          new ObsidianLocalControlStore(h.app as never),
          "connection-state.json",
          isConnectionState,
        );
        await connection.write({
          ...h.connection,
          credentialId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        });
      }
      h.requests.length = 0;
      h.businessWrites.length = 0;
      const notices = noticeMessages().length;
      modalButton(
        modal,
        change === "readOnlyRemotePush" ? "确认执行" : "确认修正本地链接",
      ).dispatchEvent({ type: "click" });
      await vi.waitFor(() =>
        expect(noticeMessages().length).toBeGreaterThan(notices),
      );
      if (change === "same")
        expect(h.adapter.files.get("Wiki/pages/note.md")).toBe(canonical);
      else {
        expect(h.adapter.files.get("Wiki/pages/note.md")).toBe(raw);
        expect(h.businessWrites).toEqual([]);
      }
      expect(h.requests.filter((request) => request.method !== "GET")).toEqual(
        [],
      );
      modal.close();
      open.mockRestore();
    },
  );
  it("unsubscribes and disables an open upgrade confirmation on plugin unload", async () => {
    const h = await pluginUpgradeHarness();
    const off = vi.fn();
    const subscribe = Object.getOwnPropertyDescriptor(
      LocalImageUpgradeEntry.prototype,
      "onInvalidate",
    )!.value as LocalImageUpgradeEntry["onInvalidate"];
    const subscription = vi
      .spyOn(LocalImageUpgradeEntry.prototype, "onInvalidate")
      .mockImplementation(function (this: LocalImageUpgradeEntry, listener) {
        const unsubscribe = subscribe.call(this, listener);
        return () => {
          off();
          unsubscribe();
        };
      });
    const subject = h.plugin as unknown as {
      runSyncStrategy: (
        id: string,
        strategy: "auto",
        options: unknown,
      ) => Promise<ModalTransition>;
    };
    const open = vi.spyOn(PreviewModal.prototype, "open");
    (await subject.runSyncStrategy("space-1", "auto", {}))();
    const modal = open.mock.instances.at(-1) as unknown as PreviewModal;
    expect(modalButton(modal, "确认升级并同步").disabled).toBe(false);
    h.plugin.unload();
    expect(off).toHaveBeenCalledOnce();
    expect(modalButton(modal, "确认升级并同步").disabled).toBe(true);
    expect(h.businessWrites).toEqual([]);
    expect(h.requests.filter((request) => request.method !== "GET")).toEqual(
      [],
    );
    open.mockRestore();
    subscription.mockRestore();
  });
  it("recovers a persisted pre-normalization upgrade without adding fields or changing its authorization", async () => {
    const h = await pluginUpgradeHarness();
    h.adapter.binaryFiles.set(
      "Wiki/pages/legacy.bin",
      new Uint8Array([1, 2, 3]),
    );
    h.adapter.deriveParents("Wiki/pages/legacy.bin");
    const old = await seedConfirmedUpgradeInPlugin(h, true);
    h.setPublishPreview(old);
    const restarted = new AgentWikiSyncPlugin(
      h.app as never,
      h.plugin.manifest,
    );
    await restarted.onload();
    const subject = restarted as unknown as {
      runSyncStrategy: (
        id: string,
        strategy: "auto",
        options: unknown,
      ) => Promise<unknown>;
    };
    await subject.runSyncStrategy("space-1", "auto", {});
    const roots = [...h.adapter.files.entries()].filter(([path]) =>
      path.endsWith("local-image-upgrade/journal.json"),
    );
    expect(roots).toHaveLength(1);
    const { payload: result } = JSON.parse(roots[0]![1]) as {
      payload: { phase: string; authorizationHash: string };
    };
    expect(result.phase).toBe("complete");
    expect(result.authorizationHash).toBe(old.authorizationHash);
    expect(Object.hasOwn(old.localPlanEvidence, "normalizations")).toBe(false);
    expect(Object.hasOwn(old.localPlanEvidence, "unmanagedPaths")).toBe(false);
    expect(h.adapter.binaryFiles.get("Wiki/pages/legacy.bin")).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });
  it("does not extend an old confirmed upgrade's opaque-file authorization to a new file", async () => {
    const h = await pluginUpgradeHarness();
    const old = await seedConfirmedUpgradeInPlugin(h, true);
    h.setPublishPreview(old);
    h.adapter.binaryFiles.set("Wiki/pages/new.png", PNG);
    h.adapter.deriveParents("Wiki/pages/new.png");
    h.adapter.readPaths.length = 0;
    const before = [...h.adapter.files.entries()].filter(
      ([path]) =>
        path.includes("tree-identities") ||
        path.endsWith("/payload/confirmed-preview.json"),
    );
    const subject = h.plugin as unknown as {
      runSyncStrategy: (
        id: string,
        strategy: "auto",
        options: unknown,
      ) => Promise<unknown>;
    };
    await expect(
      subject.runSyncStrategy("space-1", "auto", {}),
    ).rejects.toThrow("STALE_UPGRADE_PREVIEW");
    expect(h.adapter.readPaths).not.toContain("Wiki/pages/new.png");
    expect(h.requests.filter((request) => request.method !== "GET")).toEqual(
      [],
    );
    expect(h.businessWrites).toEqual([]);
    expect(
      [...h.adapter.files.entries()].filter(
        ([path]) =>
          path.includes("tree-identities") ||
          path.endsWith("/payload/confirmed-preview.json"),
      ),
    ).toEqual(before);
  });
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

  it("binds shortest-image normalization into the single upgrade confirmation and local write plan", async () => {
    const { entry, vault, http } = await makeUpgradeEntryFixture();
    vault.seedMarkdown("Wiki/pages/note.md", "![A](used.png)");
    Object.assign(vault, {
      resolveShortestImage: async () => ({
        kind: "resolved",
        attachmentPath: "assets/used.png",
        basenameKey: "used.png",
      }),
    });
    const draft = await entry.prepare();
    expect(draft.kind).toBe("upgrade_draft");
    if (draft.kind !== "upgrade_draft") throw new Error("expected draft");
    const preview = await entry.finalizePreview(draft);
    expect(preview.localPlanEvidence.normalizations).toHaveLength(1);
    expect(preview.localActions).toContainEqual(
      expect.objectContaining({ kind: "write_page", path: "pages/note.md" }),
    );
    expect(http.calls.every((call) => call.method === "GET")).toBe(true);
    expect(
      new TextDecoder().decode((await vault.read("Wiki/pages/note.md"))!),
    ).toBe("![A](used.png)");
  });

  it("repairs the explicitly bound remote PageID through the real first-upgrade factory", async () => {
    const h = await pluginUpgradeHarness({ remoteBody: "server text\n" });
    h.adapter.files.set("Wiki/pages/note.md", "![A](used.png)");
    const subject = h.plugin as unknown as {
      runtime: (mapping: SpaceMapping) => Promise<SyncRuntime>;
      runtimeRoutes: WeakMap<
        SyncRuntime,
        { upgrade: LocalImageUpgradeEntry | null }
      >;
    };
    const runtime = await subject.runtime(h.plugin.settings.mappings[0]!);
    const entry = subject.runtimeRoutes.get(runtime)!.upgrade!;
    const required = await entry.prepare();
    if (required.kind !== "initial_binding_required")
      throw new Error("expected bindings");
    await expect(entry.resolveInitialBindings(required, [])).rejects.toThrow();
    const draft = await entry.resolveInitialBindings(
      required,
      required.requirements.map((r) => ({
        kind: r.kind,
        localId: r.localId,
        remoteId: r.remoteId,
      })),
    );
    for (const conflict of [...draft.merge.pageConflicts])
      await resolvePageConflictV3(draft.merge, conflict.conflictId, {
        choice: "local",
      });
    const preview = await entry.finalizePreview(draft);
    const page = preview.candidate.pages.find(
      (p) => p.path === "pages/note.md",
    )!;
    expect(preview.localPlanEvidence.normalizations![0]!.pageId).toBe(
      page.pageId,
    );
    expect(preview.localActions).toContainEqual(
      expect.objectContaining({
        kind: "write_page",
        pageId: page.pageId,
        path: page.path,
      }),
    );
    h.setPublishPreview(preview);
    await entry.confirm(preview, preview.authorizationHash);
    expect(h.adapter.files.get("Wiki/pages/note.md")).toBe(
      "![A](../assets/used.png)",
    );
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
      runtime: (mapping: SpaceMapping) => Promise<object>;
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

    await subject.runtime(harness.plugin.settings.mappings[0]!);
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

  it.each([
    {
      evidence: "malformed",
      mutate: async () => "{",
      deviceStateId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    },
    {
      evidence: "newer",
      mutate: async (raw: string) => {
        const envelope = JSON.parse(raw) as { envelopeSchemaVersion: number };
        envelope.envelopeSchemaVersion = 2;
        return JSON.stringify(envelope);
      },
      deviceStateId: undefined,
    },
    {
      evidence: "ownership-inconsistent",
      mutate: async (raw: string) => {
        const envelope = JSON.parse(raw) as {
          payloadHash: string;
          payload: UpgradeIntent;
        };
        envelope.payload.binding.mappingRootKey = "Other";
        envelope.payloadHash = await sha256Hex(
          canonicalBytes(envelope.payload),
        );
        return JSON.stringify(envelope);
      },
      deviceStateId: undefined,
    },
  ])(
    "fails disconnect closed for $evidence upgrade evidence",
    async ({ mutate, deviceStateId }) => {
      const harness = await pluginUpgradeHarness();
      await seedConfirmedUpgradeInPlugin(harness);
      const journalPath = [...harness.adapter.files.keys()].find((path) =>
        path.endsWith("/local-image-upgrade/journal.json"),
      );
      if (!journalPath) throw new Error("expected upgrade journal");
      const original = harness.adapter.files.get(journalPath);
      if (!original) throw new Error("expected upgrade journal body");
      const mutated = await mutate(original);
      harness.adapter.files.set(journalPath, mutated);
      if (deviceStateId) {
        const deviceStatePath = [...harness.local.keys()].find((path) =>
          path.endsWith("agentwiki-sync-device-v1"),
        );
        if (!deviceStatePath) throw new Error("expected device state");
        const envelope = JSON.parse(
          String(harness.local.get(deviceStatePath)),
        ) as {
          writeGeneration: number;
          payloadHash: string;
          payload: { deviceId: string };
        };
        envelope.writeGeneration += 1;
        envelope.payload.deviceId = deviceStateId;
        envelope.payloadHash = await sha256Hex(
          canonicalBytes(envelope.payload),
        );
        harness.local.set(deviceStatePath, JSON.stringify(envelope));
      }

      const restarted = new AgentWikiSyncPlugin(
        harness.app as never,
        harness.plugin.manifest,
      );
      await restarted.onload();
      const localBefore = structuredClone([...harness.local.entries()]);
      await expect(restarted.disconnect()).rejects.toThrow();

      expect(restarted.settings.mappings).toEqual(
        harness.plugin.settings.mappings,
      );
      expect(restarted.settings.serverInstanceId).toBe(
        harness.connection.serverInstanceId,
      );
      expect(harness.secretValue(harness.connection.credentialSecretId)).toBe(
        "test-secret",
      );
      expect(harness.adapter.files.get(journalPath)).toBe(mutated);
      expect([...harness.local.entries()]).toEqual(localBefore);
    },
  );

  it.each([
    {
      evidence: "pending",
      mutate: async (raw: string) => raw,
    },
    {
      evidence: "corrupt",
      mutate: async () => "{",
    },
  ])(
    "fails disconnect closed for $evidence upgrade evidence when local device state is missing",
    async ({ mutate }) => {
      const harness = await pluginUpgradeHarness();
      await seedConfirmedUpgradeInPlugin(harness);
      const journalPath = [...harness.adapter.files.keys()].find((path) =>
        path.endsWith("/local-image-upgrade/journal.json"),
      );
      if (!journalPath) throw new Error("expected upgrade journal");
      const original = harness.adapter.files.get(journalPath);
      if (!original) throw new Error("expected upgrade journal body");
      const persisted = await mutate(original);
      harness.adapter.files.set(journalPath, persisted);
      for (const key of [...harness.local.keys()])
        if (key.includes("agentwiki-sync-device-v1")) harness.local.delete(key);
      const localBefore = structuredClone([...harness.local.entries()]);

      await expect(harness.plugin.disconnect()).rejects.toThrow();

      expect(harness.plugin.settings.mappings).toHaveLength(1);
      expect(harness.plugin.settings.serverInstanceId).toBe(
        harness.connection.serverInstanceId,
      );
      expect(harness.secretValue(harness.connection.credentialSecretId)).toBe(
        "test-secret",
      );
      expect(harness.adapter.files.get(journalPath)).toBe(persisted);
      expect([...harness.local.entries()]).toEqual(localBefore);
    },
  );

  it("uses the production resolver and authority and rejects an outside duplicate created after preview", async () => {
    const h = await pluginUpgradeHarness({ localBody: "![A](used.png)" });
    const subject = h.plugin as unknown as {
      runtime: (mapping: SpaceMapping) => Promise<SyncRuntime>;
      runtimeRoutes: WeakMap<
        SyncRuntime,
        { upgrade: LocalImageUpgradeEntry | null }
      >;
    };
    const carrier = await subject.runtime(h.plugin.settings.mappings[0]!);
    const entry = subject.runtimeRoutes.get(carrier)?.upgrade;
    if (!entry) throw new Error("expected upgrade");
    const draft = await entry.prepare();
    if (draft.kind !== "upgrade_draft") throw new Error("expected draft");
    const preview = await entry.finalizePreview(draft);
    expect(preview.localPlanEvidence.normalizations).toHaveLength(1);
    h.adapter.binaryFiles.set("Outside/used.png", PNG);
    h.adapter.binaryFiles.set("Wiki/assets/unused.png", PNG);
    h.adapter.deriveParents("Outside/used.png");
    h.emitVault("create", h.adapter.abstractFile("Outside/used.png"));
    await expect(
      entry.confirm(preview, preview.authorizationHash),
    ).rejects.toThrow();
    expect(h.requests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(h.businessWrites).toEqual([]);
    expect(h.adapter.readPaths).not.toContain("Outside/used.png");
    expect(h.adapter.readPaths).not.toContain("Wiki/assets/unused.png");
  });

  it.each(
    ([1, 2] as const).flatMap((schemaVersion) =>
      [false, true].map((confirmRace) => ({ schemaVersion, confirmRace })),
    ),
  )(
    "recovers actual old schema $schemaVersion response loss before image upgrade (confirm race $confirmRace)",
    async ({ schemaVersion, confirmRace }) => {
      const h = await pluginUpgradeHarness({ includeLocalImage: false });
      const subject = h.plugin as unknown as {
        runtime: (mapping: SpaceMapping) => Promise<SyncRuntime>;
        runtimeRoutes: WeakMap<
          SyncRuntime,
          { route: string; upgrade: LocalImageUpgradeEntry | null }
        >;
        runSyncStrategy: (
          id: string,
          strategy: "auto",
          options: unknown,
        ) => Promise<ModalTransition | void>;
        collectSyncDiff: (
          id: string,
          options: unknown,
        ) => Promise<{ recoveryPending: boolean }>;
      };
      const mapping = h.plugin.settings.mappings[0]!;
      const text = await subject.runtime(mapping);
      await text.applyPull(await text.previewPull());
      const textPreview = await text.previewPush();
      const addImage = () => {
        h.adapter.files.set(
          "Wiki/pages/note.md",
          "local text only\n![A](../assets/used.png)\n",
        );
        h.adapter.binaryFiles.set("Wiki/assets/used.png", PNG);
        h.adapter.deriveParents("Wiki/assets/used.png");
        h.emitVault("create", h.adapter.abstractFile("Wiki/assets/used.png"));
      };
      let staleUpgrade: {
        entry: LocalImageUpgradeEntry;
        preview: UpgradePreview;
      } | null = null;
      if (confirmRace) {
        addImage();
        const carrier = await subject.runtime(mapping);
        const entry = subject.runtimeRoutes.get(carrier)!.upgrade!;
        const draft = await entry.prepare();
        if (draft.kind !== "upgrade_draft") throw new Error("expected draft");
        staleUpgrade = { entry, preview: await entry.finalizePreview(draft) };
      }
      const http = requestUrlState.impl;
      let accepted = false;
      requestUrlState.impl = async (request) => {
        const response = await http(request);
        const value = request as { method: string; url: string };
        if (
          !accepted &&
          value.method === "POST" &&
          value.url.endsWith("/push-sessions")
        ) {
          accepted = true;
          throw new Error("accepted create response lost");
        }
        return response;
      };
      if (schemaVersion === 2)
        await expect(text.applyPush(textPreview)).rejects.toThrow();
      else {
        const root = `.agentwiki/devices/d-${await idFileKey(h.connection.deviceId)}/spaces/s-${await idFileKey(mapping.spaceId)}`;
        const service = new PushService(
          new AgentWikiPushRemote(
            new AgentWikiClient(
              h.connection.serverUrl,
              new RequestUrlHttp(),
              () => "secret-1",
            ),
            mapping.spaceId,
          ),
          new ObsidianControlStore(h.app.vault.adapter as never),
          `${root}/push`,
        );
        const page = textPreview.changes.find(
          (change) => change.operation === "upsert_page",
        );
        if (page?.operation !== "upsert_page")
          throw new Error("expected text Page");
        await expect(
          service.publish({
            spaceId: mapping.spaceId,
            baseRevision: "0",
            capabilities: V1_CAPABILITIES,
            credentialId: h.connection.credentialId,
            changes: [
              {
                operation: "upsert",
                pageId: page.page.pageId,
                path: page.page.path,
                title: page.page.title,
                body: "local text only\n",
                contentHash: await contentHash("local text only\n"),
              },
            ],
          }),
        ).rejects.toThrow();
      }
      expect(accepted).toBe(true);
      requestUrlState.impl = http;
      const path = [...h.adapter.files.keys()].find((path) =>
        path.endsWith("/push/journal.json"),
      )!;
      const original = h.adapter.files.get(path)!;
      expect(
        (JSON.parse(original) as { payload: unknown }).payload,
      ).toMatchObject({
        schemaVersion,
        remoteState: "not_created",
        localCommitPhase: "not_started",
      });
      if (staleUpgrade) {
        const requests = h.requests.length;
        const writes = [...h.businessWrites];
        await expect(
          staleUpgrade.entry.confirm(
            staleUpgrade.preview,
            staleUpgrade.preview.authorizationHash,
          ),
        ).rejects.toThrow("PUSH_RECOVERY_REQUIRED");
        expect(
          h.requests
            .slice(requests)
            .filter((request) => request.method !== "GET"),
        ).toEqual([]);
        expect(h.businessWrites).toEqual(writes);
        expect(h.adapter.files.get(path)).toBe(original);
      } else addImage();
      const pending = await subject.runtime(mapping);
      expect(subject.runtimeRoutes.get(pending)?.route).toBe("legacy");
      expect(subject.runtimeRoutes.get(pending)?.upgrade).toBeNull();
      const writes = [...h.businessWrites];
      const before = h.requests.length;
      expect(await subject.collectSyncDiff("space-1", {})).toMatchObject({
        recoveryPending: true,
      });
      expect(h.adapter.files.get(path)).toBe(original);
      expect(h.businessWrites).toEqual(writes);
      expect(
        await subject.runSyncStrategy("space-1", "auto", {}),
      ).toBeUndefined();
      expect(
        (JSON.parse(h.adapter.files.get(path)!) as { payload: unknown })
          .payload,
      ).toMatchObject({
        schemaVersion,
        remoteState: "published",
        localCommitPhase: "verified",
      });
      expect(
        h.requests
          .slice(before)
          .filter((request) => request.method !== "GET")
          .every((request) => request.path.includes(`/v${schemaVersion}/`)),
      ).toBe(true);
      const next = await subject.runtime(mapping);
      const upgrade = subject.runtimeRoutes.get(next)!.upgrade!;
      expect(subject.runtimeRoutes.get(next)?.route).toBe("upgrade");
      const draft = await upgrade.prepare();
      if (draft.kind !== "upgrade_draft") throw new Error("expected draft");
      for (const conflict of [...draft.merge.pageConflicts])
        await resolvePageConflictV3(draft.merge, conflict.conflictId, {
          choice: "local",
        });
      const confirmed = await upgrade.finalizePreview(draft);
      h.setPublishPreview(confirmed);
      await upgrade.confirm(confirmed, confirmed.authorizationHash);
      h.setSyncMode("native_v3");
      await (await subject.runtime(mapping)).recover();
      expect(h.adapter.files.has(path)).toBe(true);
      h.plugin.unload();
    },
  );

  it.each([
    "origin",
    "credential",
    "local-credential",
    "mapping",
    "session",
    "unload",
    "unload-before-open",
    "unload-during-session",
    "epoch",
    "restart",
  ])(
    "rechecks pending retry authority and lifecycle after %s without replanning durable work",
    async (change) => {
      const h = await pluginUpgradeHarness();
      const subject = h.plugin as unknown as {
        runtime: (mapping: SpaceMapping) => Promise<SyncRuntime>;
        runtimeRoutes: WeakMap<
          SyncRuntime,
          { upgrade: LocalImageUpgradeEntry | null }
        >;
        runSyncStrategy: (
          id: string,
          strategy: "auto",
          options: unknown,
        ) => Promise<ModalTransition>;
        previewUnloadCleanups: Set<() => void>;
      };
      const mapping = h.plugin.settings.mappings[0]!;
      const carrier = await subject.runtime(mapping);
      const entry = subject.runtimeRoutes.get(carrier)!.upgrade!;
      const draft = await entry.prepare();
      if (draft.kind !== "upgrade_draft") throw new Error("expected draft");
      const preview = await entry.finalizePreview(draft);
      h.setPublishPreview(preview);
      await entry.confirm(preview, preview.authorizationHash);
      h.setSyncMode("native_v3");
      const native = await subject.runtime(mapping);
      h.adapter.files.set(
        "Wiki/pages/note.md",
        h.adapter.files
          .get("Wiki/pages/note.md")!
          .replace("../assets/used.png", "used.png"),
      );
      h.emitVault("modify", h.adapter.abstractFile("Wiki/pages/note.md"));
      const repair = await native.previewPushV3();
      const process = h.app.vault.process;
      h.app.vault.process = async () => {
        throw new Error("actual CAS interruption");
      };
      await expect(native.applyPushV3(repair)).rejects.toThrow();
      h.app.vault.process = process;
      const pending = await native.inspectNormalizedPush();
      expect(pending?.phase).toBe("local_pending");
      if (change === "restart") {
        h.plugin.unload();
        await h.plugin.onload();
      }
      const open = vi.spyOn(PreviewModal.prototype, "open");
      const transition = await subject.runSyncStrategy("space-1", "auto", {});
      if (change === "unload-before-open") h.plugin.unload();
      transition();
      const modal = open.mock.instances.at(-1) as unknown as PreviewModal;
      const writes = [...h.businessWrites];
      const start = h.requests.length;
      const http = requestUrlState.impl;
      if (change === "origin")
        h.plugin.settings.serverUrl = "https://changed.example";
      if (change === "credential") {
        h.connection.credentialId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
      }
      if (change === "local-credential")
        await new MutableControlRepository(
          new ObsidianLocalControlStore(h.app as never),
          "connection-state.json",
          isConnectionState,
        ).write({
          ...h.connection,
          credentialId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        });
      if (change === "mapping") h.plugin.settings.mappings = [];
      if (change === "session" || change === "unload-during-session")
        requestUrlState.impl = async (request) => {
          const response = await http(request);
          if (
            (request as { url: string }).url.endsWith(
              "/api/integrations/obsidian/session",
            )
          ) {
            if (change === "unload-during-session") {
              h.plugin.unload();
              return response;
            }
            return {
              ...response,
              json: {
                ...(response.json as object),
                credentialStatus: "revoked",
              },
            };
          }
          return response;
        };
      if (change === "unload") h.plugin.unload();
      if (change === "epoch")
        h.emitVault("modify", h.adapter.abstractFile("Wiki/pages/note.md"));
      if (change === "unload" || change === "unload-before-open") {
        expect(modalButton(modal, "重试").disabled).toBe(true);
        await expect(
          (
            modal as unknown as { confirm: (options: object) => Promise<void> }
          ).confirm({}),
        ).rejects.toThrow("STALE_PUSH_PREVIEW");
      }
      modalButton(modal, "重试").dispatchEvent({ type: "click" });
      if (change === "epoch" || change === "restart") {
        await vi.waitFor(async () =>
          expect((await native.inspectNormalizedPush())?.phase).toBe(
            "complete",
          ),
        );
        expect((await native.inspectNormalizedPush())?.authorizationHash).toBe(
          pending?.authorizationHash,
        );
        expect(
          h.requests
            .slice(start)
            .some((request) => request.path.endsWith("/session")),
        ).toBe(true);
      } else {
        if (change !== "unload" && change !== "unload-before-open")
          await vi.waitFor(() =>
            expect(noticeMessages().length).toBeGreaterThan(0),
          );
        expect((await native.inspectNormalizedPush())?.phase).toBe(
          "local_pending",
        );
        expect(h.businessWrites).toEqual(writes);
        expect(
          h.requests.slice(start).filter((request) => request.method !== "GET"),
        ).toEqual([]);
      }
      modal.close();
      expect(subject.previewUnloadCleanups.size).toBe(0);
      requestUrlState.impl = http;
      open.mockRestore();
      h.plugin.unload();
    },
  );

  it("continues native sync after a real text Push and first image upgrade without losing the old terminal journal", async () => {
    const h = await pluginUpgradeHarness({ includeLocalImage: false });
    const subject = h.plugin as unknown as {
      runtime: (mapping: SpaceMapping) => Promise<SyncRuntime>;
      runtimeRoutes: WeakMap<
        SyncRuntime,
        { upgrade: LocalImageUpgradeEntry | null }
      >;
    };
    const mapping = h.plugin.settings.mappings[0]!;
    const text = await subject.runtime(mapping);
    await text.applyPull(await text.previewPull());
    await text.applyPush(await text.previewPush());
    const oldPath = [...h.adapter.files.keys()].find((path) =>
      path.endsWith("/push/journal.json"),
    );
    expect(oldPath).toBeDefined();
    const old = JSON.parse(h.adapter.files.get(oldPath!)!) as {
      payload: { schemaVersion: number; localCommitPhase: string };
    };
    expect(old.payload).toMatchObject({
      schemaVersion: 2,
      localCommitPhase: "verified",
    });
    h.adapter.files.set(
      "Wiki/pages/note.md",
      "local text only\n![A](../assets/used.png)",
    );
    h.adapter.binaryFiles.set("Wiki/assets/used.png", PNG);
    h.adapter.deriveParents("Wiki/assets/used.png");
    h.emitVault("create", h.adapter.abstractFile("Wiki/assets/used.png"));
    const carrier = await subject.runtime(mapping);
    const upgrade = subject.runtimeRoutes.get(carrier)?.upgrade;
    if (!upgrade) throw new Error("expected upgrade entry");
    const draft = await upgrade.prepare();
    if (draft.kind !== "upgrade_draft") throw new Error("expected draft");
    const confirmed = await upgrade.finalizePreview(draft);
    h.setPublishPreview(confirmed);
    await upgrade.confirm(confirmed, confirmed.authorizationHash);
    h.setSyncMode("native_v3");
    const native = await subject.runtime(mapping);
    await native.recover();
    await expect(native.hasUnfinishedPush()).resolves.toBe(false);
    expect(h.adapter.files.has(oldPath!)).toBe(true);
    const oldEnvelope = JSON.parse(h.adapter.files.get(oldPath!)!) as {
      writeGeneration: number;
      payload: unknown;
    };
    h.adapter.files.set(
      "Wiki/pages/note.md",
      h.adapter.files
        .get("Wiki/pages/note.md")!
        .replace("../assets/used.png", "used.png"),
    );
    h.emitVault("modify", h.adapter.abstractFile("Wiki/pages/note.md"));
    const repair = await native.previewPushV3();
    expect(repair.normalizedPush?.plan.mode).toBe("local_only");
    expect(repair.normalizedPush!.plan.binding).toMatchObject({
      serverOrigin: h.plugin.settings.serverUrl,
      serverInstanceId: h.connection.serverInstanceId,
      deviceId: h.connection.deviceId,
      credentialId: h.connection.credentialId,
      vaultId: h.connection.vaultId,
      spaceId: mapping.spaceId,
      mappingRootKey: mapping.rootPath,
    });
    const process = h.app.vault.process;
    h.app.vault.process = async () => {
      throw new Error("injected actual CAS interruption");
    };
    await expect(native.applyPushV3(repair)).rejects.toThrow();
    h.app.vault.process = process;
    expect((await native.inspectNormalizedPush())?.phase).toBe("local_pending");
    const lifecycle = h.plugin as unknown as {
      collectSyncDiff: (
        id: string,
        options: unknown,
      ) => Promise<{ displayName: string; recoveryPending: boolean }>;
      runSyncStrategy: (
        id: string,
        strategy: "auto",
        options: unknown,
      ) => Promise<ModalTransition>;
    };
    const beforeWrites = [...h.businessWrites];
    const beforeRequests = h.requests.length;
    expect(await lifecycle.collectSyncDiff("space-1", {})).toMatchObject({
      displayName: "本地链接修正待处理，未发布云端版本",
      recoveryPending: true,
    });
    expect(h.businessWrites).toEqual(beforeWrites);
    expect(
      h.requests.slice(beforeRequests).some((r) => r.path.includes("/head")),
    ).toBe(false);
    await expect(h.plugin.removeMapping("space-1")).rejects.toThrow();
    await expect(h.plugin.disconnect()).rejects.toThrow();
    expect(h.plugin.settings.mappings).toContainEqual(mapping);
    const open = vi.spyOn(PreviewModal.prototype, "open");
    const openFile = vi.spyOn(h.app.workspace, "openLinkText");
    (await lifecycle.runSyncStrategy("space-1", "auto", {}))();
    const pendingModal = open.mock.instances.at(-1) as unknown as PreviewModal;
    modalButton(pendingModal, "查看文件：pages/note.md").dispatchEvent({
      type: "click",
    });
    await vi.waitFor(() =>
      expect(openFile).toHaveBeenCalledWith("Wiki/pages/note.md", "", false),
    );
    expect(h.businessWrites).toEqual(beforeWrites);
    modalButton(pendingModal, "关闭").dispatchEvent({ type: "click" });
    expect((await native.inspectNormalizedPush())?.phase).toBe("local_pending");
    (await lifecycle.runSyncStrategy("space-1", "auto", {}))();
    const retryModal = open.mock.instances.at(-1) as unknown as PreviewModal;
    modalButton(retryModal, "重试").dispatchEvent({ type: "click" });
    await vi.waitFor(async () =>
      expect((await native.inspectNormalizedPush())?.phase).toBe("complete"),
    );
    open.mockRestore();
    openFile.mockRestore();
    const current = JSON.parse(h.adapter.files.get(oldPath!)!) as {
      writeGeneration: number;
      payload: unknown;
    };
    expect(current.payload).toMatchObject({
      schemaVersion: 4,
      phase: "complete",
    });
    expect(current.writeGeneration).toBeGreaterThan(
      oldEnvelope.writeGeneration,
    );
    const history = [...h.adapter.files.entries()].filter(
      ([path]) =>
        path.includes("/history-2-") && path.endsWith("/terminal.json"),
    );
    expect(history).toHaveLength(1);
    expect(JSON.parse(history[0]![1])).toEqual(oldEnvelope);
    expect(h.adapter.files.get("Wiki/pages/note.md")).toContain(
      "../assets/used.png",
    );
    const invalidate = vi.spyOn(native, "invalidate");
    h.plugin.unload();
    const count = invalidate.mock.calls.length;
    h.emitVault("create", h.adapter.abstractFile("Wiki/assets/used.png"));
    expect(invalidate.mock.calls).toHaveLength(count);
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
    expect(upgrade.contentEl.textContent).toContain(
      "图片：0 张 · 传输字节上界 0 B",
    );
    expect(upgrade.contentEl.textContent).not.toContain(
      "图片：assets/used.png",
    );
    expect(upgrade.contentEl.textContent).toContain("本地应用 写入:");
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
