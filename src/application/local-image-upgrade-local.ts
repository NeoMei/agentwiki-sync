import { treeRevisionContentHashV3 } from "@neomei/agentwiki-sync-protocol";

import type { TreeSnapshotV3 } from "../core/tree-model";
import type { ControlStorePort } from "../ports/control-store";
import type { TreeRemotePortV3 } from "../ports/tree-remote";
import type { VaultPort } from "../ports/vault";
import { BlobStagingRepository } from "../storage/blob-staging";
import type { TreeBaselineRepository } from "../storage/tree-baseline";
import type { TreeIdentityRepository } from "../storage/tree-identities";
import { emptyTreeIdentityState } from "../storage/tree-identities";
import { upgradeTreeIdentityState } from "../storage/tree-identities";
import type { UpgradeIntent } from "../storage/local-image-upgrade";
import { MutableControlRepository } from "../storage/envelope";
import { BlobTransfer } from "./blob-transfer";
import type { UpgradePreview } from "./local-image-upgrade-plan";
import type { TreePushServiceV3 } from "./tree-push-service-v3";
import { readTreeSnapshotV3 } from "./tree-snapshot-reader";
import { TreeTransaction, type TreeTransactionInput } from "./tree-transaction";
import {
  applyV3ControlAfter,
  desiredV3Identities,
  isV3PullControlAfterState,
  prefixTreePullActionV3,
  verifyResolvedV3Vault,
  type V3PullControlAfterState,
} from "./tree-local-apply-v3";

function safeRootPart(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value))
    throw new TypeError("INVALID_UPGRADE_OPERATION_ID");
  return value;
}

export class UpgradeLocalApply {
  private readonly remote: TreeRemotePortV3;
  private readonly push: TreePushServiceV3;
  private readonly control: ControlStorePort;
  private readonly controlRoot: string;
  private readonly baseline: TreeBaselineRepository;
  private readonly identities: TreeIdentityRepository;
  private readonly vault: VaultPort;
  private readonly loadConfirmed: (
    intent: UpgradeIntent,
  ) => Promise<UpgradePreview>;

  constructor(deps: {
    remote: TreeRemotePortV3;
    push: TreePushServiceV3;
    control: ControlStorePort;
    controlRoot: string;
    baseline: TreeBaselineRepository;
    identities: TreeIdentityRepository;
    vault: VaultPort;
    loadConfirmed(intent: UpgradeIntent): Promise<UpgradePreview>;
  }) {
    this.remote = deps.remote;
    this.push = deps.push;
    this.control = deps.control;
    this.controlRoot = deps.controlRoot;
    this.baseline = deps.baseline;
    this.identities = deps.identities;
    this.vault = deps.vault;
    this.loadConfirmed = (intent) => deps.loadConfirmed(intent);
  }

  private localRoot(intent: UpgradeIntent): string {
    return `${this.controlRoot}/local-image-upgrade/${safeRootPart(intent.binding.operationId)}/local`;
  }

  private staging(intent: UpgradeIntent): BlobStagingRepository {
    return new BlobStagingRepository(
      this.control,
      `${this.localRoot(intent)}/blob-staging`,
    );
  }

  async verifyPublished(intent: UpgradeIntent): Promise<TreeSnapshotV3> {
    const child = await this.push.inspect();
    if (
      child?.remoteState !== "published" ||
      child.result?.status !== "published" ||
      child.result.revisionContentHash !== intent.candidateHash
    )
      throw new Error("UPGRADE_PUBLISHED_RESULT_MISMATCH");
    const preview = await this.loadConfirmed(intent);
    const snapshot = await readTreeSnapshotV3(
      this.remote,
      intent.binding.spaceId,
      child.result.revision,
    );
    const snapshotHash = await treeRevisionContentHashV3({
      protocolVersion: "3",
      spaceId: snapshot.spaceId,
      folders: snapshot.folders,
      pages: snapshot.pages,
      attachments: snapshot.attachments,
    });
    if (
      snapshot.protocolVersion !== "3" ||
      snapshot.spaceId !== intent.binding.spaceId ||
      snapshot.revision !== child.result.revision ||
      snapshot.revisionContentHash !== child.result.revisionContentHash ||
      snapshot.revisionContentHash !== intent.candidateHash ||
      snapshotHash !== intent.candidateHash ||
      (await treeRevisionContentHashV3(preview.candidate)) !==
        intent.candidateHash
    )
      throw new Error("UPGRADE_PUBLISHED_SNAPSHOT_MISMATCH");

    const capabilities = await this.remote.capabilities();
    const staging = this.staging(intent);
    const existing = await staging.readJournal();
    const expiresAt =
      existing?.expiresAt ??
      new Date(
        Date.now() + capabilities.blobStagingTtlSeconds * 1000,
      ).toISOString();
    await new BlobTransfer(this.remote, staging, capabilities).downloadMissing({
      transferId: intent.localTransactionId,
      expiresAt,
      revision: snapshot.revision,
      attachments: snapshot.attachments,
    });
    return snapshot;
  }

