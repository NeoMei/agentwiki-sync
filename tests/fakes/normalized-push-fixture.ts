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
import { opaqueFileKey } from "../../src/core/identity-key";
import type { TreeSnapshotV3 } from "../../src/core/tree-model";
import type { NormalizedPushPlanInput } from "../../src/application/normalized-push-plan";
import type { TreePushPreviewV3 } from "../../src/application/tree-push-service-v3";
import { prepareTreePushChangesV3 } from "../../src/application/local-image-upgrade-plan";
import { emptyTreeIdentityStateV2 } from "../../src/storage/tree-identities";
import { FakeTreeRemoteV3 } from "./fake-tree-remote";
import { MemoryControlStore } from "./memory-control-store";
import { MemoryVault } from "./memory-vault";
import { TreeTransaction } from "../../src/application/tree-transaction";
import {
  normalizedPushPaths,
  sealNormalizedPushPlan,
  type NormalizedPushJournal,
} from "../../src/application/normalized-push-plan";
import { NormalizedPushRepository } from "../../src/storage/normalized-push";
import { MutableControlRepository } from "../../src/storage/envelope";
import { isV3PullControlAfterState } from "../../src/application/tree-local-apply-v3";
import { NormalizedPushCompletionSchema } from "../../src/application/normalized-push-plan";
import {
  isTreePushJournalV3,
  type TreePushJournalV3,
} from "../../src/application/tree-push-service-v3";

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
  await new MutableControlRepository(
    f.store,
    paths.controlAfterPath,
    isV3PullControlAfterState,
  ).write({
    schemaVersion: 2,
    transactionId: plan.localTransactionId,
    phase: "applied",
    identities: plan.identities,
  });
  const completion = {
    transactionId: plan.localTransactionId,
    targetRevision,
    targetTreeHash: plan.candidateHash,
    identitiesHash: await sha256Hex(canonicalBytes(plan.identities)),
    localPlanHash: plan.localPlanHash,
  };
  await new MutableControlRepository(
    f.store,
    paths.completionPath,
    (v): v is typeof completion =>
      NormalizedPushCompletionSchema.safeParse(v).success,
  ).write(completion);
  await transaction.markCommitted();
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
