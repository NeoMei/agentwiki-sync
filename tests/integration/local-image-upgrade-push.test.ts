import {
  canonicalBytes,
  treeBatchHashV3,
  treeCapabilitiesHashV3,
  treeConfirmationHashV3,
  treeRevisionContentHashV2,
  treeRevisionContentHashV3,
  type TreePushManifestChangeV3,
  type TreeSyncCapabilitiesV3,
} from "@neomei/agentwiki-sync-protocol";
import { describe, expect, it } from "vitest";

import { AgentWikiClient } from "../../src/agentwiki/client";
import { contentHash } from "../../src/agentwiki/protocol";
import { V3TreeRemote } from "../../src/agentwiki/v3-tree-remote";
import {
  hashUpgradeAuthorization,
  hashUpgradeLocalPlan,
  type UpgradePreview,
  type UpgradeTree,
} from "../../src/application/local-image-upgrade-plan";
import { readTreeSnapshotV3 } from "../../src/application/tree-snapshot-reader";
import {
  LocalImageUpgradeCoordinator,
  type UpgradeCoordinatorPort,
} from "../../src/application/local-image-upgrade";
import {
  TreePushServiceV3,
  type PreparedTreePushChangeV3,
} from "../../src/application/tree-push-service-v3";
import type { TreeSnapshotV3 } from "../../src/core/tree-model";
import {
  LocalImageUpgradeRepository,
  type UpgradeBinding,
  type UpgradeIntent,
} from "../../src/storage/local-image-upgrade";
import { FakeHttp } from "../fakes/fake-http";
import { MemoryControlStore } from "../fakes/memory-control-store";

const ROOT = ".agentwiki/tree/space";
const SOURCE = "revision-v2";
const OPERATION = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const binding: UpgradeBinding = {
  operationId: OPERATION,
  serverInstanceId: "server-1",
  spaceId: "space-1",
  deviceId: "device-1",
  credentialId: "credential-1",
  mappingRootKey: "Wiki",
};

const capabilities: TreeSyncCapabilitiesV3 = {
  maxPageBytes: 1_048_576,
  maxBatchBytes: 4_194_304,
  maxBatchItems: 100,
  maxChangeCount: 100,
  maxConfirmationBytes: 4_194_304,
  maxClientSpacePages: 5_000,
  maxClientSpaceFolders: 5_000,
  maxSnapshotObjects: 10_000,
  maxClientManifestBytes: 4_194_304,
  maxClientTotalBodyBytes: 2_097_152,
  maxDeltaItems: 15_000,
  maxResponseBytes: 4_194_304,
  maxPageItems: 200,
  pushSessionTtlSeconds: 900,
  maxAttachmentBytes: 10 * 1_048_576,
  maxRevisionAttachments: 1_000,
  maxTransferBlobBytes: 100 * 1_048_576,
  blobChunkBytes: 1_048_576,
  maxBlobChunks: 10,
  maxConcurrentBlobs: 2,
  maxImageDimension: 10_000,
  maxDecodedPixels: 40_000_000,
  allowedMimeTypes: ["image/gif", "image/jpeg", "image/png", "image/webp"],
  blobStagingTtlSeconds: 900,
  downloadAuthorizationTtlSeconds: 300,
};

function manifestChange(
  change: PreparedTreePushChangeV3,
): TreePushManifestChangeV3 {
  if (change.operation !== "upsert_page") return structuredClone(change);
  const { payloadPath: _path, bodyBytes: _bytes, ...page } = change.page;
  return { operation: "upsert_page", page };
}

