import {
  treeCapabilitiesHashV3,
  treeConfirmationHashV3,
  treeRevisionContentHashV2,
  treeRevisionContentHashV3,
} from "@neomei/agentwiki-sync-protocol";
import { describe, expect, it } from "vitest";

import { contentHash, sha256Hex } from "../../src/agentwiki/protocol";
import { UpgradeLocalApply } from "../../src/application/local-image-upgrade-local";
import {
  expectedV3PathStates,
  hashUpgradeAuthorization,
  hashUpgradeLocalPlan,
  type UpgradePreview,
} from "../../src/application/local-image-upgrade-plan";
import {
  LocalImageUpgradeCoordinator,
  type UpgradeCoordinatorPort,
} from "../../src/application/local-image-upgrade";
import { buildTreeCalculationPreviewV3 } from "../../src/application/tree-diff";
import { desiredV3Identities } from "../../src/application/tree-local-apply-v3";
import {
  isTreePushJournalV3,
  TreePushServiceV3,
} from "../../src/application/tree-push-service-v3";
import { isTreeTransactionJournal } from "../../src/application/tree-transaction";
import type { TreeSnapshotV3 } from "../../src/core/tree-model";
import { scanLocalTree } from "../../src/core/tree-scan";
import { TreeBaselineRepository } from "../../src/storage/tree-baseline";
import { MutableControlRepository } from "../../src/storage/envelope";
import {
  TreeIdentityRepository,
  emptyTreeIdentityStateV2,
} from "../../src/storage/tree-identities";
import type { UpgradeIntent } from "../../src/storage/local-image-upgrade";
import { LocalImageUpgradeRepository } from "../../src/storage/local-image-upgrade";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { MemoryVault } from "../fakes/memory-vault";
import { FakeTreeRemoteV3 } from "../fakes/fake-tree-remote";

const ROOT = ".agentwiki/devices/d-device/spaces/s-space";
const OPERATION = "11111111-1111-4111-8111-111111111111";
const BYTES = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
  0, 0, 1, 8, 6, 0, 0, 0, 0, 0, 0, 0,
]);

class FaultStore extends MemoryControlStore {
  failRemovePath: string | null = null;
  failRemoveTreePath: string | null = null;
  failRemoveTreeOnCall = 1;
  removeTreeCalls = new Map<string, number>();
  override async remove(path: string): Promise<void> {
    if (path === this.failRemovePath) {
      this.failRemovePath = null;
      throw new Error("injected terminal cleanup failure");
    }
    await super.remove(path);
  }
  override async removeTree(path: string): Promise<void> {
    const calls = (this.removeTreeCalls.get(path) ?? 0) + 1;
    this.removeTreeCalls.set(path, calls);
    if (
      path === this.failRemoveTreePath &&
      calls === this.failRemoveTreeOnCall
    ) {
      this.failRemoveTreePath = null;
      throw new Error("injected Blob staging cleanup failure");
    }
    await super.removeTree(path);
  }
}

