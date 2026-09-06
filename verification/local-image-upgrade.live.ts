/* global process -- Node supplies the opt-in provider path and redacted evidence stream. */
import { describe, expect, it } from "vitest";
import {
  TreeCapabilitiesResponseV2Schema,
  TreeCapabilitiesResponseV3Schema,
  blobContentHashV3,
  canonicalBytes,
  canonicalTreeDeltaItemsV3,
  treeBatchHashV3,
  treeConfirmationHashV3,
  treeRevisionContentHashV3,
  treeRevisionDeltaV3,
  type TreePushManifestChangeV3,
  type TreeSyncCapabilitiesV3,
} from "@neomei/agentwiki-sync-protocol";

import { AgentWikiClient } from "../src/agentwiki/client";
import { contentHash } from "../src/agentwiki/protocol";
import { V2TreeRemote } from "../src/agentwiki/v2-tree-remote";
import { V3TreeRemote } from "../src/agentwiki/v3-tree-remote";
import {
  projectLegacyBase,
  type UpgradeTree,
} from "../src/application/local-image-upgrade-plan";
import {
  readTreeSnapshot,
  readTreeSnapshotV3,
} from "../src/application/tree-snapshot-reader";
import type { HttpPort, HttpResponseType } from "../src/ports/http";

interface LiveRequest {
  method: string;
  path: string;
  body?: unknown;
  canonicalBody?: Uint8Array;
  binaryBody?: Uint8Array;
  responseType: HttpResponseType;
  maxResponseBytes: number;
}
interface LiveContext {
  serverLabel: string;
  spaceIds: { populated: string; empty: string };
  cleanupOwner: string;
  request(input: LiveRequest): Promise<{
    status: number;
    json?: unknown;
    bytes?: Uint8Array;
    headers?: Record<string, string>;
  }>;
}

const providerPath = process.env.AGENTWIKI_UPGRADE_LIVE_CONTEXT_MODULE;
if (!providerPath)
  throw new Error(
    "AGENTWIKI_UPGRADE_LIVE_CONTEXT_MODULE is required; live verification never skips",
  );
// eslint-disable-next-line no-unsanitized/method -- explicit opt-in path supplies credential-free test transport
const provider = (await import(/* @vite-ignore */ providerPath)) as {
  default?: () => Promise<LiveContext>;
  createLiveContext?: () => Promise<LiveContext>;
};
const create = provider.createLiveContext ?? provider.default;
if (!create) throw new Error("LIVE_CONTEXT_PROVIDER_INVALID");
const live = await create();

const http: HttpPort = {
  async request(request) {
    const url = new URL(request.url);
    const response = await live.request({
      method: request.method,
      path: url.pathname + url.search,
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.canonicalBody
        ? { canonicalBody: request.canonicalBody }
        : {}),
      ...(request.binaryBody ? { binaryBody: request.binaryBody } : {}),
      responseType: request.responseType ?? "bounded-json",
      maxResponseBytes: Math.min(
        request.maxResponseBytes ?? 2_097_152,
        2_097_152,
      ),
    });
    return { ...response, json: response.json };
  },
};
const client = new AgentWikiClient(
  "https://live-context.invalid",
  http,
  () => null,
);

async function remotes(spaceId: string) {
  const v2Envelope = TreeCapabilitiesResponseV2Schema.parse(
    (await client.raw("GET", "/api/sync/v2/capabilities")).json,
  );
  const v3Envelope = TreeCapabilitiesResponseV3Schema.parse(
    (await client.raw("GET", "/api/sync/v3/capabilities")).json,
  );
  return {
    v2: new V2TreeRemote(client, spaceId, {
      version: "2",
      capabilities: v2Envelope.capabilities,
      capabilitiesHash: v2Envelope.capabilitiesHash,
    }),
    v3: new V3TreeRemote(
      client,
      spaceId,
      {
        version: "3",
        capabilities: v3Envelope.capabilities,
        capabilitiesHash: v3Envelope.capabilitiesHash,
      },
      { sleep: async () => undefined },
    ),
    capabilities: v3Envelope.capabilities,
    capabilitiesHash: v3Envelope.capabilitiesHash,
  };
}

function confirmationChanges(
  changes: ReturnType<typeof treeRevisionDeltaV3>,
): TreePushManifestChangeV3[] {
  return changes.map((change) => {
    if (change.operation !== "upsert_page") return change;
    const { body: _body, ...page } = change.page;
    return { operation: "upsert_page", page };
  });
}

// Valid, decodable 1x1 RGBA PNG. The fixture is synthetic and contains no user data.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X2NDWQAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);