async function makePreview(store: MemoryControlStore): Promise<UpgradePreview> {
  const body = "hello upgrade\n";
  const payloadPath = `${ROOT}/local-image-upgrade/${OPERATION}/payload/page.md`;
  await store.write(payloadPath, body);
  const candidate: UpgradeTree = {
    protocolVersion: "3",
    spaceId: binding.spaceId,
    folders: [],
    pages: [
      {
        pageId: "page-1",
        folderId: null,
        path: "pages/note.md",
        title: "note",
        body,
        contentHash: await contentHash(body),
        updatedAt: "2026-09-06T00:00:00.000Z",
        referencedAttachmentIds: [],
      },
    ],
    attachments: [],
  };
  const candidateHash = await treeRevisionContentHashV3(candidate);
  const legacySourceManifest = {
    protocolVersion: "2" as const,
    spaceId: binding.spaceId,
    folders: [],
    pages: [],
  };
  const sourceV2RevisionHash =
    await treeRevisionContentHashV2(legacySourceManifest);
  const projected = { ...candidate, pages: [], attachments: [] };
  const projectedV3BaseHash = await treeRevisionContentHashV3(projected);
  const capabilitiesHash = await treeCapabilitiesHashV3(capabilities);
  const { body: _body, ...preparedPage } = candidate.pages[0]!;
  const changes: PreparedTreePushChangeV3[] = [
    {
      operation: "upsert_page",
      page: {
        ...preparedPage,
        payloadPath,
        bodyBytes: new TextEncoder().encode(body).byteLength,
      },
    },
  ];
  const confirmationHash = await treeConfirmationHashV3({
    protocolVersion: "3",
    spaceId: binding.spaceId,
    baseRevision: SOURCE,
    capabilitiesHash,
    changes: changes.map(manifestChange),
  });
  const localPlanEvidence = {
    actions: [],
    rawPathStates: {},
    expectedPathStates: {},
    scanEpoch: 7,
    identities: {
      schemaVersion: 2 as const,
      folders: {},
      pendingFolders: {},
      pendingPages: {},
      attachments: {},
      pendingAttachments: {},
    },
  };
  const localPlanHash = await hashUpgradeLocalPlan(localPlanEvidence);
  const fixed = {
    binding,
    sourceRevision: SOURCE,
    sourceV2RevisionHash,
    projectedV3BaseHash,
    oldBaselineEvidenceHash: "3".repeat(64),
    candidateHash,
    localPlanHash,
    confirmationHash,
  };
  return {
    binding,
    remoteBase: {
      sourceProtocolVersion: "2",
      sourceRevision: SOURCE,
      sourceV2RevisionHash: fixed.sourceV2RevisionHash,
      source: {
        ...legacySourceManifest,
        revision: SOURCE,
        revisionContentHash: sourceV2RevisionHash,
      },
      projected,
      projectedV3BaseHash: fixed.projectedV3BaseHash,
    },
    oldBaselineEvidenceHash: fixed.oldBaselineEvidenceHash,
    merge: {} as UpgradePreview["merge"],
    candidate,
    candidateHash,
    localActions: [],
    expectedPathStates: {},
    localPlanEvidence,
    localPlanHash,
    push: {
      protocolVersion: "3",
      spaceId: binding.spaceId,
      baseRevision: SOURCE,
      changes,
      capabilities,
      capabilitiesHash,
      confirmationHash,
      credentialId: binding.credentialId,
      previewId: binding.operationId,
    },
    authorizationHash: await hashUpgradeAuthorization(fixed),
  };
}

function published(preview: UpgradePreview) {
  return {
    protocolVersion: "3",
    status: "published",
    revision: "revision-v3",
    sequence: 2,
    publishedAt: "2026-09-06T00:01:00.000Z",
    revisionContentHash: preview.candidateHash,
    folderCount: "0",
    pageCount: "1",
    attachmentCount: "0",
    revisionManifestByteLength: String(
      canonicalBytes(preview.candidate).byteLength,
    ),
    revisionBodyBytes: "14",
    revisionAttachmentBytes: "0",
    changeSetId: "change-set-1",
  };
}

class ControlledPort implements UpgradeCoordinatorPort {
  revalidations = 0;
  persisted = 0;
  applyError: Error | null = new Error("U5_APPLY_NOT_INSTALLED");
  current = true;
  failRevalidationAt: number | null = null;
  stagedPersistError: Error | null = null;
  private evidencePath: string | null = null;

  constructor(
    private readonly store: MemoryControlStore,
    private readonly push: () => TreePushServiceV3,
    private readonly remote: () => V3TreeRemote,
  ) {}