async function fixture() {
  const body = "note\n![](../assets/used.png)\n";
  const attachmentHash = await sha256Hex(BYTES);
  const candidate = {
    protocolVersion: "3" as const,
    spaceId: "space",
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
        referencedAttachmentIds: ["attachment-1"],
      },
    ],
    attachments: [
      {
        attachmentId: "attachment-1",
        path: "assets/used.png",
        mimeType: "image/png" as const,
        sizeBytes: String(BYTES.byteLength),
        width: 1,
        height: 1,
        contentHash: attachmentHash,
        updatedAt: "2026-09-06T00:00:00.000Z",
      },
    ],
  };
  const candidateHash = await treeRevisionContentHashV3(candidate);
  const snapshot: TreeSnapshotV3 = {
    ...candidate,
    revision: "published-r3",
    revisionContentHash: candidateHash,
  };
  const remote = new FakeTreeRemoteV3();
  await remote.seedTree({
    revision: snapshot.revision,
    pages: snapshot.pages,
    attachments: snapshot.attachments,
    blobs: { "attachment-1": BYTES },
  });
  const store = new MemoryControlStore();
  const vault = new MemoryVault({
    "Wiki/pages/old-note.md": "old\n",
    "Wiki/assets/unused.png": "keep",
  });
  const intent = {
    schemaVersion: 1 as const,
    binding: {
      operationId: OPERATION,
      serverInstanceId: "server",
      spaceId: "space",
      deviceId: "device",
      credentialId: "credential",
      mappingRootKey: "Wiki",
    },
    sourceRevision: "legacy-r2",
    sourceV2RevisionHash: "1".repeat(64),
    oldBaselineEvidenceHash: "2".repeat(64),
    projectedV3BaseHash: "3".repeat(64),
    capabilitiesHash: "4".repeat(64),
    confirmationHash: "5".repeat(64),
    candidateHash,
    localPlanHash: "6".repeat(64),
    authorizationHash: "7".repeat(64),
    payloadPaths: [],
    pushOperationId: OPERATION,
    localTransactionId: "local-tx",
    phase: "local_pending" as const,
    verifiedPublication: {
      revision: snapshot.revision,
      revisionContentHash: candidateHash,
    },
  } satisfies UpgradeIntent;
  const oldHash = await sha256Hex(new TextEncoder().encode("old\n"));
  const identities = emptyTreeIdentityStateV2();
  const pagePayload = `${ROOT}/local-image-upgrade/${OPERATION}/payload/page.md`;
  await store.write(pagePayload, body);
  const actions = [
    {
      kind: "move_page" as const,
      pageId: "page-1",
      fromPath: "pages/old-note.md",
      path: "pages/note.md",
      bodyPath: "tree-preview-body/page-1.md",
    },
    {
      kind: "create_attachment" as const,
      attachment: candidate.attachments[0]!,
      source: "remote" as const,
    },
  ];
  const expectedPathStates = {
    "Wiki/pages/old-note.md": { kind: "file" as const, hash: oldHash },
    "Wiki/pages/note.md": { kind: "missing" as const, hash: null },
    "Wiki/assets/used.png": { kind: "missing" as const, hash: null },
  };
  const preview = {
    candidate,
    localActions: actions,
    expectedPathStates,
    localPlanEvidence: {
      actions,
      rawPathStates: {},
      expectedPathStates,
      scanEpoch: 1,
      identities,
    },
    push: {
      changes: [
        {
          operation: "upsert_page",
          page: {
            ...candidate.pages[0]!,
            payloadPath: pagePayload,
            bodyBytes: new TextEncoder().encode(body).byteLength,
          },
        },
      ],
    },
    merge: {
      revision: snapshot.revision,
      base: { attachments: [] },
      remote: candidate,
      local: { rootPath: "Wiki" },
      resolvedFolders: candidate.folders,
      resolvedPages: candidate.pages,
      resolvedAttachments: candidate.attachments,
    },
  } as unknown as UpgradePreview;
  const capabilities = await remote.capabilities();
  const pushRoot = `${ROOT}/local-image-upgrade/${OPERATION}/push`;
  const push = new TreePushServiceV3(remote, store, pushRoot, {
    readBlob: async () => null,
    revalidateConfirmation: async () => intent.confirmationHash,
  });
  const { spaceId: _spaceId, ...publishedHead } = await remote.head();
  await new MutableControlRepository(
    store,
    `${pushRoot}/journal.json`,
    isTreePushJournalV3,
  ).write({
    schemaVersion: 3,
    protocolVersion: "3",
    spaceId: "space",
    baseRevision: intent.sourceRevision,
    idempotencyKey: OPERATION,
    confirmationHash: intent.confirmationHash,
    capabilitiesHash: intent.capabilitiesHash,
    capabilities,
    changes: [],
    requiredBlobs: {},
    blobRequirements: [],
    totalBodyBytes: 0,
    attachmentCount: 0,
    transferBlobBytes: 0,
    sessionId: "session-1",
    credentialIdAtCreation: "credential",
    remoteState: "published",
    result: {
      ...publishedHead,
      status: "published",
      changeSetId: "change-1",
    },
    localCommitPhase: "not_started",
  });
  const confirmedPath = `${ROOT}/local-image-upgrade/${OPERATION}/payload/confirmed-preview.json`;
  await store.write(confirmedPath, JSON.stringify(preview));
  const local = new UpgradeLocalApply({
    remote,
    push,
    control: store,
    controlRoot: ROOT,
    baseline: new TreeBaselineRepository(store, ROOT, "space", "Wiki"),
    identities: new TreeIdentityRepository(
      store,
      `${ROOT}/tree-identities.json`,
    ),
    vault,
    loadConfirmed: async () =>
      JSON.parse((await store.read(confirmedPath))!) as UpgradePreview,
  });
  return { local, remote, vault, intent, snapshot, store };
}