async function publishUpgrade(input: {
  spaceId: string;
  source: Awaited<ReturnType<typeof readTreeSnapshot>> & {
    protocolVersion: "2";
  };
  unchanged?: Awaited<
    ReturnType<typeof projectLegacyBase>
  >["projected"]["pages"][number];
  page: Awaited<
    ReturnType<typeof projectLegacyBase>
  >["projected"]["pages"][number];
  candidatePages: UpgradeTree["pages"];
  v3: V3TreeRemote;
  capabilities: TreeSyncCapabilitiesV3;
  capabilitiesHash: string;
  beforeSequence: number;
  evidenceCase: "populated" | "empty";
}) {
  const base = await projectLegacyBase(input.source);
  expect(base.projected.folders).toEqual(input.source.folders);
  const attachmentId = crypto.randomUUID();
  const contentHashValue = await blobContentHashV3(PNG);
  const imageName = `u1-${input.evidenceCase}-${contentHashValue.slice(0, 12)}.png`;
  const updatedAt = "2026-09-06T01:00:00.000Z";
  const body = `${input.page.body.replace(/\n*$/u, "")}\n\n![[assets/${imageName}]]\n`;
  const added = {
    attachmentId,
    path: `assets/${imageName}`,
    mimeType: "image/png" as const,
    sizeBytes: String(PNG.byteLength),
    width: 1,
    height: 1,
    contentHash: contentHashValue,
    updatedAt,
  };
  const changedPage = {
    ...input.page,
    body,
    contentHash: await contentHash(body),
    updatedAt,
    referencedAttachmentIds: [attachmentId],
  };
  const candidate: UpgradeTree = {
    ...base.projected,
    pages: input.candidatePages.map((page) =>
      page.pageId === input.page.pageId ? changedPage : page,
    ),
    attachments: [added],
  };
  const changes = canonicalTreeDeltaItemsV3(
    treeRevisionDeltaV3(base.projected, candidate),
  );
  if (input.unchanged)
    expect(
      changes.some(
        (change) =>
          change.operation === "upsert_page" &&
          change.page.pageId === input.unchanged!.pageId,
      ),
    ).toBe(false);
  const manifestChanges = confirmationChanges(changes);
  const confirmationManifest = {
    protocolVersion: "3" as const,
    spaceId: input.spaceId,
    baseRevision: input.source.revision,
    capabilitiesHash: input.capabilitiesHash,
    changes: manifestChanges,
  };
  const confirmationHash = await treeConfirmationHashV3(confirmationManifest);
  const requirement = {
    contentHash: added.contentHash,
    sizeBytes: added.sizeBytes,
    mimeType: added.mimeType,
    width: added.width,
    height: added.height,
  };
  const session = await input.v3.createPushSession({
    protocolVersion: "3",
    baseRevision: input.source.revision,
    idempotencyKey: crypto.randomUUID(),
    capabilitiesHash: input.capabilitiesHash,
    confirmationHash,
    confirmationByteLength: canonicalBytes(confirmationManifest).byteLength,
    changeCount: changes.length,
    totalBodyBytes: changes.reduce(
      (total, change) =>
        total +
        (change.operation === "upsert_page"
          ? new TextEncoder().encode(change.page.body).byteLength
          : 0),
      0,
    ),
    attachmentCount: 1,
    transferBlobBytes: PNG.byteLength,
    blobRequirements: [requirement],
  });
  if (session.missingContentHashes.includes(contentHashValue)) {
    const chunkCount = Math.ceil(
      PNG.byteLength / input.capabilities.blobChunkBytes,
    );
    for (let index = 0; index < chunkCount; index += 1)
      await input.v3.uploadBlobChunk(
        session.sessionId,
        contentHashValue,
        index,
        PNG.slice(
          index * input.capabilities.blobChunkBytes,
          (index + 1) * input.capabilities.blobChunkBytes,
        ),
      );
    await input.v3.completeBlob(session.sessionId, requirement, chunkCount);
  }
  const batchWithoutHash = {
    protocolVersion: "3" as const,
    batchIndex: 0,
    changes,
  };
  await input.v3.uploadBatch(session.sessionId, {
    ...batchWithoutHash,
    batchHash: await treeBatchHashV3(batchWithoutHash),
  });
  const finalized = await input.v3.finalize(
    session.sessionId,
    confirmationHash,
  );
  const after = await input.v3.head();
  const published = await readTreeSnapshotV3(
    input.v3,
    input.spaceId,
    finalized.revision,
  );
  const publishedTree: UpgradeTree = {
    protocolVersion: "3",
    spaceId: published.spaceId,
    folders: published.folders,
    pages: published.pages,
    attachments: published.attachments,
  };
  expect(after.sequence).toBe(input.beforeSequence + 1);
  expect(after.revision).toBe(finalized.revision);
  if (input.unchanged)
    expect(
      published.pages.find((page) => page.pageId === input.unchanged!.pageId),
    ).toEqual(input.unchanged);
  expect(published.folders).toEqual(candidate.folders);
  expect(await treeRevisionContentHashV3(publishedTree)).toBe(
    published.revisionContentHash,
  );
  expect(
    published.attachments.map((attachment) => attachment.attachmentId),
  ).toEqual([added.attachmentId]);
  expect(
    await input.v3.downloadBlob({
      revision: finalized.revision,
      attachmentId: added.attachmentId,
      contentHash: added.contentHash,
    }),
  ).toEqual(PNG);
  process.stdout.write(
    `U1_PUBLIC_EVIDENCE ${JSON.stringify({
      case: input.evidenceCase,
      server: live.serverLabel,
      candidateSha: await treeRevisionContentHashV3(candidate),
      before: {
        revision: input.source.revision,
        sequence: input.beforeSequence,
      },
      after: { revision: after.revision, sequence: after.sequence },
      finalizedRevision: finalized.revision,
      fixedPublishedHash: published.revisionContentHash,
      cleanupOwner: live.cleanupOwner,
    })}\n`,
  );
}