  async revalidate(_preview: UpgradePreview): Promise<void> {
    this.revalidations += 1;
    if (!this.current || this.revalidations === this.failRevalidationAt)
      throw new Error("BASE_STALE");
  }

  async persistConfirmed(intent: UpgradeIntent, preview: UpgradePreview) {
    this.persisted += 1;
    this.evidencePath = intent.payloadPaths.find((path) =>
      path.endsWith("/confirmed-preview.json"),
    )!;
    await this.store.write(this.evidencePath, JSON.stringify(preview));
    if (this.stagedPersistError) throw this.stagedPersistError;
  }

  async loadConfirmed(intent: UpgradeIntent): Promise<UpgradePreview> {
    this.evidencePath ??= intent.payloadPaths.find((path) =>
      path.endsWith("/confirmed-preview.json"),
    )!;
    const raw = this.evidencePath
      ? await this.store.read(this.evidencePath)
      : null;
    if (!raw) throw new Error("CONFIRMED_PREVIEW_MISSING");
    const preview = JSON.parse(raw) as UpgradePreview;
    expect(await treeCapabilitiesHashV3(preview.push.capabilities)).toBe(
      intent.capabilitiesHash,
    );
    expect(await treeRevisionContentHashV3(preview.candidate)).toBe(
      intent.candidateHash,
    );
    expect(
      await treeRevisionContentHashV2({
        protocolVersion: "2",
        spaceId: preview.remoteBase.source.spaceId,
        folders: preview.remoteBase.source.folders,
        pages: preview.remoteBase.source.pages,
      }),
    ).toBe(intent.sourceV2RevisionHash);
    expect(await treeRevisionContentHashV3(preview.remoteBase.projected)).toBe(
      intent.projectedV3BaseHash,
    );
    expect(await hashUpgradeLocalPlan(preview.localPlanEvidence)).toBe(
      intent.localPlanHash,
    );
    expect(
      await treeConfirmationHashV3({
        protocolVersion: "3",
        spaceId: preview.push.spaceId,
        baseRevision: preview.push.baseRevision,
        capabilitiesHash: preview.push.capabilitiesHash,
        changes: preview.push.changes.map(manifestChange),
      }),
    ).toBe(intent.confirmationHash);
    expect(
      await hashUpgradeAuthorization({
        binding: preview.binding,
        sourceRevision: preview.remoteBase.sourceRevision,
        sourceV2RevisionHash: preview.remoteBase.sourceV2RevisionHash,
        projectedV3BaseHash: preview.remoteBase.projectedV3BaseHash,
        oldBaselineEvidenceHash: preview.oldBaselineEvidenceHash,
        candidateHash: preview.candidateHash,
        localPlanHash: preview.localPlanHash,
        confirmationHash: preview.push.confirmationHash,
      }),
    ).toBe(intent.authorizationHash);
    for (const change of preview.push.changes) {
      if (change.operation !== "upsert_page") continue;
      const body = await this.store.read(change.page.payloadPath);
      expect(body).not.toBeNull();
      expect(await contentHash(body!)).toBe(change.page.contentHash);
    }
    return preview;
  }

  async verifyPublished(intent: UpgradeIntent): Promise<TreeSnapshotV3> {
    const inspected = await this.push().inspect();
    expect(inspected?.remoteState).toBe("published");
    expect(inspected?.result?.revision).toBe("revision-v3");
    return readTreeSnapshotV3(
      this.remote(),
      intent.binding.spaceId,
      inspected!.result!.revision,
    );
  }

  async applyPublished(): Promise<void> {
    if (this.applyError) throw this.applyError;
  }
}

