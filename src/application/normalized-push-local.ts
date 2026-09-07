import { treeRevisionContentHashV3 } from "@neomei/agentwiki-sync-protocol";
import { canonicalBytes, sha256Hex } from "../agentwiki/protocol";
import type { TreeSnapshotV3 } from "../core/tree-model";
import type { ControlStorePort } from "../ports/control-store";
import type { VaultPort } from "../ports/vault";
import { MutableControlRepository } from "../storage/envelope";
import {
  assertNormalizedEvidence,
  NormalizedPushRepository,
} from "../storage/normalized-push";
import {
  strictPushEnvelopeRead,
  withPushJournalLock,
} from "../storage/push-journal-router";
import type { TreeBaselineRepository } from "../storage/tree-baseline";
import {
  emptyTreeIdentityStateV2,
  upgradeTreeIdentityState,
  type TreeIdentityRepository,
} from "../storage/tree-identities";
import {
  isNormalizedPushJournal,
  isNormalizedPushLocalBinding,
  normalizedPushPaths,
  NormalizedPushCompletionSchema,
  type NormalizedPushCompletion,
  type NormalizedPushJournal,
  type NormalizedPushLocalBinding,
} from "./normalized-push-plan";
import {
  applyV3ControlAfter,
  desiredV3Identities,
  isV3PullControlAfterState,
  type V3PullControlAfterState,
} from "./tree-local-apply-v3";
import {
  TreeTransaction,
  isTreeTransactionJournal,
  type TreeTransactionInput,
} from "./tree-transaction";

const digest = (value: unknown) => sha256Hex(canonicalBytes(value));
const isCompletion = (value: unknown): value is NormalizedPushCompletion =>
  NormalizedPushCompletionSchema.safeParse(value).success;
const isAfter = (value: unknown): value is V3PullControlAfterState =>
  isV3PullControlAfterState(value) &&
  Object.keys(value).every((key) =>
    ["schemaVersion", "transactionId", "phase", "identities"].includes(key),
  );

export class NormalizedPushLocalCommitter {
  constructor(
    private readonly input: {
      vault: VaultPort;
      control: ControlStorePort;
      controlRoot: string;
      baseline: TreeBaselineRepository;
      identities: TreeIdentityRepository;
    },
  ) {}

  apply(
    journal: NormalizedPushJournal,
    target: TreeSnapshotV3,
  ): Promise<NormalizedPushCompletion> {
    return withPushJournalLock(
      `${this.input.controlRoot}/normalized-local`,
      () => this.commit(journal, target),
    );
  }

  recover(
    journal: NormalizedPushJournal,
    target: TreeSnapshotV3,
  ): Promise<NormalizedPushCompletion> {
    return this.apply(journal, target);
  }

  rollbackUncommitted(journal: NormalizedPushJournal): Promise<void> {
    return withPushJournalLock(
      `${this.input.controlRoot}/normalized-local`,
      async () => {
        if (journal.mode !== "local_only" || journal.phase !== "local_pending")
          throw new Error("NORMALIZED_LOCAL_CANCEL_UNSAFE");
        await new NormalizedPushRepository(
          this.input.control,
          this.input.controlRoot,
        ).loadConfirmed(journal);
        const tx = this.transaction(journal);
        const tree = await tx.inspect();
        const { after } = await this.metadata(journal);
        const baseline = await this.input.baseline.inspectJournal();
        const completion = await strictPushEnvelopeRead(
          this.input.control,
          this.paths(journal).completionPath,
          isCompletion,
        );
        if (
          !tree ||
          ["verified", "committed", "ambiguous"].includes(tree.state) ||
          baseline?.transactionId === journal.localTransactionId ||
          after?.phase === "applied" ||
          completion
        )
          throw new Error("NORMALIZED_LOCAL_CANCEL_UNSAFE");
        if (tree.state !== "rolled_back") await tx.recover();
        if ((await tx.inspect())?.state !== "rolled_back")
          throw new Error("NORMALIZED_LOCAL_CANCEL_UNSAFE");
      },
    );
  }