  async applyPublished(
    intent: UpgradeIntent,
    snapshot: TreeSnapshotV3,
  ): Promise<void> {
    if (
      intent.phase !== "local_pending" ||
      intent.verifiedPublication?.revision !== snapshot.revision ||
      intent.verifiedPublication.revisionContentHash !==
        snapshot.revisionContentHash ||
      snapshot.revisionContentHash !== intent.candidateHash
    )
      throw new Error("UPGRADE_REMOTE_PUBLISHED_LOCAL_PENDING");
    const preview = await this.loadConfirmed(intent);
    const localRoot = this.localRoot(intent);
    const staging = this.staging(intent);
    const controlAfter = new MutableControlRepository<V3PullControlAfterState>(
      this.control,
      `${localRoot}/control-after.json`,
      isV3PullControlAfterState,
    );
    const tx = new TreeTransaction(
      this.vault,
      this.control,
      localRoot,
      (action) => staging.readComplete(action.attachment.contentHash),
    );
    const identitiesBefore =
      (await this.identities.read())?.payload ?? emptyTreeIdentityState();
    const resolved = {
      revision: snapshot.revision,
      base: preview.merge.base,
      remote: snapshot,
      resolvedFolders: snapshot.folders,
      resolvedPages: snapshot.pages,
      resolvedAttachments: snapshot.attachments,
    };
    const bodyPaths = new Map(
      preview.push.changes.flatMap((change) =>
        change.operation === "upsert_page"
          ? [[change.page.pageId, change.page.payloadPath] as const]
          : [],
      ),
    );
    const transactionInput: TreeTransactionInput = {
      baseRevision: intent.sourceRevision,
      targetRevision: snapshot.revision,
      targetTreeHash: snapshot.revisionContentHash,
      actions: preview.localPlanEvidence.actions.map((action) =>
        prefixTreePullActionV3(
          action,
          preview.merge.local.rootPath,
          localRoot,
          (pageId) => {
            const path = bodyPaths.get(pageId);
            if (!path) throw new Error("UPGRADE_PAGE_PAYLOAD_MISSING");
            return path;
          },
        ),
      ),
      expectedPathStates: preview.localPlanEvidence.expectedPathStates,
      deferCommit: true,
    };
    const transaction = await tx.inspect();
    const after = await controlAfter.read();
    if (transaction)
      try {
        await tx.assertPreparedOwnership(
          transactionInput,
          intent.localTransactionId,
        );
      } catch {
        throw new Error("UPGRADE_LOCAL_TRANSACTION_OWNERSHIP_MISMATCH");
      }
    const expectedIdentities = desiredV3Identities(
      preview.localPlanEvidence.identities,
      resolved,
    );
    if (
      after &&
      (after.payload.transactionId !== intent.localTransactionId ||
        JSON.stringify(after.payload.identities) !==
          JSON.stringify(expectedIdentities))
    )
      throw new Error("UPGRADE_LOCAL_CONTROL_OWNERSHIP_MISMATCH");
    if (
      !after &&
      JSON.stringify(upgradeTreeIdentityState(identitiesBefore)) !==
        JSON.stringify(preview.localPlanEvidence.identities)
    )
      throw new Error("UPGRADE_REMOTE_PUBLISHED_LOCAL_PENDING");
    const desired = expectedIdentities;

    if (
      transaction &&
      (transaction.state === "verified" || transaction.state === "committed") &&
      !after
    )
      throw new Error("V3_PULL_CONTROL_RECOVERY_EVIDENCE_MISSING");

    let tree = transaction;
    if (
      tree &&
      tree.state !== "prepared" &&
      tree.state !== "verified" &&
      tree.state !== "committed" &&
      tree.state !== "rolled_back"
    ) {
      await tx.recover();
      tree = await tx.inspect();
    }

    if (!tree || tree.state === "rolled_back") {
      try {
        await tx.prepare(transactionInput, intent.localTransactionId);
      } catch (error) {
        if (error instanceof Error && error.message === "STALE_PULL_PREVIEW")
          throw new Error("UPGRADE_REMOTE_PUBLISHED_LOCAL_PENDING");
        throw error;
      }
      tree = await tx.inspect();
    }
    if (!after)
      await controlAfter.write({
        schemaVersion: 2,
        transactionId: intent.localTransactionId,
        phase: "pending",
        identities: desired,
      });

    const currentTx = tree ?? (await tx.inspect());
    if (!currentTx) throw new Error("UPGRADE_LOCAL_TRANSACTION_MISSING");
    if (currentTx.state !== "verified" && currentTx.state !== "committed") {
      if (currentTx.state !== "applied") await tx.apply();
      await verifyResolvedV3Vault({
        vault: this.vault,
        rootPath: preview.merge.local.rootPath,
        spaceId: intent.binding.spaceId,
        preview: resolved,
        identities: desired,
        capabilities: await this.remote.capabilities(),
      });
      await tx.markVerified();
    }
    const baselineJournal = await this.baseline.inspectJournal();
    if (
      baselineJournal &&
      baselineJournal.transactionId !== intent.localTransactionId &&
      baselineJournal.phase !== "committed" &&
      baselineJournal.phase !== "rolled_back"
    )
      throw new Error("UPGRADE_LOCAL_BASELINE_OWNERSHIP_MISMATCH");
    if (
      !baselineJournal ||
      baselineJournal.transactionId !== intent.localTransactionId ||
      baselineJournal.phase === "rolled_back" ||
      baselineJournal.phase === "failed"
    )
      await this.baseline.prepare(snapshot, "pull", intent.localTransactionId);
    const ownedBaseline = await this.baseline.inspectJournal();
    await this.baseline.assertPreparedPull(snapshot, intent.localTransactionId);
    if (ownedBaseline?.phase === "prepared")
      await this.baseline.setPhase("applying");
    await tx.assertApplied();
    if (ownedBaseline?.phase !== "committed")
      await this.baseline.recover(intent.localTransactionId);
    await applyV3ControlAfter(
      controlAfter,
      this.identities,
      intent.localTransactionId,
    );
    await tx.markCommitted();
    await this.assertCommitted(intent, snapshot, tx, controlAfter, desired);
    await staging.cleanup();
  }

  private async assertCommitted(
    intent: UpgradeIntent,
    snapshot: TreeSnapshotV3,
    tx: TreeTransaction,
    controlAfter: MutableControlRepository<V3PullControlAfterState>,
    desired: V3PullControlAfterState["identities"],
  ): Promise<void> {
    const [tree, baseline, baselineJournal, after, identities] =
      await Promise.all([
        tx.inspect(),
        this.baseline.readSnapshot(),
        this.baseline.inspectJournal(),
        controlAfter.read(),
        this.identities.read(),
      ]);
    if (
      tree?.state !== "committed" ||
      tree.transactionId !== intent.localTransactionId ||
      baseline.protocolVersion !== "3" ||
      baseline.revision !== snapshot.revision ||
      baseline.revisionContentHash !== snapshot.revisionContentHash ||
      baselineJournal?.transactionId !== intent.localTransactionId ||
      baselineJournal.phase !== "committed" ||
      after?.payload.transactionId !== intent.localTransactionId ||
      after.payload.phase !== "applied" ||
      JSON.stringify(identities?.payload) !== JSON.stringify(desired)
    )
      throw new Error("UPGRADE_LOCAL_COMMIT_EVIDENCE_MISMATCH");
  }
}