describe("UpgradeLocalApply", () => {
  it("keeps a locally resolved page pending when it differs from the published remote page", async () => {
    const { snapshot } = await fixture();
    const resolvedPage = {
      ...snapshot.pages[0]!,
      body: "locally resolved\n",
      contentHash: await contentHash("locally resolved\n"),
    };

    const desired = desiredV3Identities(emptyTreeIdentityStateV2(), {
      revision: snapshot.revision,
      base: { attachments: [] },
      remote: snapshot,
      resolvedFolders: [],
      resolvedPages: [resolvedPage],
      resolvedAttachments: snapshot.attachments,
    });

    expect(desired.pendingPages[resolvedPage.pageId]).toEqual({
      pageId: resolvedPage.pageId,
      path: resolvedPage.path,
      contentHash: resolvedPage.contentHash,
    });
  });

  it("reads the published child revision even after current advances and validates bytes before Vault writes", async () => {
    const { local, remote, vault, intent, snapshot } = await fixture();
    const requested: string[] = [];
    const original = remote.snapshotPages.bind(remote);
    remote.snapshotPages = async function* (revision?: string) {
      requested.push(revision ?? "current");
      yield* original(revision);
    };

    await expect(local.verifyPublished(intent)).resolves.toEqual(snapshot);
    expect(requested).toEqual(["published-r3"]);
    expect(remote.downloads).toEqual([
      {
        revision: "published-r3",
        attachmentId: "attachment-1",
        contentHash: snapshot.attachments[0]!.contentHash,
      },
    ]);
    expect(vault.operationLog).toEqual([]);
  });

  it("rejects a mismatched downloaded attachment without writing the Vault", async () => {
    const { local, remote, vault, intent } = await fixture();
    remote.downloadBlob = async () => Uint8Array.of(1, 2, 3);

    await expect(local.verifyPublished(intent)).rejects.toThrow(
      "DOWNLOAD_HASH_MISMATCH",
    );
    expect(vault.operationLog).toEqual([]);
  });

  it("rejects published page metadata that differs from the confirmed candidate before Vault writes", async () => {
    const { local, remote, vault, intent, snapshot } = await fixture();
    await remote.seedTree({
      revision: snapshot.revision,
      pages: [{ ...snapshot.pages[0]!, title: "changed-after-confirmation" }],
      attachments: snapshot.attachments,
      blobs: { "attachment-1": BYTES },
    });

    await expect(local.verifyPublished(intent)).rejects.toThrow(
      "UPGRADE_PUBLISHED_SNAPSHOT_MISMATCH",
    );
    expect(remote.downloads).toEqual([]);
    expect(vault.operationLog).toEqual([]);
  });

  it("rejects a same-id local transaction whose fixed publication evidence differs", async () => {
    const { local, intent, snapshot, store } = await fixture();
    await local.verifyPublished(intent);
    await new MutableControlRepository(
      store,
      `${ROOT}/local-image-upgrade/${OPERATION}/local/journal.json`,
      isTreeTransactionJournal,
    ).write({
      schemaVersion: 3,
      transactionId: intent.localTransactionId,
      baseRevision: "foreign-base",
      targetRevision: snapshot.revision,
      targetTreeHash: snapshot.revisionContentHash,
      state: "prepared",
      nextOperation: 0,
      operations: [],
      deferCommit: true,
    });

    await expect(local.applyPublished(intent, snapshot)).rejects.toThrow(
      "UPGRADE_LOCAL_TRANSACTION_OWNERSHIP_MISMATCH",
    );
  });

  it.each([
    { boundary: "image Vault write", vaultFailureAt: 1 },
    { boundary: "page Vault write", vaultFailureAt: 2 },
    { boundary: "page rename", rename: true, vaultFailureAt: 2 },
    {
      boundary: "late edit after image write",
      lateEdit: true,
      vaultFailureAt: 1,
    },
    {
      boundary: "transaction journal",
      storagePath: "/local/journal.json.next",
    },
    {
      boundary: "staged identity",
      storagePath: "/local/control-after.json.next",
    },
    {
      boundary: "baseline journal",
      storagePath: "/tree-v2/baseline-journal.json.next",
    },
    {
      boundary: "identity commit",
      storagePath: "/tree-identities.json.next",
    },
    { boundary: "baseline pointer", storagePath: "/tree-v2/current.json.next" },
    { boundary: "parent terminal cleanup", cleanupFailure: true },
    { boundary: "Blob terminal cleanup", blobCleanupFailure: true },
  ])(
    "rebuilds real repositories after $boundary interruption without finalizing twice",
    async (options) => {
      const run = async (options: {
        boundary: string;
        lateEdit?: boolean;
        vaultFailureAt?: number;
        storagePath?: string;
        cleanupFailure?: boolean;
        blobCleanupFailure?: boolean;
        rename?: boolean;
      }) => {
        const store = new FaultStore();
        const vault = new MemoryVault({
          "Wiki/assets/source.png": "source",
          "Wiki/assets/unused.png": "keep",
        });
        vault.seedFile("Wiki/assets/source.png", BYTES);
        const remote = new FakeTreeRemoteV3();
        await remote.seedTree({ revision: "legacy-r2" });
        const capabilities = await remote.capabilities();
        const binding = {
          operationId: OPERATION,
          serverInstanceId: "server",
          spaceId: "space",
          deviceId: "device",
          credentialId: "credential",
          mappingRootKey: "Wiki",
        };
        const identities = emptyTreeIdentityStateV2();
        const seededIdentities = new TreeIdentityRepository(
          store,
          `${ROOT}/tree-identities.json`,
        );
        await seededIdentities.commitConfirmedV3Activation();
        await seededIdentities.write(identities);
        const localScan = await scanLocalTree(
          vault,
          "Wiki",
          {
            protocolVersion: "3",
            spaceId: "space",
            revision: "legacy-r2",
            revisionContentHash: await treeRevisionContentHashV3({
              protocolVersion: "3",
              spaceId: "space",
              folders: [],
              pages: [],
              attachments: [],
            }),
            folders: [],
            pages: [],
            attachments: [],
          },
          identities,
          {
            ...capabilities,
            maxFolders: capabilities.maxClientSpaceFolders,
            maxPages: capabilities.maxClientSpacePages,
          },
        );
        const body = "new\n![[assets/used.png]]\n";
        const attachmentHash = await sha256Hex(BYTES);
        const target = {
          protocolVersion: "3" as const,
          spaceId: "space",
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
              referencedAttachmentIds: ["attachment-1"],
            },
          ],
          attachments: [
            {
              attachmentId: "attachment-1",
              path: "assets/used.png",
              mimeType: "image/png" as const,
              sizeBytes: String(BYTES.byteLength),
              width: 1,
              height: 1,
              contentHash: attachmentHash,
              updatedAt: "2026-09-06T00:00:00.000Z",
            },
          ],
        };
        const projected = {
          protocolVersion: "3" as const,
          spaceId: "space",
          folders: [],
          pages: [],
          attachments: [],
        };
        const merge = await buildTreeCalculationPreviewV3(
          projected,
          localScan,
          target,
          "published-r3",
        );
        if (options.rename) {
          const createIndex = merge.actions.findIndex(
            (action) => action.kind === "create_page",
          );
          const create = merge.actions[createIndex];
          if (!create || create.kind !== "create_page")
            throw new Error("rename fixture requires a page create action");
          vault.seedMarkdown("Wiki/pages/old-note.md", body);
          merge.actions[createIndex] = {
            kind: "move_page",
            pageId: create.pageId,
            fromPath: "pages/old-note.md",
            path: create.path,
            bodyPath: create.bodyPath,
          };
          localScan.rawPathStates["pages/old-note.md"] = {
            kind: "file",
            hash: await sha256Hex(new TextEncoder().encode(body)),
          };
        }
        const candidate = {
          protocolVersion: "3" as const,
          spaceId: "space",
          folders: merge.resolvedFolders,
          pages: merge.resolvedPages,
          attachments: merge.resolvedAttachments,
        };
        const candidateHash = await treeRevisionContentHashV3(candidate);
        const payloadPath = `${ROOT}/local-image-upgrade/${OPERATION}/payload/page.md`;
        await store.write(payloadPath, body);
        const page = candidate.pages[0]!;
        const { body: _body, ...pageMetadata } = page;
        const changes = [
          {
            operation: "upsert_attachment" as const,
            attachment: candidate.attachments[0]!,
            vaultPath: "Wiki/assets/source.png",
          },
          {
            operation: "upsert_page" as const,
            page: {
              ...pageMetadata,
              payloadPath,
              bodyBytes: new TextEncoder().encode(body).byteLength,
            },
          },
        ];
        const capabilitiesHash = await treeCapabilitiesHashV3(capabilities);
        const confirmationHash = await treeConfirmationHashV3({
          protocolVersion: "3",
          spaceId: "space",
          baseRevision: "legacy-r2",
          capabilitiesHash,
          changes: changes.map((change) =>
            change.operation === "upsert_page"
              ? { operation: change.operation, page: pageMetadata }
              : { operation: change.operation, attachment: change.attachment },
          ),
        });
        const localPlanEvidence = {
          actions: merge.actions,
          rawPathStates: localScan.rawPathStates,
          expectedPathStates: expectedV3PathStates(localScan, merge.actions),
          scanEpoch: 1,
          identities,
        };
        const localPlanHash = await hashUpgradeLocalPlan(localPlanEvidence);
        const sourceV2RevisionHash = await treeRevisionContentHashV2({
          protocolVersion: "2",
          spaceId: "space",
          folders: [],
          pages: [],
        });
        const fixed = {
          binding,
          sourceRevision: "legacy-r2",
          sourceV2RevisionHash,
          projectedV3BaseHash: await treeRevisionContentHashV3(projected),
          oldBaselineEvidenceHash: "2".repeat(64),
          candidateHash,
          localPlanHash,
          confirmationHash,
        };
        const preview: UpgradePreview = {
          binding,
          remoteBase: {
            sourceProtocolVersion: "2",
            sourceRevision: "legacy-r2",
            sourceV2RevisionHash,
            source: {
              protocolVersion: "2",
              spaceId: "space",
              revision: "legacy-r2",
              revisionContentHash: sourceV2RevisionHash,
              folders: [],
              pages: [],
            },
            projected,
            projectedV3BaseHash: fixed.projectedV3BaseHash,
          },
          oldBaselineEvidenceHash: fixed.oldBaselineEvidenceHash,
          merge,
          candidate,
          candidateHash,
          localActions: merge.actions,
          expectedPathStates: localPlanEvidence.expectedPathStates,
          localPlanEvidence,
          localPlanHash,
          push: {
            protocolVersion: "3",
            spaceId: "space",
            baseRevision: "legacy-r2",
            changes,
            capabilities,
            capabilitiesHash,
            confirmationHash,
            credentialId: "credential",
            previewId: OPERATION,
          },
          authorizationHash: await hashUpgradeAuthorization(fixed),
        };

        const build = () => {
          const repository = new LocalImageUpgradeRepository(
            store,
            ROOT,
            binding,
          );
          let coordinator!: LocalImageUpgradeCoordinator;
          const push = new TreePushServiceV3(
            remote,
            store,
            `${ROOT}/local-image-upgrade/${OPERATION}/push`,
            {
              readBlob: (path) => vault.read(path),
              revalidateConfirmation: async () => preview.push.confirmationHash,
            },
            {
              operationId: OPERATION,
              assertSourceCurrent: (revision) =>
                coordinator.assertSourceCurrent(revision),
              onStaged: () => coordinator.onPushStaged(),
            },
          );
          const loadConfirmed = async (intent: UpgradeIntent) => {
            const path = intent.payloadPaths.find((item) =>
              item.endsWith("confirmed-preview.json"),
            );
            const raw = path ? await store.read(path) : null;
            if (!raw) throw new Error("CONFIRMED_PREVIEW_MISSING");
            return JSON.parse(raw) as UpgradePreview;
          };
          const local = new UpgradeLocalApply({
            remote,
            push,
            control: store,
            controlRoot: ROOT,
            baseline: new TreeBaselineRepository(store, ROOT, "space", "Wiki"),
            identities: new TreeIdentityRepository(
              store,
              `${ROOT}/tree-identities.json`,
            ),
            vault,
            loadConfirmed,
          });
          const port: UpgradeCoordinatorPort = {
            revalidate: async () => undefined,
            persistConfirmed: async (intent, value) => {
              const path = intent.payloadPaths.find((item) =>
                item.endsWith("confirmed-preview.json"),
              );
              if (!path) throw new Error("CONFIRMED_PREVIEW_PATH_MISSING");
              await store.write(path, JSON.stringify(value));
            },
            loadConfirmed,
            verifyPublished: (intent) => local.verifyPublished(intent),
            applyPublished: (intent, snapshot) =>
              local.applyPublished(intent, snapshot),
          };
          coordinator = new LocalImageUpgradeCoordinator(
            repository,
            push,
            port,
          );
          return { coordinator, repository };
        };

        if (options.storagePath)
          remote.onFinalize = () => {
            store.failWhenTextPathIncludes = options.storagePath!;
          };
        else if (options.cleanupFailure)
          remote.onFinalize = () => {
            store.failRemovePath = `${ROOT}/local-image-upgrade/${OPERATION}/payload/confirmed-preview.json`;
          };
        else if (options.blobCleanupFailure)
          remote.onFinalize = () => {
            store.failRemoveTreePath = `${ROOT}/local-image-upgrade/${OPERATION}/local/blob-staging`;
            store.failRemoveTreeOnCall = 2;
          };
        else vault.failAfterOperations = options.vaultFailureAt ?? 1;
        await expect(
          build().coordinator.confirm(preview, preview.authorizationHash),
        ).rejects.toThrow(/injected/);
        if (options.boundary === "image Vault write")
          expect(vault.operationLog).not.toContain(
            "write:Wiki/assets/used.png",
          );
        if (options.boundary === "page Vault write") {
          expect(vault.operationLog).toContain("write:Wiki/assets/used.png");
          expect(vault.operationLog).not.toContain("write:Wiki/pages/note.md");
        }
        if (options.boundary === "page rename") {
          expect(vault.operationLog).toContain("write:Wiki/assets/used.png");
          expect(vault.operationLog).not.toContain(
            "rename:Wiki/pages/old-note.md->Wiki/pages/note.md",
          );
        }
        store.failWhenTextPathIncludes = null;
        const interrupted = await build().repository.read();
        expect(interrupted?.phase).toBe(
          options.cleanupFailure ? "complete" : "local_pending",
        );
        if (options.blobCleanupFailure)
          expect(
            store.removeTreeCalls.get(
              `${ROOT}/local-image-upgrade/${OPERATION}/local/blob-staging`,
            ),
          ).toBe(2);
        expect(remote.finalizeCalls).toBe(1);
        const vaultOperationsBeforeRestart = [...vault.operationLog];
        vault.failAfterOperations = null;
        if (options.lateEdit)
          vault.seedMarkdown("Wiki/pages/note.md", "late user edit\n");
        const restarted = build();
        if (options.lateEdit) {
          await expect(restarted.coordinator.recover()).rejects.toThrow(
            /UPGRADE_REMOTE_PUBLISHED_LOCAL_PENDING|AMBIGUOUS/,
          );
          expect(vault.text("Wiki/pages/note.md")).toBe("late user edit\n");
          expect((await restarted.repository.read())?.phase).toBe(
            "local_pending",
          );
          expect(remote.finalizeCalls).toBe(1);
          return;
        }
        await restarted.coordinator.recover();

        expect(remote.finalizeCalls).toBe(1);
        expect((await restarted.repository.read())?.phase).toBe("complete");
        expect(vault.text("Wiki/pages/note.md")).toBe(body);
        expect(await vault.read("Wiki/assets/used.png")).toEqual(BYTES);
        expect(vault.text("Wiki/assets/unused.png")).toBe("keep");
        const baseline = await new TreeBaselineRepository(
          store,
          ROOT,
          "space",
          "Wiki",
        ).readSnapshot();
        expect(baseline.protocolVersion).toBe("3");
        expect(baseline.revision).toBe(
          interrupted?.verifiedPublication?.revision,
        );
        const localJournal = JSON.parse(
          (await store.read(
            `${ROOT}/local-image-upgrade/${OPERATION}/local/journal.json`,
          ))!,
        ) as { payload: { state: string; transactionId: string } };
        expect(localJournal.payload).toMatchObject({
          state: "committed",
          transactionId: interrupted?.localTransactionId,
        });
        if (options.cleanupFailure || options.blobCleanupFailure)
          expect(vault.operationLog).toEqual(vaultOperationsBeforeRestart);
        if (options.rename)
          expect(vault.operationLog).toContain(
            "rename:Wiki/pages/old-note.md->Wiki/pages/note.md",
          );
        const completed = await restarted.repository.read();
        for (const path of completed?.payloadPaths ?? [])
          expect(await store.read(path)).toBeNull();
      };

      await run(options);
    },
  );
});