  private paths(journal: NormalizedPushJournal) {
    return normalizedPushPaths(
      this.input.controlRoot,
      journal.binding.operationId,
    );
  }

  private transaction(journal: NormalizedPushJournal) {
    return new TreeTransaction(
      this.input.vault,
      this.input.control,
      this.paths(journal).localRoot,
    );
  }

  private completionFor(
    j: NormalizedPushJournal,
    identitiesHash: string,
  ): NormalizedPushCompletion {
    if (!j.verifiedTarget) throw new Error("NORMALIZED_LOCAL_TARGET_MISSING");
    return {
      transactionId: j.localTransactionId,
      targetRevision: j.verifiedTarget.revision,
      targetTreeHash: j.candidateHash,
      identitiesHash,
      localPlanHash: j.localPlanHash,
    };
  }

  private async metadata(j: NormalizedPushJournal) {
    const paths = this.paths(j);
    const bindingHashes = new Set<string>();
    const binding = (
      await strictPushEnvelopeRead(
        this.input.control,
        paths.controlAfterBindingPath,
        isNormalizedPushLocalBinding,
        async (value) => {
          const expected = {
            ...this.completionFor(j, value.identitiesHash),
            schemaVersion: 1,
            operationId: j.binding.operationId,
          };
          if ((await digest(value)) !== (await digest(expected)))
            throw new Error("NORMALIZED_LOCAL_BINDING_MISMATCH");
          bindingHashes.add(value.identitiesHash);
          if (bindingHashes.size !== 1)
            throw new Error("NORMALIZED_LOCAL_BINDING_MISMATCH");
        },
      )
    )?.payload;
    const after = (
      await strictPushEnvelopeRead(
        this.input.control,
        paths.controlAfterPath,
        isAfter,
        async (value) => {
          if (
            !binding ||
            value.transactionId !== j.localTransactionId ||
            (await digest(value.identities)) !== binding.identitiesHash
          )
            throw new Error("NORMALIZED_LOCAL_CONTROL_MISMATCH");
        },
      )
    )?.payload;
    return { binding, after };
  }

  /** Historical proof only: completed work survives later edits and baseline pruning. */
  async assertComplete(journal: NormalizedPushJournal): Promise<void> {
    await this.readCompletion(journal, true);
  }

  private async readCompletion(
    j: NormalizedPushJournal,
    required: boolean,
  ): Promise<NormalizedPushCompletion | null> {
    // Local completion precedes the remote child's locally-verified marker.
    if (!isNormalizedPushJournal(j))
      throw new Error("NORMALIZED_LOCAL_INVALID_JOURNAL");
    if (j.phase !== "local_pending" && j.phase !== "complete")
      throw new Error("NORMALIZED_LOCAL_NOT_PENDING");
    await assertNormalizedEvidence(this.input.control, this.input.controlRoot, {
      ...j,
      phase: "local_pending",
      completion: null,
    });
    const { binding, after } = await this.metadata(j);
    const completion = (
      await strictPushEnvelopeRead(
        this.input.control,
        this.paths(j).completionPath,
        isCompletion,
        async (value) => {
          if (
            !binding ||
            (await digest(value)) !==
              (await digest(this.completionFor(j, binding.identitiesHash))) ||
            (j.completion &&
              (await digest(value)) !== (await digest(j.completion)))
          )
            throw new Error("NORMALIZED_LOCAL_COMPLETION_MISMATCH");
        },
      )
    )?.payload;
    if (!completion) {
      if (required || j.phase === "complete")
        throw new Error("NORMALIZED_LOCAL_COMPLETION_MISSING");
      return null;
    }
    const tree = (
      await strictPushEnvelopeRead(
        this.input.control,
        `${this.paths(j).localRoot}/journal.json`,
        isTreeTransactionJournal,
      )
    )?.payload;
    if (
      !binding ||
      after?.phase !== "applied" ||
      tree?.state !== "committed" ||
      tree.nextOperation !== tree.operations.length
    )
      throw new Error("NORMALIZED_LOCAL_COMPLETION_EVIDENCE_MISSING");
    return completion;
  }

