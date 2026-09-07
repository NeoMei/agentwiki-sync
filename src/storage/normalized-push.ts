import {
  TreeRevisionContentManifestV3Schema,
  TreeSyncCapabilitiesV3Schema,
  treeCapabilitiesHashV3,
  treeConfirmationHashV3,
  treeRevisionContentHashV3,
  canonicalTreeRevisionManifestV3,
  validatePortableMarkdownPath,
} from "@neomei/agentwiki-sync-protocol";
import { caseFold } from "unicode-case-folding";
import { canonicalBytes, contentHash, sha256Hex } from "../agentwiki/protocol";
import {
  assertNormalizedPlan,
  isNormalizedPushJournal,
  isNormalizedPushLocalBinding,
  normalizedPlan,
  normalizedPushPaths,
  NormalizedPushCompletionSchema,
  type NormalizedPushJournal,
  type NormalizedPushPlan,
  type NormalizedPushCompletion,
} from "../application/normalized-push-plan";
import {
  isTreePushJournalV3,
  type TreePushJournalV3,
  type TreePushPreviewV3,
} from "../application/tree-push-service-v3";
import {
  isTreeTransactionJournal,
  type TreeTransactionJournal,
} from "../application/tree-transaction";
import {
  isV3PullControlAfterState,
  type V3PullControlAfterState,
} from "../application/tree-local-apply-v3";
import { opaqueFileKey } from "../core/identity-key";
import { decodeVaultMarkdown } from "../core/markdown";
import { normalizeLocalImageLinks } from "../core/local-image-normalization";
import type { TreeSnapshotV3 } from "../core/tree-model";
import { validateTreeSnapshotV3 } from "../core/tree-validation";
import type { ControlStorePort } from "../ports/control-store";
import {
  PushJournalRouter,
  strictPushEnvelopeRead,
  withPushJournalLock,
} from "./push-journal-router";