describe("public local-first legacy-to-v3 contract", () => {
  it("exposes the owned legacy Spaces through the public v3 mode list", async () => {
    const response = await live.request({
      method: "GET",
      path: "/api/sync/v3/spaces",
      responseType: "bounded-json",
      maxResponseBytes: 2_097_152,
    });
    expect(response.status).toBe(200);
    const rows =
      (response.json as { spaces?: Array<{ spaceId: string }> }).spaces ?? [];
    expect(rows.map((row) => row.spaceId)).toEqual(
      expect.arrayContaining([live.spaceIds.populated, live.spaceIds.empty]),
    );
  });

  it("requires literal zero evidence for the public empty legacy Space", async () => {
    const { v2 } = await remotes(live.spaceIds.empty);
    const before = await v2.head();
    const empty = await readTreeSnapshot(
      v2,
      live.spaceIds.empty,
      before.revision,
    );
    expect(before).toMatchObject({
      revision: "0",
      sequence: 0,
      folderCount: "0",
      pageCount: "0",
      revisionManifestByteLength: "0",
      revisionBodyBytes: "0",
    });
    expect(empty).toMatchObject({ revision: "0", folders: [], pages: [] });
  });

  it("publishes one exact cross-protocol Revision through public session/blob/batch/finalize", async () => {
    const { v2, v3, capabilities, capabilitiesHash } = await remotes(
      live.spaceIds.populated,
    );
    const before = await v2.head();
    const source = await readTreeSnapshot(
      v2,
      live.spaceIds.populated,
      before.revision,
    );
    if (source.protocolVersion !== "2") throw new Error("LIVE_SOURCE_NOT_V2");
    const legacySource = { ...source, protocolVersion: "2" as const };
    const base = await projectLegacyBase(legacySource);
    expect(base.projected.folders).toEqual(source.folders);
    const unchanged = base.projected.pages[0];
    const changed = base.projected.pages[1];
    if (!unchanged || !changed)
      throw new Error("LIVE_POPULATED_FIXTURE_INVALID");

    await publishUpgrade({
      spaceId: source.spaceId,
      source: legacySource,
      unchanged,
      page: changed,
      candidatePages: base.projected.pages,
      v3,
      capabilities,
      capabilitiesHash,
      beforeSequence: before.sequence,
      evidenceCase: "populated",
    });
  });

  it("publishes the first Page and image from a strictly empty legacy Space", async () => {
    const { v2, v3, capabilities, capabilitiesHash } = await remotes(
      live.spaceIds.empty,
    );
    const before = await v2.head();
    const source = await readTreeSnapshot(
      v2,
      live.spaceIds.empty,
      before.revision,
    );
    if (source.protocolVersion !== "2") throw new Error("LIVE_SOURCE_NOT_V2");
    const page = {
      pageId: crypto.randomUUID(),
      folderId: null,
      path: "pages/first.md",
      title: "first",
      body: "first local image",
      contentHash: await contentHash("first local image"),
      updatedAt: "2026-09-06T01:00:00.000Z",
      referencedAttachmentIds: [],
    };
    await publishUpgrade({
      spaceId: source.spaceId,
      source: { ...source, protocolVersion: "2" },
      page,
      candidatePages: [page],
      v3,
      capabilities,
      capabilitiesHash,
      beforeSequence: before.sequence,
      evidenceCase: "empty",
    });
  });
});