  private async commit(
    j: NormalizedPushJournal,
    target: TreeSnapshotV3,
  ): Promise<NormalizedPushCompletion> {
    const prior = await this.readCompletion(j, false);
    if (prior) return prior;
    if (
      target.protocolVersion !== "3" ||
      target.spaceId !== j.binding.spaceId ||
      target.revision !== j.verifiedTarget?.revision ||
      target.revisionContentHash !== j.candidateHash ||
      (await treeRevisionContentHashV3({
        protocolVersion: "3",
        spaceId: target.spaceId,
        folders: target.folders,
        pages: target.pages,
        attachments: target.attachments,
      })) !== j.candidateHash
    )
      throw new Error("NORMALIZED_LOCAL_TARGET_MISMATCH");
    await new NormalizedPushRepository(
      this.input.control,
      this.input.controlRoot,
    ).loadConfirmed(j);
    const paths = this.paths(j);
    for (const action of j.localPlan) {
      const page = target.pages.find((p) => p.pageId === action.pageId);
      const body = await this.input.control.read(action.payloadPath);
      if (
        !page ||
        page.path !== action.path ||
        page.contentHash !== action.contentHash ||
        body !== page.body ||
        new TextEncoder().encode(body).byteLength !== action.byteLength ||
        (await sha256Hex(new TextEncoder().encode(body))) !== action.contentHash
      )
        throw new Error("NORMALIZED_LOCAL_PAYLOAD_MISMATCH");
    }
    const transactionInput: TreeTransactionInput = {
      baseRevision: j.sourceRevision,
      targetRevision: target.revision,
      targetTreeHash: target.revisionContentHash,
      deferCommit: true,
      actions: j.localPlan.map((a) => ({
        kind: "write_page",
        pageId: a.pageId,
        path: `${j.binding.mappingRootKey}/${a.path}`,
        bodyPath: a.payloadPath,
      })),
      expectedPathStates: Object.fromEntries(
        j.localPlan.map((a) => [
          `${j.binding.mappingRootKey}/${a.path}`,
          { kind: "file", hash: a.beforeHash },
        ]),
      ),
    };
    const tx = this.transaction(j);
    let tree = await tx.inspect();
    if (tree)
      await tx.assertPreparedOwnership(transactionInput, j.localTransactionId);
    let { binding, after } = await this.metadata(j);
    if (
      tree &&
      !["prepared", "rolled_back"].includes(tree.state) &&
      (!binding || !after)
    )
      throw new Error("NORMALIZED_LOCAL_RECOVERY_EVIDENCE_MISSING");
    const baselineJournal = await this.input.baseline.inspectJournal();
    if (
      baselineJournal &&
      baselineJournal.transactionId !== j.localTransactionId &&
      !["committed", "rolled_back"].includes(baselineJournal.phase)
    )
      throw new Error("NORMALIZED_LOCAL_BASELINE_OWNERSHIP_MISMATCH");
    if (baselineJournal?.transactionId !== j.localTransactionId) {
      const source = await this.input.baseline.read();
      if (
        source.schemaVersion !== 3 ||
        source.baseRevision !== j.sourceRevision ||
        source.baseRevisionContentHash !== j.sourceTreeHash
      )
        throw new Error("NORMALIZED_LOCAL_SOURCE_BASELINE_CHANGED");
    } else {
      await this.input.baseline.assertPreparedOwnership(
        target,
        j.localTransactionId,
        "push",
      );
      if (!tree || !["verified", "committed"].includes(tree.state))
        throw new Error("NORMALIZED_LOCAL_BASELINE_BEFORE_VERIFICATION");
    }
    if (!after) {
      const current = upgradeTreeIdentityState(
        (await this.input.identities.read())?.payload ??
          emptyTreeIdentityStateV2(),
      );
      if ((await digest(current)) !== (await digest(j.identities)))
        throw new Error("NORMALIZED_LOCAL_IDENTITIES_CHANGED");
      const base = await this.input.baseline.readSnapshot();
      if (base.protocolVersion !== "3")
        throw new Error("NORMALIZED_LOCAL_SOURCE_BASELINE_CHANGED");
      const desired = desiredV3Identities(j.identities, {
        revision: target.revision,
        base,
        remote: target,
        resolvedFolders: target.folders,
        resolvedPages: target.pages,
        resolvedAttachments: target.attachments,
      });
      const expected: NormalizedPushLocalBinding = {
        ...this.completionFor(j, await digest(desired)),
        schemaVersion: 1,
        operationId: j.binding.operationId,
      };
      if (binding && (await digest(binding)) !== (await digest(expected)))
        throw new Error("NORMALIZED_LOCAL_BINDING_MISMATCH");
      binding = expected;
      after = {
        schemaVersion: 2,
        transactionId: j.localTransactionId,
        phase: "pending",
        identities: desired,
      };
    }
    if (
      tree &&
      !["prepared", "verified", "committed", "rolled_back"].includes(tree.state)
    ) {
      await tx.recover();
      tree = await tx.inspect();
    }
    if (!tree || tree.state === "rolled_back") {
      await tx.prepare(transactionInput, j.localTransactionId);
      tree = await tx.inspect();
    }
    const durable = await this.metadata(j);
    if (!durable.binding)
      await new MutableControlRepository(
        this.input.control,
        paths.controlAfterBindingPath,
        isNormalizedPushLocalBinding,
      ).write(binding!);
    if (!durable.after)
      await new MutableControlRepository(
        this.input.control,
        paths.controlAfterPath,
        isAfter,
      ).write(after);
    await this.metadata(j);
    if (tree?.state !== "verified" && tree?.state !== "committed") {
      await tx.apply();
      await tx.assertApplied();
      await tx.markVerified();
    }
    if (tree?.state !== "committed") {
      await tx.assertApplied();
      if (baselineJournal?.transactionId !== j.localTransactionId)
        await this.input.baseline.prepare(target, "push", j.localTransactionId);
      await this.input.baseline.assertPreparedOwnership(
        target,
        j.localTransactionId,
        "push",
      );
      const owned = await this.input.baseline.inspectJournal();
      if (owned?.phase === "prepared")
        await this.input.baseline.setPhase("applying");
      await this.input.baseline.recover(j.localTransactionId);
      await applyV3ControlAfter(
        new MutableControlRepository(
          this.input.control,
          paths.controlAfterPath,
          isAfter,
        ),
        this.input.identities,
        j.localTransactionId,
      );
      await this.assertControlCommitted(j, target, binding!);
      await tx.markCommitted();
    }
    await this.assertControlCommitted(j, target, binding!);
    if ((await tx.inspect())?.state !== "committed")
      throw new Error("NORMALIZED_LOCAL_TRANSACTION_NOT_COMMITTED");
    const completion = this.completionFor(j, binding!.identitiesHash);
    await new MutableControlRepository(
      this.input.control,
      paths.completionPath,
      isCompletion,
    ).write(completion);
    await this.assertComplete(j);
    return completion;
  }

  private async assertControlCommitted(
    j: NormalizedPushJournal,
    target: TreeSnapshotV3,
    binding: NormalizedPushLocalBinding,
  ) {
    await this.input.baseline.assertPreparedOwnership(
      target,
      j.localTransactionId,
      "push",
    );
    const [baseline, journal, identities, metadata] = await Promise.all([
      this.input.baseline.read(),
      this.input.baseline.inspectJournal(),
      this.input.identities.read(),
      this.metadata(j),
    ]);
    if (
      journal?.phase !== "committed" ||
      baseline.baseRevision !== target.revision ||
      baseline.baseRevisionContentHash !== target.revisionContentHash ||
      metadata.after?.phase !== "applied" ||
      (await digest(identities?.payload)) !== binding.identitiesHash
    )
      throw new Error("NORMALIZED_LOCAL_COMMIT_EVIDENCE_MISMATCH");
  }
}