export type RawNormalizedPageBytes = Record<string, Uint8Array>;
const encoder = new TextEncoder();
const digest = (value: unknown) => sha256Hex(canonicalBytes(value));
const manifest = (c: TreeSnapshotV3) => ({
  protocolVersion: c.protocolVersion,
  spaceId: c.spaceId,
  folders: c.folders,
  pages: c.pages,
  attachments: c.attachments,
});
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function onlyKeys(value: unknown, keys: string[]): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
function isCompletion(value: unknown): value is NormalizedPushCompletion {
  return NormalizedPushCompletionSchema.safeParse(value).success;
}
function isControlAfter(value: unknown): value is V3PullControlAfterState {
  return (
    onlyKeys(value, [
      "schemaVersion",
      "transactionId",
      "phase",
      "identities",
    ]) && isV3PullControlAfterState(value)
  );
}
function isOwnedTreeJournal(value: unknown): value is TreeTransactionJournal {
  if (
    !onlyKeys(value, [
      "schemaVersion",
      "transactionId",
      "baseRevision",
      "targetRevision",
      "targetTreeHash",
      "state",
      "nextOperation",
      "operations",
      "deferCommit",
    ]) ||
    !isTreeTransactionJournal(value)
  )
    return false;
  return (
    value.schemaVersion === 3 &&
    value.deferCommit === true &&
    value.nextOperation <= value.operations.length &&
    value.operations.every(
      (op) =>
        onlyKeys(op, ["action", "paths"]) &&
        onlyKeys(op.action, ["kind", "pageId", "path", "bodyPath"]) &&
        op.action.kind === "write_page" &&
        op.paths.length === 1 &&
        op.paths.every(
          (p) =>
            onlyKeys(p, ["path", "before", "after"]) &&
            [p.before, p.after].every(
              (s) =>
                onlyKeys(s, ["kind", "hash"]) &&
                s.kind === "file" &&
                typeof s.hash === "string" &&
                /^[a-f0-9]{64}$/u.test(s.hash),
            ),
        ),
    )
  );
}
async function assertOwnedPlan(
  root: string,
  plan: NormalizedPushPlan,
): Promise<void> {
  await assertNormalizedPlan(plan);
  const paths = normalizedPushPaths(root, plan.binding.operationId);
  for (const action of plan.localPlan)
    if (
      action.payloadPath !==
      `${paths.payloadRoot}/${await opaqueFileKey(action.pageId)}.md`
    )
      throw new Error("Normalized payload is not owned");
}
async function assertChild(
  j: NormalizedPushJournal,
  child: TreePushJournalV3,
): Promise<void> {
  if (
    child.spaceId !== j.binding.spaceId ||
    child.idempotencyKey !== j.binding.operationId ||
    child.baseRevision !== j.sourceRevision ||
    child.credentialIdAtCreation !== j.binding.credentialId ||
    child.capabilitiesHash !== j.capabilitiesHash ||
    child.confirmationHash !== j.wireConfirmationHash
  )
    throw new Error("Normalized child ownership mismatch");
  if (
    (await treeCapabilitiesHashV3(child.capabilities)) !== j.capabilitiesHash ||
    (await treeConfirmationHashV3(wireManifest(child))) !==
      j.wireConfirmationHash
  )
    throw new Error("Normalized child frozen evidence mismatch");
}
/** Retained evidence only: never consult current Vault, baseline pointers, or cleaned bodies. */
export async function assertNormalizedEvidence(
  store: ControlStorePort,
  root: string,
  j: NormalizedPushJournal,
): Promise<void> {
  if (!isNormalizedPushJournal(j))
    throw new Error("Invalid normalized journal");
  await assertOwnedPlan(root, normalizedPlan(j));
  const p = normalizedPushPaths(root, j.binding.operationId);
  const child = (
    await strictPushEnvelopeRead(
      store,
      `${p.remoteRoot}/journal.json`,
      isTreePushJournalV3,
      (candidate) => assertChild(j, candidate),
    )
  )?.payload;
  const assertLocal = (local: TreeTransactionJournal) => {
    if (
      local.transactionId !== j.localTransactionId ||
      local.baseRevision !== j.sourceRevision ||
      local.targetRevision !== j.verifiedTarget?.revision ||
      local.targetTreeHash !== j.candidateHash ||
      local.operations.length !== j.localPlan.length
    )
      throw new Error("Normalized transaction ownership mismatch");
    for (let i = 0; i < local.operations.length; i++) {
      const operation = local.operations[i]!;
      const action = j.localPlan[i]!;
      const path = `${j.binding.mappingRootKey}/${action.path}`;
      if (
        !same(operation.action, {
          kind: "write_page",
          pageId: action.pageId,
          path,
          bodyPath: action.payloadPath,
        }) ||
        operation.paths[0]!.path !== path ||
        operation.paths[0]!.before.hash !== action.beforeHash ||
        operation.paths[0]!.after.hash !== action.contentHash
      )
        throw new Error("Normalized transaction plan mismatch");
    }
  };
  const local = (
    await strictPushEnvelopeRead(
      store,
      `${p.localRoot}/journal.json`,
      isOwnedTreeJournal,
      assertLocal,
    )
  )?.payload;
  if (j.mode === "local_only" && child)
    throw new Error("Local only cannot own a remote Push");
  if (j.phase === "confirmed") {
    if (local || (child && child.remoteState === "published"))
      throw new Error("Confirmed parent has inconsistent child progress");
    return;
  }
  if (j.phase === "remote_pending") {
    if (!child || local) throw new Error("Remote pending evidence missing");
    return;
  }
  if (j.phase === "superseded") {
    if (
      (j.mode === "local_only" &&
        j.verifiedTarget !== null &&
        local?.state !== "rolled_back") ||
      (local && (j.mode !== "local_only" || local.state !== "rolled_back")) ||
      (child &&
        (child.remoteState !== "superseded" ||
          child.result !== null ||
          child.localCommitPhase !== "not_started"))
    )
      throw new Error("Supersession is not authoritative");
    return;
  }
  if (
    j.mode === "remote_push" &&
    (!child ||
      child.remoteState !== "published" ||
      child.result?.status !== "published" ||
      child.result.revision !== j.verifiedTarget!.revision ||
      child.result.revisionContentHash !== j.candidateHash)
  )
    throw new Error("Publication evidence mismatch");
  if (j.phase !== "complete") return;
  if (
    !local ||
    local.state !== "committed" ||
    local.nextOperation !== local.operations.length ||
    (child && child.localCommitPhase !== "verified")
  )
    throw new Error("Normalized transaction not completed");
  const localBinding = (
    await strictPushEnvelopeRead(
      store,
      p.controlAfterBindingPath,
      isNormalizedPushLocalBinding,
      (candidate) => {
        if (
          candidate.operationId !== j.binding.operationId ||
          candidate.transactionId !== j.localTransactionId ||
          candidate.targetRevision !== j.verifiedTarget!.revision ||
          candidate.targetTreeHash !== j.candidateHash ||
          candidate.localPlanHash !== j.localPlanHash ||
          candidate.identitiesHash !== j.completion!.identitiesHash
        )
          throw new Error("Control-after binding ownership mismatch");
      },
    )
  )?.payload;
  if (!localBinding) throw new Error("Control-after binding missing");
  const after = (
    await strictPushEnvelopeRead(
      store,
      p.controlAfterPath,
      isControlAfter,
      async (candidate) => {
        if (
          candidate.transactionId !== j.localTransactionId ||
          (await digest(candidate.identities)) !== localBinding.identitiesHash
        )
          throw new Error("Control-after ownership mismatch");
      },
    )
  )?.payload;
  const completion = (
    await strictPushEnvelopeRead(
      store,
      p.completionPath,
      isCompletion,
      async (candidate) => {
        if ((await digest(candidate)) !== (await digest(j.completion)))
          throw new Error("Completion ownership mismatch");
      },
    )
  )?.payload;
  if (
    !after ||
    after.transactionId !== j.localTransactionId ||
    after.phase !== "applied" ||
    !completion ||
    completion.transactionId !== j.localTransactionId ||
    completion.targetRevision !== j.verifiedTarget!.revision ||
    completion.targetTreeHash !== j.candidateHash ||
    completion.localPlanHash !== j.localPlanHash ||
    completion.identitiesHash !== (await digest(after.identities)) ||
    completion.identitiesHash !== localBinding.identitiesHash ||
    (await digest(completion)) !== (await digest(j.completion))
  )
    throw new Error("Normalized completion evidence missing or changed");
}
function wireManifest(push: TreePushPreviewV3) {
  return {
    protocolVersion: "3" as const,
    spaceId: push.spaceId,
    baseRevision: push.baseRevision,
    capabilitiesHash: push.capabilitiesHash,
    changes: push.changes.map((c) => {
      if (c.operation === "upsert_page") {
        const { payloadPath: _path, bodyBytes: _length, ...page } = c.page;
        return { operation: c.operation, page };
      }
      if (c.operation === "upsert_attachment")
        return { operation: c.operation, attachment: c.attachment };
      return c;
    }),
  };
}
async function validateFrozen(
  store: ControlStorePort,
  root: string,
  plan: NormalizedPushPlan,
  push: TreePushPreviewV3,
  candidate: TreeSnapshotV3,
  owned: boolean,
): Promise<void> {
  await assertOwnedPlan(root, plan);
  const caps = TreeSyncCapabilitiesV3Schema.parse(push.capabilities);
  if (
    !onlyKeys(push, [
      "protocolVersion",
      "spaceId",
      "baseRevision",
      "changes",
      "capabilities",
      "capabilitiesHash",
      "confirmationHash",
      "credentialId",
      "previewId",
    ]) ||
    push.protocolVersion !== "3" ||
    push.spaceId !== plan.binding.spaceId ||
    push.baseRevision !== plan.sourceRevision ||
    push.credentialId !== plan.binding.credentialId ||
    push.capabilitiesHash !== plan.capabilitiesHash ||
    (await treeCapabilitiesHashV3(caps)) !== plan.capabilitiesHash ||
    push.confirmationHash !== plan.wireConfirmationHash ||
    (await treeConfirmationHashV3(wireManifest(push))) !==
      plan.wireConfirmationHash
  )
    throw new Error("Frozen wire binding mismatch");
  if (
    !onlyKeys(candidate, [
      "protocolVersion",
      "spaceId",
      "revision",
      "revisionContentHash",
      "folders",
      "pages",
      "attachments",
    ])
  )
    throw new Error("Invalid candidate snapshot");
  TreeRevisionContentManifestV3Schema.parse(manifest(candidate));
  validateTreeSnapshotV3(candidate);
  if (
    candidate.spaceId !== plan.binding.spaceId ||
    candidate.revision !== plan.sourceRevision ||
    candidate.revisionContentHash !== plan.candidateHash ||
    (await treeRevisionContentHashV3(manifest(candidate))) !==
      plan.candidateHash
  )
    throw new Error("Frozen candidate mismatch");
  if ((plan.mode === "local_only") !== (push.changes.length === 0))
    throw new Error("Normalized mode and wire mismatch");
  if (
    candidate.pages.length > caps.maxClientSpacePages ||
    candidate.folders.length > caps.maxClientSpaceFolders ||
    candidate.pages.length +
      candidate.folders.length +
      candidate.attachments.length >
      caps.maxSnapshotObjects ||
    canonicalBytes(canonicalTreeRevisionManifestV3(manifest(candidate)))
      .byteLength > caps.maxClientManifestBytes ||
    push.changes.length > caps.maxChangeCount ||
    canonicalBytes(wireManifest(push)).byteLength > caps.maxConfirmationBytes
  )
    throw new Error("Normalized manifest quota exceeded");
  let total = 0;
  for (const page of candidate.pages) {
    const length = encoder.encode(page.body).byteLength;
    total += length;
    if (
      length > caps.maxPageBytes ||
      decodeVaultMarkdown(encoder.encode(page.body)).normalized !== page.body ||
      (await contentHash(page.body)) !== page.contentHash
    )
      throw new Error("Canonical Page invalid or over quota");
  }
  if (total > caps.maxClientTotalBodyBytes)
    throw new Error("Canonical body quota exceeded");
  for (const action of plan.localPlan) {
    const page = candidate.pages.find((p) => p.pageId === action.pageId);
    if (
      !page ||
      page.path !== action.path ||
      page.contentHash !== action.contentHash ||
      encoder.encode(page.body).byteLength !== action.byteLength
    )
      throw new Error("Local payload candidate mismatch");
    if (owned && (await store.read(action.payloadPath)) !== page.body)
      throw new Error("Normalized payload missing or changed");
  }
  let wireTotal = 0;
  for (const change of push.changes) {
    if (change.operation !== "upsert_page") continue;
    const page = candidate.pages.find((p) => p.pageId === change.page.pageId);
    if (!page) throw new Error("Wire Page missing from candidate");
    const { payloadPath, bodyBytes, ...metadata } = change.page;
    if (
      !payloadPath.startsWith(`${root}/`) ||
      payloadPath.includes("\\") ||
      payloadPath.split("/").some((p) => p === "." || p === ".." || p === "")
    )
      throw new Error("Foreign wire payload");
    const { body, ...expected } = page;
    if (
      (await digest(metadata)) !== (await digest(expected)) ||
      bodyBytes !== encoder.encode(body).byteLength ||
      bodyBytes > caps.maxPageBytes ||
      (await store.read(payloadPath)) !== body
    )
      throw new Error("Wire payload missing or changed");
    if (
      owned &&
      payloadPath !==
        `${normalizedPushPaths(root, plan.binding.operationId).payloadRoot}/${await opaqueFileKey(page.pageId)}.md`
    )
      throw new Error("Foreign wire payload");
    wireTotal += bodyBytes;
  }
  if (wireTotal > caps.maxClientTotalBodyBytes)
    throw new Error("Wire body quota exceeded");
}
export class NormalizedPushRepository {
  private readonly router: PushJournalRouter;
  constructor(
    private readonly store: ControlStorePort,
    private readonly controlRoot: string,
  ) {
    this.router = new PushJournalRouter(store, controlRoot);
  }
  async stage(
    plan: NormalizedPushPlan,
    push: TreePushPreviewV3,
    candidate: TreeSnapshotV3,
    rawPageBytes: RawNormalizedPageBytes,
  ): Promise<void> {
    return withPushJournalLock(`${this.controlRoot}/staging`, async () => {
      await validateFrozen(
        this.store,
        this.controlRoot,
        plan,
        push,
        candidate,
        false,
      );
      const expected = Object.entries(plan.rawPathStates)
        .filter(
          ([path, state]) =>
            state.kind === "file" &&
            path.startsWith("pages/") &&
            path.endsWith(".md"),
        )
        .map(([path]) => path)
        .sort();
      if (!same(expected, Object.keys(rawPageBytes).sort()))
        throw new Error("Raw Page evidence set mismatch");
      let total = 0;
      for (const path of expected) {
        if (validatePortableMarkdownPath(path).path !== path)
          throw new Error("Invalid raw Page path");
        const bytes = rawPageBytes[path]!;
        total += bytes.byteLength;
        if (
          bytes.byteLength > push.capabilities.maxPageBytes ||
          total > push.capabilities.maxClientTotalBodyBytes
        )
          throw new Error("Raw Page quota exceeded");
        decodeVaultMarkdown(bytes);
        if ((await sha256Hex(bytes)) !== plan.rawPathStates[path]!.hash)
          throw new Error("Raw Page hash mismatch");
        const normalization = plan.normalizations.find(
          (n) => n.pagePath === path,
        );
        if (normalization) {
          const normalized = await normalizeLocalImageLinks({
            pageId: normalization.pageId,
            pagePath: path,
            raw: bytes,
            resolve: async (_pagePath, basename) => {
              const r = normalization.replacements.find(
                (r) => r.basenameKey === caseFold(basename.normalize("NFC")),
              );
              return r
                ? {
                    kind: "resolved",
                    attachmentPath: r.attachmentPath,
                    basenameKey: r.basenameKey,
                  }
                : { kind: "missing" };
            },
          });
          if (
            (await digest(normalized.evidence)) !==
            (await digest(normalization))
          )
            throw new Error("Normalization source evidence mismatch");
        }
      }
      const existing = await this.router.read();
      if (
        existing?.payload.schemaVersion === 4 &&
        existing.payload.binding.operationId === plan.binding.operationId
      ) {
        if (
          (await digest(normalizedPlan(existing.payload))) !==
          (await digest(plan))
        )
          throw new Error("Operation plan already frozen");
        await this.loadConfirmed(existing.payload);
        return;
      }
      if (existing?.payload.schemaVersion === 4)
        await this.assertTerminal(existing.payload);
      const paths = normalizedPushPaths(
        this.controlRoot,
        plan.binding.operationId,
      );
      if (
        (await this.store.read(`${paths.operationRoot}/terminal.json`)) !== null
      )
        throw new Error("Normalized operation was already completed");
      const staged = structuredClone(push);
      delete staged.previewId;
      for (const page of candidate.pages)
        if (
          plan.localPlan.some((a) => a.pageId === page.pageId) ||
          staged.changes.some(
            (c) =>
              c.operation === "upsert_page" && c.page.pageId === page.pageId,
          )
        ) {
          const path = `${paths.payloadRoot}/${await opaqueFileKey(page.pageId)}.md`;
          await this.store.write(path, page.body);
          for (const change of staged.changes)
            if (
              change.operation === "upsert_page" &&
              change.page.pageId === page.pageId
            )
              change.page.payloadPath = path;
        }
      await this.store.write(
        `${paths.payloadRoot}/candidate.json`,
        JSON.stringify(candidate),
      );
      await this.store.write(
        `${paths.payloadRoot}/wire.json`,
        JSON.stringify(staged),
      );
      const durableCandidate = JSON.parse(
        (await this.store.read(`${paths.payloadRoot}/candidate.json`)) ??
          "null",
      ) as TreeSnapshotV3;
      const durablePush = JSON.parse(
        (await this.store.read(`${paths.payloadRoot}/wire.json`)) ?? "null",
      ) as TreePushPreviewV3;
      await validateFrozen(
        this.store,
        this.controlRoot,
        plan,
        durablePush,
        durableCandidate,
        true,
      );
      await this.router.writeParent({
        ...structuredClone(plan),
        phase: "confirmed",
        verifiedTarget: null,
        completion: null,
      });
    });
  }
  async read(): Promise<NormalizedPushJournal | null> {
    const current = await this.router.read();
    return current?.payload.schemaVersion === 4
      ? structuredClone(current.payload)
      : null;
  }
  async loadConfirmed(journal: NormalizedPushJournal): Promise<{
    plan: NormalizedPushPlan;
    push: TreePushPreviewV3;
    candidate: TreeSnapshotV3;
  }> {
    await assertNormalizedEvidence(this.store, this.controlRoot, journal);
    const p = normalizedPushPaths(
      this.controlRoot,
      journal.binding.operationId,
    );
    const candidateRaw = await this.store.read(
      `${p.payloadRoot}/candidate.json`,
    );
    const wireRaw = await this.store.read(`${p.payloadRoot}/wire.json`);
    if (candidateRaw === null || wireRaw === null)
      throw new Error("Normalized frozen sidecars missing");
    const candidate = JSON.parse(candidateRaw) as TreeSnapshotV3;
    const push = JSON.parse(wireRaw) as TreePushPreviewV3;
    const plan = normalizedPlan(journal);
    await validateFrozen(
      this.store,
      this.controlRoot,
      plan,
      push,
      candidate,
      true,
    );
    return { plan: structuredClone(plan), push, candidate };
  }
  async write(journal: NormalizedPushJournal): Promise<void> {
    await this.router.writeParent(journal);
  }
  async assertTerminal(journal: NormalizedPushJournal): Promise<void> {
    if (journal.phase !== "complete" && journal.phase !== "superseded")
      throw new Error("Normalized push pending");
    await assertNormalizedEvidence(this.store, this.controlRoot, journal);
  }
  async cleanup(journal: NormalizedPushJournal): Promise<void> {
    await this.assertTerminal(journal);
    const p = normalizedPushPaths(
      this.controlRoot,
      journal.binding.operationId,
    );
    await this.store.removeTree?.(p.payloadRoot);
  }
}