async function harness(
  store = new MemoryControlStore(),
  http = new FakeHttp(),
) {
  const preview = await makePreview(store);
  const repository = new LocalImageUpgradeRepository(store, ROOT, binding);
  const remote = new V3TreeRemote(
    new AgentWikiClient("https://wiki.example.com", http, () => "secret"),
    binding.spaceId,
    {
      version: "3",
      capabilities,
      capabilitiesHash: preview.push.capabilitiesHash,
    },
    { sleep: async () => undefined },
  );
  let coordinator!: LocalImageUpgradeCoordinator;
  let push!: TreePushServiceV3;
  const local = {
    calls: 0,
    hashes: [] as string[],
  };
  const port = new ControlledPort(
    store,
    () => push,
    () => remote,
  );
  push = new TreePushServiceV3(
    remote,
    store,
    `${ROOT}/local-image-upgrade/${OPERATION}/push`,
    {
      readBlob: async () => null,
      revalidateConfirmation: async () => {
        const value =
          local.hashes[local.calls] ?? preview.push.confirmationHash;
        local.calls += 1;
        return value;
      },
    },
    {
      operationId: OPERATION,
      assertSourceCurrent: (revision) =>
        coordinator.assertSourceCurrent(revision),
      onStaged: () => coordinator.onPushStaged(),
    },
  );
  coordinator = new LocalImageUpgradeCoordinator(repository, push, port);
  return { store, http, preview, repository, push, port, local, coordinator };
}

function createResponse(
  status: "uploading" | "ready_to_finalize" | "published",
) {
  return {
    protocolVersion: "3",
    sessionId: SESSION,
    status,
    expiresAt: "2099-01-01T00:00:00.000Z",
    missingContentHashes: [],
  };
}

function statusResponse(preview: UpgradePreview, status: "published") {
  return {
    ...createResponse(status),
    completedContentHashes: [],
    receivedBatchIndexes: [0],
    result: published(preview),
  };
}

function snapshotResponse(preview: UpgradePreview) {
  const result = published(preview);
  return {
    protocolVersion: "3",
    spaceId: preview.binding.spaceId,
    revision: result.revision,
    sequence: result.sequence,
    revisionContentHash: result.revisionContentHash,
    folderCount: result.folderCount,
    pageCount: result.pageCount,
    attachmentCount: result.attachmentCount,
    revisionManifestByteLength: result.revisionManifestByteLength,
    revisionBodyBytes: result.revisionBodyBytes,
    revisionAttachmentBytes: result.revisionAttachmentBytes,
    folders: preview.candidate.folders,
    pages: preview.candidate.pages,
    attachments: preview.candidate.attachments,
    nextCursor: null,
  };
}

async function batchResponse(preview: UpgradePreview) {
  const change = preview.push.changes[0]!;
  if (change.operation !== "upsert_page") throw new Error("fixture");
  const { payloadPath: _path, bodyBytes: _bytes, ...page } = change.page;
  const batch = {
    protocolVersion: "3" as const,
    batchIndex: 0,
    changes: [
      {
        operation: "upsert_page" as const,
        page: { ...page, body: "hello upgrade\n" },
      },
    ],
  };
  return {
    protocolVersion: "3",
    sessionId: SESSION,
    batchIndex: 0,
    batchHash: await treeBatchHashV3(batch),
    receipt: "batch-0",
    receivedBatchCount: 1,
  };
}

