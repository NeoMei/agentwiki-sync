import {
  treeConfirmationHashV3,
  treeRevisionContentHashV3,
} from "@neomei/agentwiki-sync-protocol";
import {
  canonicalBytes,
  contentHash,
  sha256Hex,
} from "../../src/agentwiki/protocol";
import { normalizeLocalImageLinks } from "../../src/core/local-image-normalization";
import { scanLocalTree } from "../../src/core/tree-scan";
import { opaqueFileKey } from "../../src/core/identity-key";
import type { TreeSnapshotV3 } from "../../src/core/tree-model";
import type { NormalizedPushPlanInput } from "../../src/application/normalized-push-plan";
import type { TreePushPreviewV3 } from "../../src/application/tree-push-service-v3";
import { prepareTreePushChangesV3 } from "../../src/application/local-image-upgrade-plan";
import {
  emptyTreeIdentityStateV2,
  upgradeTreeIdentityState,
} from "../../src/storage/tree-identities";
import { FakeTreeRemoteV3 } from "./fake-tree-remote";
import { MemoryControlStore } from "./memory-control-store";
import { MemoryVault } from "./memory-vault";
import { TreeTransaction } from "../../src/application/tree-transaction";
import {
  normalizedPushPaths,
  sealNormalizedPushPlan,
  type NormalizedPushJournal,
  isNormalizedPushLocalBinding,
  type NormalizedPushLocalBinding,
} from "../../src/application/normalized-push-plan";
import { NormalizedPushRepository } from "../../src/storage/normalized-push";
import { MutableControlRepository } from "../../src/storage/envelope";
import {
  desiredV3Identities,
  isV3PullControlAfterState,
} from "../../src/application/tree-local-apply-v3";
import { NormalizedPushCompletionSchema } from "../../src/application/normalized-push-plan";
import { NormalizedPushLocalCommitter } from "../../src/application/normalized-push-local";
import { TreeBaselineRepository } from "../../src/storage/tree-baseline";
import { TreeIdentityRepository } from "../../src/storage/tree-identities";
import {
  isTreePushJournalV3,
  type TreePushJournalV3,
} from "../../src/application/tree-push-service-v3";
import { NormalizedPushCoordinator } from "../../src/application/normalized-push";
import { readTreeSnapshotV3 } from "../../src/application/tree-snapshot-reader";

export const NORMALIZED_ROOT = ".agentwiki/device-1/space-1";
export async function makeNormalizedFixture(rawText = "![A](photo.png)") {
  const store = new MemoryControlStore();
  const raw = new TextEncoder().encode(rawText);
  const normalized = await normalizeLocalImageLinks({
    pageId: "page-1",
    pagePath: "pages/note.md",
    raw,
    resolve: async () => ({
      kind: "resolved",
      attachmentPath: "assets/photo.png",
      basenameKey: "photo.png",
    }),
  });
  if (!normalized.evidence) throw new Error("fixture requires normalization");
  const remote = new FakeTreeRemoteV3();
  const page = {
    pageId: "page-1",
    folderId: null,
    path: "pages/note.md",
    title: "note",
    body: normalized.body,
    contentHash: await contentHash(normalized.body),
    referencedAttachmentIds: ["image-1"],
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
  await remote.seedTree({
    spaceId: "space-1",
    revision: "rev-1",
    pages: [page],
    attachments: [
      {
        attachmentId: "image-1",
        path: "assets/photo.png",
        mimeType: "image/png",
        sizeBytes: "3",
        width: 1,
        height: 1,
        contentHash: await sha256Hex(new Uint8Array([1, 2, 3])),
        updatedAt: page.updatedAt,
      },
    ],
  });
  const snapshots = remote.snapshotPages("rev-1");
  const snapshotResult = await snapshots[Symbol.asyncIterator]().next();
  if (snapshotResult.done) throw new Error("Fixture snapshot was empty");
  const segment = snapshotResult.value;
  // The fake uses a fixed Space label; rebind its real snapshot with a real manifest hash.
  const candidate: TreeSnapshotV3 = {
    protocolVersion: "3",
    spaceId: "space-1",
    revision: "rev-1",
    revisionContentHash: "",
    folders: segment.folders,
    pages: segment.pages,
    attachments: segment.attachments,
  };
  candidate.revisionContentHash = await treeRevisionContentHashV3({
    protocolVersion: "3",
    spaceId: candidate.spaceId,
    folders: candidate.folders,
    pages: candidate.pages,
    attachments: candidate.attachments,
  });
  const base = { ...candidate, pages: [], attachments: [] };
  base.revisionContentHash = await treeRevisionContentHashV3({
    protocolVersion: "3",
    spaceId: base.spaceId,
    folders: base.folders,
    pages: base.pages,
    attachments: base.attachments,
  });
  const {
    revision: _revision,
    revisionContentHash: _hash,
    ...candidateTree
  } = candidate;
  const prepared = await prepareTreePushChangesV3({
    base,
    candidate: candidateTree,
    vaultRoot: "Wiki",
    control: store,
    payloadRoot: `${NORMALIZED_ROOT}/preview`,
  });
  const capabilities = await remote.capabilities();
  const capabilitiesHash = await remote.capabilitiesHash;
  const changes = prepared.changes;
  const manifestChanges = changes.map((change) => {
    if (change.operation === "upsert_page") {
      const { payloadPath: _path, bodyBytes: _bytes, ...p } = change.page;
      return { operation: change.operation, page: p };
    }
    if (change.operation === "upsert_attachment")
      return { operation: change.operation, attachment: change.attachment };
    return change;
  });
  const confirmationHash = await treeConfirmationHashV3({
    protocolVersion: "3",
    spaceId: "space-1",
    baseRevision: "rev-1",
    capabilitiesHash,
    changes: manifestChanges,
  });
  const push: TreePushPreviewV3 = {
    protocolVersion: "3",
    spaceId: "space-1",
    baseRevision: "rev-1",
    changes,
    capabilities,
    capabilitiesHash,
    confirmationHash,
    credentialId: "credential-1",
  };
  const input: NormalizedPushPlanInput = {
    mode: "remote_push",
    binding: {
      operationId: "op-1",
      serverOrigin: "https://example.test",
      serverInstanceId: "server-1",
      spaceId: "space-1",
      deviceId: "device-1",
      credentialId: "credential-1",
      vaultId: "vault-1",
      mappingRootKey: "Wiki",
    },
    sourceRevision: "rev-1",
    sourceTreeHash: base.revisionContentHash,
    capabilitiesHash,
    wireConfirmationHash: confirmationHash,
    candidateHash: candidate.revisionContentHash,
    localTransactionId: "tx-1",
    localPlan: [
      {
        kind: "write_page",
        pageId: "page-1",
        path: "pages/note.md",
        beforeHash: await sha256Hex(raw),
        payloadPath: `${NORMALIZED_ROOT}/push/operations/op-1/payload/${await opaqueFileKey("page-1")}.md`,
        contentHash: page.contentHash,
        byteLength: new TextEncoder().encode(page.body).byteLength,
      },
    ],
    normalizations: [normalized.evidence],
    rawPathStates: {
      "pages/note.md": { kind: "file", hash: await sha256Hex(raw) },
    },
    identities: emptyTreeIdentityStateV2(),
    scanEpoch: 1,
  };
  return {
    store,
    input,
    push,
    candidate,
    rawPageBytes: { "pages/note.md": raw },
    remote,
  };
}
export async function makeNormalizedPlanInput(
  rawText?: string,
): Promise<NormalizedPushPlanInput> {
  return (await makeNormalizedFixture(rawText)).input;
}
export async function makeNormalizedLocalFixture(
  options: {
    secondPage?: boolean;
    otherPage?: boolean;
    remotePush?: boolean;
  } = {},
) {
  const f = options.remotePush
    ? await makeNormalizedFixture()
    : await makeLocalOnlyFixture();
  if (options.secondPage) {
    const first = f.candidate.pages[0]!;
    f.candidate.pages.push({
      ...first,
      pageId: "page-2",
      path: "pages/second.md",
      title: "second",
    });
    f.input.localPlan.push({
      ...f.input.localPlan[0]!,
      pageId: "page-2",
      path: "pages/second.md",
      payloadPath: `${NORMALIZED_ROOT}/push/operations/op-1/payload/${await opaqueFileKey("page-2")}.md`,
    });
    f.input.normalizations.push({
      ...f.input.normalizations[0]!,
      pageId: "page-2",
      pagePath: "pages/second.md",
    });
    f.input.rawPathStates["pages/second.md"] =
      f.input.rawPathStates["pages/note.md"]!;
    Object.assign(f.rawPageBytes, {
      "pages/second.md": f.rawPageBytes["pages/note.md"],
    });
  }
  if (options.otherPage) {
    f.candidate.pages.push({
      ...f.candidate.pages[0]!,
      pageId: "other",
      path: "pages/other.md",
      title: "other",
      body: "original other",
      contentHash: await contentHash("original other"),
      referencedAttachmentIds: [],
    });
    f.input.rawPathStates["pages/other.md"] = {
      kind: "file",
      hash: await sha256Hex(new TextEncoder().encode("original other")),
    };
    Object.assign(f.rawPageBytes, {
      "pages/other.md": new TextEncoder().encode("original other"),
    });
  }
  f.candidate.revisionContentHash = await treeRevisionContentHashV3({
    protocolVersion: "3",
    spaceId: "space-1",
    folders: f.candidate.folders,
    pages: f.candidate.pages,
    attachments: f.candidate.attachments,
  });
  f.input.candidateHash = f.candidate.revisionContentHash;
  if (!options.remotePush) f.input.sourceTreeHash = f.input.candidateHash;
  const plan = await sealNormalizedPushPlan(f.input);
  const repository = new NormalizedPushRepository(f.store, NORMALIZED_ROOT);
  await repository.stage(plan, f.push, f.candidate, f.rawPageBytes);
  const target = {
    ...f.candidate,
    revision: options.remotePush ? "rev-2" : "rev-1",
  };
  if (options.remotePush) {
    const childRepository = new MutableControlRepository(
      f.store,
      `${normalizedPushPaths(NORMALIZED_ROOT, plan.binding.operationId).remoteRoot}/journal.json`,
      isTreePushJournalV3,
    );
    const child = makeV3Journal(f, {
      idempotencyKey: "op-1",
      remoteState: "not_created",
    });
    await childRepository.write(child);
    await repository.write({
      ...plan,
      phase: "remote_pending",
      verifiedTarget: null,
      completion: null,
    });
    const publication = await f.remote.bootstrapConfirmed({
      baseRevision: "rev-1",
      confirmationHash: plan.wireConfirmationHash,
      userConfirmed: true,
    });
    await childRepository.write({
      ...child,
      remoteState: "published",
      sessionId: "session-1",
      result: {
        ...publication,
        revision: "rev-2",
        revisionContentHash: plan.candidateHash,
      },
    });
  }
  const journal: NormalizedPushJournal = {
    ...plan,
    phase: "local_pending",
    verifiedTarget: {
      revision: target.revision,
      revisionContentHash: target.revisionContentHash,
    },
    completion: null,
  };
  await repository.write(journal);
  const vault = new MemoryVault({ "Wiki/pages/note.md": "![A](photo.png)" });
  if (options.secondPage)
    vault.seedMarkdown("Wiki/pages/second.md", "![A](photo.png)");
  if (options.otherPage)
    vault.seedMarkdown("Wiki/pages/other.md", "original other");
  vault.seedFile("Wiki/assets/photo.png", new Uint8Array([1, 2, 3]));
  const baseline = new TreeBaselineRepository(
    f.store,
    NORMALIZED_ROOT,
    "space-1",
    "Wiki",
  );
  const source = options.remotePush
    ? {
        ...f.candidate,
        pages: [],
        attachments: [],
        revisionContentHash: plan.sourceTreeHash,
      }
    : f.candidate;
  await baseline.prepare(source, "pull", "source-pull");
  await baseline.recover("source-pull");
  const identities = new TreeIdentityRepository(
    f.store,
    `${NORMALIZED_ROOT}/tree-identities.json`,
  );
  await identities.commitConfirmedV3Activation();
  const deps = {
    vault,
    control: f.store,
    controlRoot: NORMALIZED_ROOT,
    baseline,
    identities,
  };
  return {
    ...deps,
    journal,
    target,
    repository,
    local: new NormalizedPushLocalCommitter(deps),
  };
}
export async function makeLocalOnlyFixture() {
  const f = await makeNormalizedFixture();
  f.input.mode = "local_only";
  f.input.sourceTreeHash = f.input.candidateHash;
  f.push.changes = [];
  f.push.confirmationHash = await treeConfirmationHashV3({
    protocolVersion: "3",
    spaceId: f.push.spaceId,
    baseRevision: f.push.baseRevision,
    capabilitiesHash: f.push.capabilitiesHash,
    changes: [],
  });
  f.input.wireConfirmationHash = f.push.confirmationHash;
  return f;
}

export async function makeNormalizedCoordinatorFixture(
  mode: "remote_push" | "local_only",
) {
  const f =
    mode === "local_only"
      ? await makeLocalOnlyFixture()
      : await makeNormalizedFixture();
  const vault = new MemoryVault({ "Wiki/pages/note.md": "![A](photo.png)" });
  vault.seedFile("Wiki/assets/photo.png", new Uint8Array([1, 2, 3]));
  f.input.binding.operationId = "00000000-0000-4000-8000-000000000001";
  for (const action of f.input.localPlan)
    action.payloadPath = `${NORMALIZED_ROOT}/push/operations/${f.input.binding.operationId}/payload/${await opaqueFileKey(action.pageId)}.md`;
  let sourceSnapshot = structuredClone(f.candidate);
  if (mode === "remote_push") {
    const oldBody = "![A](../assets/old.png)";
    const source: TreeSnapshotV3 = {
      ...structuredClone(f.candidate),
      pages: [
        {
          ...structuredClone(f.candidate.pages[0]!),
          body: oldBody,
          contentHash: await contentHash(oldBody),
        },
      ],
      attachments: [
        {
          ...structuredClone(f.candidate.attachments[0]!),
          path: "assets/old.png",
        },
      ],
    };
    sourceSnapshot = source;
    source.revisionContentHash = await treeRevisionContentHashV3({
      protocolVersion: "3",
      spaceId: source.spaceId,
      folders: source.folders,
      pages: source.pages,
      attachments: source.attachments,
    });
    f.input.sourceTreeHash = source.revisionContentHash;
    await f.remote.seedTree({
      spaceId: "space-1",
      revision: source.revision,
      folders: source.folders,
      pages: source.pages,
      attachments: source.attachments,
      blobs: { "image-1": new Uint8Array([1, 2, 3]) },
    });
  }
  const plan = await sealNormalizedPushPlan(f.input);
  const baseline = new TreeBaselineRepository(
    f.store,
    NORMALIZED_ROOT,
    "space-1",
    "Wiki",
  );
  await baseline.prepare(sourceSnapshot, "pull", "source-pull");
  await baseline.recover("source-pull");
  const identities = new TreeIdentityRepository(
    f.store,
    `${NORMALIZED_ROOT}/tree-identities.json`,
  );
  await identities.commitConfirmedV3Activation();
  const repository = new NormalizedPushRepository(f.store, NORMALIZED_ROOT);
  const local = new NormalizedPushLocalCommitter({
    vault,
    control: f.store,
    controlRoot: NORMALIZED_ROOT,
    baseline,
    identities,
  });
  const authority = {
    revalidate: async (expected: typeof plan) => {
      const head = await f.remote.head();
      const capabilitiesHash = await f.remote.capabilitiesHash;
      const basenameCounts = new Map<string, number>();
      const actualNormalizations: typeof expected.normalizations = [];
      const actualActions: typeof expected.localPlan = [];
      const actualCandidate = structuredClone(f.candidate);
      const actualIdentities = upgradeTreeIdentityState(
        (await identities.read())?.payload ?? expected.identities,
      );
      const scan = await scanLocalTree(
        vault,
        expected.binding.mappingRootKey,
        sourceSnapshot,
        structuredClone(actualIdentities),
        {
          maxFolders: f.push.capabilities.maxClientSpaceFolders,
          maxPages: f.push.capabilities.maxClientSpacePages,
          maxPageBytes: f.push.capabilities.maxPageBytes,
          maxTotalBodyBytes: f.push.capabilities.maxClientTotalBodyBytes,
          maxAttachmentBytes: f.push.capabilities.maxAttachmentBytes,
          maxRevisionAttachments: f.push.capabilities.maxRevisionAttachments,
          maxTransferBlobBytes: f.push.capabilities.maxTransferBlobBytes,
          maxImageDimension: f.push.capabilities.maxImageDimension,
          maxDecodedPixels: f.push.capabilities.maxDecodedPixels,
          allowedMimeTypes: f.push.capabilities.allowedMimeTypes,
        },
      );
      for await (const entry of vault.listTree(
        expected.binding.mappingRootKey,
      )) {
        if (entry.kind === "file") {
          const basename = entry.relativePath.split("/").at(-1);
          if (basename) {
            const key = basename.normalize("NFC").toLowerCase();
            basenameCounts.set(key, (basenameCounts.get(key) ?? 0) + 1);
          }
        }
      }
      for (const action of expected.localPlan) {
        const bytes = await vault.read(
          `${expected.binding.mappingRootKey}/${action.path}`,
        );
        if (!bytes) continue;
        const normalized = await normalizeLocalImageLinks({
          pageId: action.pageId,
          pagePath: action.path,
          raw: bytes,
          resolve: async (_pagePath, basename) => {
            const replacement = expected.normalizations
              .flatMap((item) => item.replacements)
              .find(
                (item) =>
                  item.basenameKey === basename.normalize("NFC").toLowerCase(),
              );
            if (
              !replacement ||
              basenameCounts.get(basename.normalize("NFC").toLowerCase()) !==
                1 ||
              (await vault.pathStatus(
                `${expected.binding.mappingRootKey}/${replacement.attachmentPath}`,
              )) !== "file"
            )
              return { kind: "missing" as const };
            return {
              kind: "resolved" as const,
              attachmentPath: replacement.attachmentPath,
              basenameKey: replacement.basenameKey,
            };
          },
        });
        if (!normalized.evidence) continue;
        actualNormalizations.push(normalized.evidence);
        actualActions.push({
          ...action,
          beforeHash: normalized.evidence.rawHash,
          contentHash: normalized.evidence.canonicalContentHash,
          byteLength: new TextEncoder().encode(normalized.body).byteLength,
        });
        const page = actualCandidate.pages.find(
          (item) => item.pageId === action.pageId,
        );
        if (page) {
          page.body = normalized.body;
          page.contentHash = normalized.evidence.canonicalContentHash;
        }
      }
      actualCandidate.revisionContentHash = await treeRevisionContentHashV3({
        protocolVersion: "3",
        spaceId: actualCandidate.spaceId,
        folders: actualCandidate.folders,
        pages: actualCandidate.pages,
        attachments: actualCandidate.attachments,
      });
      try {
        const actual = await sealNormalizedPushPlan({
          mode: expected.mode,
          binding: structuredClone(expected.binding),
          sourceRevision: head.revision,
          sourceTreeHash: head.revisionContentHash,
          capabilitiesHash,
          wireConfirmationHash: expected.wireConfirmationHash,
          candidateHash: actualCandidate.revisionContentHash,
          localTransactionId: expected.localTransactionId,
          localPlan: actualActions,
          normalizations: actualNormalizations,
          rawPathStates: scan.rawPathStates,
          identities: structuredClone(actualIdentities),
          scanEpoch: expected.scanEpoch,
        });
        return actual.authorizationHash;
      } catch {
        return sha256Hex(
          canonicalBytes({
            invalid: true,
            head,
            capabilitiesHash,
            rawPathStates: scan.rawPathStates,
            actualActions,
            actualNormalizations,
            candidateHash: actualCandidate.revisionContentHash,
            identities: actualIdentities,
          }),
        );
      }
    },
    readTarget: (revision: string) =>
      readTreeSnapshotV3(f.remote, "space-1", revision),
  };
  const rebuild = () =>
    new NormalizedPushCoordinator({
      remote: f.remote,
      vault,
      control: f.store,
      controlRoot: NORMALIZED_ROOT,
      repository,
      local,
      authority,
    });
  return {
    plan,
    push: f.push,
    candidate: f.candidate,
    vault,
    control: f.store,
    remote: f.remote,
    coordinator: rebuild(),
    rebuild,
  };
}
export function makeV3Journal(
  f: Awaited<ReturnType<typeof makeNormalizedFixture>>,
  overrides: Partial<TreePushJournalV3> = {},
): TreePushJournalV3 {
  return {
    schemaVersion: 3,
    protocolVersion: "3",
    spaceId: f.push.spaceId,
    baseRevision: f.push.baseRevision,
    idempotencyKey: "old-op",
    confirmationHash: f.push.confirmationHash,
    capabilitiesHash: f.push.capabilitiesHash,
    capabilities: f.push.capabilities,
    changes: f.push.changes,
    requiredBlobs: {},
    blobRequirements: [],
    totalBodyBytes: f.push.changes.reduce(
      (n, c) => n + (c.operation === "upsert_page" ? c.page.bodyBytes : 0),
      0,
    ),
    attachmentCount: 1,
    transferBlobBytes: 0,
    sessionId: null,
    credentialIdAtCreation: f.push.credentialId!,
    remoteState: "superseded",
    result: null,
    localCommitPhase: "not_started",
    ...overrides,
  };
}
export async function envelopeFor(payload: unknown, generation = 1) {
  return JSON.stringify({
    envelopeSchemaVersion: 1,
    writeGeneration: generation,
    payloadHash: await sha256Hex(canonicalBytes(payload)),
    payload,
  });
}
export async function completeLocalOnly(
  f: Awaited<ReturnType<typeof makeLocalOnlyFixture>>,
) {
  const plan = await sealNormalizedPushPlan(f.input);
  const repo = new NormalizedPushRepository(f.store, NORMALIZED_ROOT);
  await repo.stage(plan, f.push, f.candidate, f.rawPageBytes);
  const paths = normalizedPushPaths(NORMALIZED_ROOT, plan.binding.operationId);
  const targetRevision =
    plan.mode === "local_only" ? plan.sourceRevision : "rev-2";
  const childRepository = new MutableControlRepository(
    f.store,
    `${paths.remoteRoot}/journal.json`,
    isTreePushJournalV3,
  );
  let child: TreePushJournalV3 | null = null;
  if (plan.mode === "remote_push") {
    child = makeV3Journal(f, {
      idempotencyKey: plan.binding.operationId,
      remoteState: "not_created",
    });
    await childRepository.write(child);
    await repo.write({
      ...plan,
      phase: "remote_pending",
      verifiedTarget: null,
      completion: null,
    });
    const publication = await f.remote.bootstrapConfirmed({
      baseRevision: "rev-1",
      confirmationHash: plan.wireConfirmationHash,
      userConfirmed: true,
    });
    child = {
      ...child,
      remoteState: "published",
      sessionId: "session-1",
      result: {
        ...publication,
        revision: targetRevision,
        revisionContentHash: plan.candidateHash,
      },
    };
    await childRepository.write(child);
  }
  const pending: NormalizedPushJournal = {
    ...plan,
    phase: "local_pending",
    verifiedTarget: {
      revision: targetRevision,
      revisionContentHash: plan.candidateHash,
    },
    completion: null,
  };
  await repo.write(pending);
  const identities = desiredV3Identities(plan.identities, {
    revision: targetRevision,
    base: { attachments: [] },
    remote: f.candidate,
    resolvedFolders: f.candidate.folders,
    resolvedPages: f.candidate.pages,
    resolvedAttachments: f.candidate.attachments,
  });
  const localBinding: NormalizedPushLocalBinding = {
    schemaVersion: 1,
    operationId: plan.binding.operationId,
    transactionId: plan.localTransactionId,
    targetRevision,
    targetTreeHash: plan.candidateHash,
    localPlanHash: plan.localPlanHash,
    identitiesHash: await sha256Hex(canonicalBytes(identities)),
  };
  await new MutableControlRepository(
    f.store,
    paths.controlAfterBindingPath,
    isNormalizedPushLocalBinding,
  ).write(localBinding);
  const afterRepository = new MutableControlRepository(
    f.store,
    paths.controlAfterPath,
    isV3PullControlAfterState,
  );
  await afterRepository.write({
    schemaVersion: 2,
    transactionId: plan.localTransactionId,
    phase: "pending",
    identities,
  });
  const vault = new MemoryVault({ "Wiki/pages/note.md": "![A](photo.png)" });
  const transaction = new TreeTransaction(vault, f.store, paths.localRoot);
  await transaction.prepare(
    {
      baseRevision: plan.sourceRevision,
      targetRevision,
      targetTreeHash: plan.candidateHash,
      deferCommit: true,
      actions: plan.localPlan.map((a) => ({
        kind: "write_page",
        pageId: a.pageId,
        path: `Wiki/${a.path}`,
        bodyPath: a.payloadPath,
      })),
      expectedPathStates: {
        "Wiki/pages/note.md": plan.rawPathStates["pages/note.md"]!,
      },
    },
    plan.localTransactionId,
  );
  await transaction.apply();
  await transaction.markVerified();
  await afterRepository.write({
    schemaVersion: 2,
    transactionId: plan.localTransactionId,
    phase: "applied",
    identities,
  });
  await transaction.markCommitted();
  const completion = {
    transactionId: plan.localTransactionId,
    targetRevision,
    targetTreeHash: plan.candidateHash,
    identitiesHash: localBinding.identitiesHash,
    localPlanHash: plan.localPlanHash,
  };
  await new MutableControlRepository(
    f.store,
    paths.completionPath,
    (v): v is typeof completion =>
      NormalizedPushCompletionSchema.safeParse(v).success,
  ).write(completion);
  if (child)
    await childRepository.write({ ...child, localCommitPhase: "verified" });
  const journal: NormalizedPushJournal = {
    ...pending,
    phase: "complete",
    completion,
  };
  await repo.write(journal);
  return { repo, journal, vault, transaction, paths };
}