describe("LocalImageUpgradeCoordinator owned Push", () => {
  it("rejects a mismatched authorization before persistence or session creation", async () => {
    const fixture = await harness();
    await expect(
      fixture.coordinator.confirm(fixture.preview, "f".repeat(64)),
    ).rejects.toThrow("UPGRADE_AUTHORIZATION_MISMATCH");
    expect(fixture.port.persisted).toBe(0);
    expect(await fixture.repository.read()).toBeNull();
    expect(fixture.http.calls).toEqual([]);
  });

  it("does not derive a Push child when confirmed intent persistence fails", async () => {
    const fixture = await harness();
    fixture.store.onTextWrite = (path) => {
      if (path.endsWith("/local-image-upgrade/journal.json.next"))
        throw new Error("parent intent write failed");
    };
    await expect(
      fixture.coordinator.confirm(
        fixture.preview,
        fixture.preview.authorizationHash,
      ),
    ).rejects.toThrow("parent intent write failed");
    expect(await fixture.push.inspect()).toBeNull();
    expect(fixture.http.calls).toEqual([]);
  });

  it("supersedes both owned journals when another device advances before create", async () => {
    const fixture = await harness();
    fixture.port.failRevalidationAt = 2;
    await expect(
      fixture.coordinator.confirm(
        fixture.preview,
        fixture.preview.authorizationHash,
      ),
    ).rejects.toThrow("BASE_STALE");
    expect(await fixture.push.inspect()).toMatchObject({
      remoteState: "superseded",
    });
    expect((await fixture.repository.read())?.phase).toBe("superseded");
    expect(fixture.http.calls).toEqual([]);
  });

  it.each([
    ["permission", "PERMISSION_REVOKED"],
    ["capabilities", "CAPABILITIES_CHANGED"],
    ["local input", "CONFIRMATION_MISMATCH"],
  ])(
    "rejects fresh %s drift before create without any remote write",
    async (_kind, code) => {
      const fixture = await harness();
      fixture.port.failRevalidationAt = 2;
      fixture.port.current = true;
      const original = fixture.port.revalidate.bind(fixture.port);
      fixture.port.revalidate = async (preview) => {
        try {
          await original(preview);
        } catch {
          throw new Error(code);
        }
      };
      await expect(
        fixture.coordinator.confirm(
          fixture.preview,
          fixture.preview.authorizationHash,
        ),
      ).rejects.toThrow(code);
      expect(fixture.http.calls).toEqual([]);
      const intent = await fixture.repository.read();
      expect(intent?.phase).not.toBe("complete");
      expect(intent).toMatchObject({
        confirmationHash: fixture.preview.push.confirmationHash,
        pushOperationId: OPERATION,
        authorizationHash: fixture.preview.authorizationHash,
      });
      expect(new Set(intent!.payloadPaths).size).toBe(
        intent!.payloadPaths.length,
      );
      await expect(
        fixture.store.read(
          intent!.payloadPaths.find((path) =>
            path.endsWith("/confirmed-preview.json"),
          )!,
        ),
      ).resolves.not.toBeNull();
    },
  );

  it("leaves a confirmed parent and staged child recoverable when onStaged fails", async () => {
    const fixture = await harness();
    fixture.store.onTextWrite = (path) => {
      if (path.endsWith(`/${OPERATION}/push/journal.json.next`))
        fixture.store.failNextTextWriteAt = `${ROOT}/local-image-upgrade/journal.json.next`;
    };
    await expect(
      fixture.coordinator.confirm(
        fixture.preview,
        fixture.preview.authorizationHash,
      ),
    ).rejects.toThrow("injected text write failure");
    expect((await fixture.repository.read())?.phase).toBe("confirmed");
    expect(await fixture.push.inspect()).toMatchObject({
      remoteState: "not_created",
    });
    expect(fixture.http.calls).toEqual([]);

    fixture.store.onTextWrite = undefined;
    fixture.http.enqueue({ status: 200, json: createResponse("published") });
    fixture.http.enqueue({
      status: 200,
      json: statusResponse(fixture.preview, "published"),
    });
    fixture.http.enqueue({
      status: 200,
      json: snapshotResponse(fixture.preview),
    });
    const restarted = await harness(fixture.store, fixture.http);
    await expect(restarted.coordinator.recover()).rejects.toThrow(
      "U5_APPLY_NOT_INSTALLED",
    );
    expect((await restarted.repository.read())?.phase).toBe("local_pending");
    expect(
      fixture.http.calls.filter(
        (call) =>
          call.method === "POST" && call.path.endsWith("/push-sessions"),
      ),
    ).toHaveLength(1);
  });

  it("revalidates caps and local authorization again before immediate finalize", async () => {
    const fixture = await harness();
    fixture.local.hashes.push(
      fixture.preview.push.confirmationHash,
      "f".repeat(64),
    );
    fixture.http.enqueue({
      status: 200,
      json: createResponse("ready_to_finalize"),
    });
    await expect(
      fixture.coordinator.confirm(
        fixture.preview,
        fixture.preview.authorizationHash,
      ),
    ).rejects.toThrow("CONFIRMATION_MISMATCH");
    expect(fixture.local.calls).toBe(2);
    expect(
      fixture.http.calls.filter((call) => call.path.endsWith("/finalize")),
    ).toEqual([]);
    expect((await fixture.repository.read())?.phase).toBe("remote_pending");
  });

  it("revalidates fresh upgrade authority again before immediate finalize", async () => {
    const fixture = await harness();
    fixture.port.failRevalidationAt = 3;
    const original = fixture.port.revalidate.bind(fixture.port);
    fixture.port.revalidate = async (preview) => {
      try {
        await original(preview);
      } catch {
        throw new Error("CAPABILITIES_CHANGED");
      }
    };
    fixture.http.enqueue({
      status: 200,
      json: createResponse("ready_to_finalize"),
    });
    await expect(
      fixture.coordinator.confirm(
        fixture.preview,
        fixture.preview.authorizationHash,
      ),
    ).rejects.toThrow("CAPABILITIES_CHANGED");
    expect(fixture.port.revalidations).toBe(3);
    expect(
      fixture.http.calls.filter((call) => call.path.endsWith("/finalize")),
    ).toEqual([]);
    expect((await fixture.repository.read())?.phase).toBe("remote_pending");
  });

  it("restarts a lost create response with the same owned idempotency key", async () => {
    const fixture = await harness();
    fixture.http.enqueue({
      status: 503,
      json: {
        protocolVersion: "3",
        error: { code: "INTERNAL_ERROR", retryable: true },
      },
    });
    await expect(
      fixture.coordinator.confirm(
        fixture.preview,
        fixture.preview.authorizationHash,
      ),
    ).rejects.toThrow();
    expect((await fixture.repository.read())?.phase).toBe("remote_pending");

    fixture.http.enqueue({ status: 200, json: createResponse("published") });
    fixture.http.enqueue({
      status: 200,
      json: statusResponse(fixture.preview, "published"),
    });
    fixture.http.enqueue({
      status: 200,
      json: snapshotResponse(fixture.preview),
    });
    const restarted = await harness(fixture.store, fixture.http);
    await expect(restarted.coordinator.recover()).rejects.toThrow(
      "U5_APPLY_NOT_INSTALLED",
    );
    const createBodies = fixture.http.calls
      .filter(
        (call) =>
          call.method === "POST" && call.path.endsWith("/push-sessions"),
      )
      .map((call) => call.body as { idempotencyKey: string });
    expect(new Set(createBodies.map((body) => body.idempotencyKey)).size).toBe(
      1,
    );
    expect(createBodies[0]?.idempotencyKey).toBe(OPERATION);
    expect((await restarted.repository.read())?.phase).toBe("local_pending");
  });

  it("keeps a lost-create operation pending when the source advances before recovery", async () => {
    const fixture = await harness();
    fixture.http.enqueue({
      status: 503,
      json: {
        protocolVersion: "3",
        error: { code: "INTERNAL_ERROR", retryable: true },
      },
    });
    await expect(
      fixture.coordinator.confirm(
        fixture.preview,
        fixture.preview.authorizationHash,
      ),
    ).rejects.toThrow();
    const restarted = await harness(fixture.store, fixture.http);
    restarted.port.current = false;
    await expect(restarted.coordinator.recover()).rejects.toThrow("BASE_STALE");
    expect((await restarted.repository.read())?.phase).toBe("remote_pending");
    expect(await restarted.push.inspect()).toMatchObject({
      remoteState: "not_created",
    });
    const createBodies = fixture.http.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/push-sessions"),
    );
    expect(createBodies).toHaveLength(1);
  });

  it("treats cancellation before create as proven superseded without HTTP", async () => {
    const fixture = await harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      fixture.coordinator.confirm(
        fixture.preview,
        fixture.preview.authorizationHash,
        { signal: controller.signal },
      ),
    ).rejects.toThrow("同步已取消");
    expect(fixture.http.calls).toEqual([]);
    expect(await fixture.push.inspect()).toMatchObject({
      remoteState: "superseded",
    });
    expect((await fixture.repository.read())?.phase).toBe("superseded");
  });

  it("keeps an owned cancellation pending when abort and status are unknown", async () => {
    const fixture = await harness();
    const controller = new AbortController();
    fixture.http.enqueue({ status: 200, json: createResponse("uploading") });
    fixture.http.enqueue({
      status: 200,
      json: await batchResponse(fixture.preview),
    });
    for (let index = 0; index < 2; index += 1)
      fixture.http.enqueue({
        status: 503,
        json: {
          protocolVersion: "3",
          error: { code: "INTERNAL_ERROR", retryable: true },
        },
      });
    await expect(
      fixture.coordinator.confirm(
        fixture.preview,
        fixture.preview.authorizationHash,
        {
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.phase === "upload_changes") controller.abort();
          },
        },
      ),
    ).rejects.toThrow("同步已取消");
    expect(await fixture.push.inspect()).toMatchObject({
      remoteState: "uploading_changes",
    });
    expect((await fixture.repository.read())?.phase).toBe("remote_pending");
    expect(
      fixture.http.calls.filter(
        (call) =>
          call.method === "POST" && call.path.endsWith("/push-sessions"),
      ),
    ).toHaveLength(1);
    expect(
      fixture.http.calls.filter((call) => call.path.endsWith("/finalize")),
    ).toEqual([]);
  });

  it("accepts a published race discovered while cancelling without a second publication", async () => {
    const fixture = await harness();
    const controller = new AbortController();
    fixture.http.enqueue({ status: 200, json: createResponse("uploading") });
    fixture.http.enqueue({
      status: 200,
      json: await batchResponse(fixture.preview),
    });
    fixture.http.enqueue({
      status: 503,
      json: {
        protocolVersion: "3",
        error: { code: "INTERNAL_ERROR", retryable: true },
      },
    });
    fixture.http.enqueue({
      status: 200,
      json: statusResponse(fixture.preview, "published"),
    });
    await expect(
      fixture.coordinator.confirm(
        fixture.preview,
        fixture.preview.authorizationHash,
        {
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.phase === "upload_changes") controller.abort();
          },
        },
      ),
    ).rejects.toThrow("同步已取消");
    expect(await fixture.push.inspect()).toMatchObject({
      remoteState: "published",
      result: { revision: "revision-v3" },
    });

    fixture.http.enqueue({
      status: 200,
      json: snapshotResponse(fixture.preview),
    });
    const restarted = await harness(fixture.store, fixture.http);
    restarted.port.current = false;
    await expect(restarted.coordinator.recover()).rejects.toThrow(
      "U5_APPLY_NOT_INSTALLED",
    );
    expect((await restarted.repository.read())?.phase).toBe("local_pending");
    expect(
      fixture.http.calls.filter(
        (call) =>
          call.method === "POST" && call.path.endsWith("/push-sessions"),
      ),
    ).toHaveLength(1);
    expect(
      fixture.http.calls.filter((call) => call.path.endsWith("/finalize")),
    ).toEqual([]);
  });

  it("queries the original session after a lost finalize response and never finalizes twice", async () => {
    const fixture = await harness();
    fixture.http.enqueue({
      status: 200,
      json: createResponse("ready_to_finalize"),
    });
    fixture.http.enqueue({
      status: 503,
      json: {
        protocolVersion: "3",
        error: { code: "INTERNAL_ERROR", retryable: true },
      },
    });
    await expect(
      fixture.coordinator.confirm(
        fixture.preview,
        fixture.preview.authorizationHash,
      ),
    ).rejects.toThrow();

    fixture.http.enqueue({
      status: 200,
      json: statusResponse(fixture.preview, "published"),
    });
    fixture.http.enqueue({
      status: 200,
      json: snapshotResponse(fixture.preview),
    });
    const restarted = await harness(fixture.store, fixture.http);
    await expect(restarted.coordinator.recover()).rejects.toThrow(
      "U5_APPLY_NOT_INSTALLED",
    );
    const finalizeCallsAfterPublishedRecovery = fixture.http.calls.filter(
      (call) => call.path.endsWith(`/${SESSION}/finalize`),
    ).length;
    expect(finalizeCallsAfterPublishedRecovery).toBe(1);
    expect(
      fixture.http.calls.filter((call) => call.path.endsWith(`/${SESSION}`)),
    ).toHaveLength(1);
  });

  it("does not turn a late cancel after finalize starts into unpublished", async () => {
    const fixture = await harness();
    const controller = new AbortController();
    fixture.http.enqueue({
      status: 200,
      json: createResponse("ready_to_finalize"),
    });
    fixture.http.enqueue({
      status: 200,
      json: published(fixture.preview),
    });
    fixture.http.enqueue({
      status: 200,
      json: snapshotResponse(fixture.preview),
    });
    await expect(
      fixture.coordinator.confirm(
        fixture.preview,
        fixture.preview.authorizationHash,
        {
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.phase === "finalize") controller.abort();
          },
        },
      ),
    ).rejects.toThrow("U5_APPLY_NOT_INSTALLED");
    expect(await fixture.push.inspect()).toMatchObject({
      remoteState: "published",
      result: { revision: "revision-v3" },
    });
    expect((await fixture.repository.read())?.phase).toBe("local_pending");
    expect(
      fixture.http.calls.filter((call) => call.method === "DELETE"),
    ).toEqual([]);
  });

  it.each(["aborted", "expired"] as const)(
    "supersedes only after the original session is authoritatively %s",
    async (terminal) => {
      const fixture = await harness();
      fixture.http.enqueue({
        status: 200,
        json: createResponse("ready_to_finalize"),
      });
      fixture.http.enqueue({
        status: 503,
        json: {
          protocolVersion: "3",
          error: { code: "INTERNAL_ERROR", retryable: true },
        },
      });
      await expect(
        fixture.coordinator.confirm(
          fixture.preview,
          fixture.preview.authorizationHash,
        ),
      ).rejects.toThrow();
      fixture.http.enqueue({
        status: 200,
        json: {
          ...createResponse("ready_to_finalize"),
          status: terminal,
          completedContentHashes: [],
          receivedBatchIndexes: [0],
          result: null,
        },
      });
      const restarted = await harness(fixture.store, fixture.http);
      await expect(restarted.coordinator.recover()).resolves.toBeUndefined();
      expect(await restarted.push.inspect()).toMatchObject({
        remoteState: "superseded",
      });
      expect((await restarted.repository.read())?.phase).toBe("superseded");
    },
  );

  it("does not re-finalize an original session whose outcome remains unknown", async () => {
    const fixture = await harness();
    fixture.http.enqueue({
      status: 200,
      json: createResponse("ready_to_finalize"),
    });
    fixture.http.enqueue({
      status: 503,
      json: {
        protocolVersion: "3",
        error: { code: "INTERNAL_ERROR", retryable: true },
      },
    });
    await expect(
      fixture.coordinator.confirm(
        fixture.preview,
        fixture.preview.authorizationHash,
      ),
    ).rejects.toThrow();
    fixture.http.enqueue({
      status: 200,
      json: {
        ...createResponse("ready_to_finalize"),
        status: "finalizing",
        completedContentHashes: [],
        receivedBatchIndexes: [0],
        result: null,
      },
    });
    const restarted = await harness(fixture.store, fixture.http);
    await expect(restarted.coordinator.recover()).rejects.toThrow(
      "UPGRADE_PUBLICATION_PENDING",
    );
    expect(
      fixture.http.calls.filter((call) =>
        call.path.endsWith(`/${SESSION}/finalize`),
      ),
    ).toHaveLength(1);
    expect((await restarted.repository.read())?.phase).toBe("remote_pending");
  });

  it("fails closed when a remote_pending parent loses its owned child journal", async () => {
    const fixture = await harness();
    fixture.http.enqueue({
      status: 503,
      json: {
        protocolVersion: "3",
        error: { code: "INTERNAL_ERROR", retryable: true },
      },
    });
    await expect(
      fixture.coordinator.confirm(
        fixture.preview,
        fixture.preview.authorizationHash,
      ),
    ).rejects.toThrow();
    await fixture.store.removeTree(
      `${ROOT}/local-image-upgrade/${OPERATION}/push`,
    );
    const restarted = await harness(fixture.store, fixture.http);
    await expect(restarted.coordinator.recover()).rejects.toThrow(
      "Local image upgrade Push journal is missing",
    );
    expect(fixture.http.calls).toHaveLength(1);
  });
});
