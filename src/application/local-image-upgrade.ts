import {
  treeCapabilitiesHashV3,
  treeConfirmationHashV3,
  treeRevisionContentHashV2,
  treeRevisionContentHashV3,
  type TreePushConfirmationManifestV3,
} from "@neomei/agentwiki-sync-protocol";

import type { TreeSnapshotV3 } from "../core/tree-model";
import type {
  LocalImageUpgradeRepository,
  UpgradeIntent,
} from "../storage/local-image-upgrade";
import {
  hashUpgradeAuthorization,
  hashUpgradeLocalPlan,
  type UpgradePreview,
} from "./local-image-upgrade-plan";
import type { SyncOperationOptions } from "./progress";
import type {
  TreePushServiceV3,
  PreparedTreePushChangeV3,
} from "./tree-push-service-v3";

export interface UpgradeCoordinatorPort {
  revalidate(preview: UpgradePreview): Promise<void>;
  persistConfirmed(
    intent: UpgradeIntent,
    preview: UpgradePreview,
  ): Promise<void>;
  loadConfirmed(intent: UpgradeIntent): Promise<UpgradePreview>;
  verifyPublished(intent: UpgradeIntent): Promise<TreeSnapshotV3>;
  applyPublished(
    intent: UpgradeIntent,
    snapshot: TreeSnapshotV3,
  ): Promise<void>;
}

function manifestChange(
  change: PreparedTreePushChangeV3,
): TreePushConfirmationManifestV3["changes"][number] {
  if (change.operation !== "upsert_page") return structuredClone(change);
  const {
    payloadPath: _payloadPath,
    bodyBytes: _bodyBytes,
    ...page
  } = change.page;
  return { operation: "upsert_page", page };
}

function sameBinding(
  left: UpgradePreview["binding"],
  right: UpgradePreview["binding"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function confirmedPayloadPaths(preview: UpgradePreview): string[] {
  const pagePaths = preview.push.changes.flatMap((change) =>
    change.operation === "upsert_page" ? [change.page.payloadPath] : [],
  );
  const marker = `/local-image-upgrade/${preview.binding.operationId}/payload/`;
  const first = pagePaths[0];
  const markerIndex = first?.indexOf(marker) ?? -1;
  if (markerIndex < 0)
    throw new Error("UPGRADE_CONFIRMED_PAYLOAD_ROOT_MISSING");
  const payloadRoot = first!.slice(0, markerIndex + marker.length - 1);
  if (pagePaths.some((path) => !path.startsWith(`${payloadRoot}/`)))
    throw new Error("UPGRADE_CONFIRMED_PAYLOAD_ROOT_MISMATCH");
  return [
    ...new Set([...pagePaths, `${payloadRoot}/confirmed-preview.json`]),
  ].sort();
}

async function assertPreviewEvidence(
  preview: UpgradePreview,
  expected?: UpgradeIntent,
): Promise<void> {
  if (
    preview.push.spaceId !== preview.binding.spaceId ||
    preview.push.baseRevision !== preview.remoteBase.sourceRevision ||
    preview.push.credentialId !== preview.binding.credentialId ||
    preview.push.previewId !== preview.binding.operationId ||
    preview.candidate.spaceId !== preview.binding.spaceId ||
    preview.candidate.protocolVersion !== "3"
  )
    throw new Error("UPGRADE_PREVIEW_BINDING_MISMATCH");
  const capabilitiesHash = await treeCapabilitiesHashV3(
    preview.push.capabilities,
  );
  const candidateHash = await treeRevisionContentHashV3(preview.candidate);
  const sourceHash = await treeRevisionContentHashV2({
    protocolVersion: "2",
    spaceId: preview.remoteBase.source.spaceId,
    folders: preview.remoteBase.source.folders,
    pages: preview.remoteBase.source.pages,
  });
  const projectedHash = await treeRevisionContentHashV3(
    preview.remoteBase.projected,
  );
  const localPlanHash = await hashUpgradeLocalPlan(preview.localPlanEvidence);
  const confirmationHash = await treeConfirmationHashV3({
    protocolVersion: "3",
    spaceId: preview.push.spaceId,
    baseRevision: preview.push.baseRevision,
    capabilitiesHash: preview.push.capabilitiesHash,
    changes: preview.push.changes.map(manifestChange),
  });
  const authorizationHash = await hashUpgradeAuthorization({
    binding: preview.binding,
    sourceRevision: preview.remoteBase.sourceRevision,
    sourceV2RevisionHash: preview.remoteBase.sourceV2RevisionHash,
    projectedV3BaseHash: preview.remoteBase.projectedV3BaseHash,
    oldBaselineEvidenceHash: preview.oldBaselineEvidenceHash,
    candidateHash: preview.candidateHash,
    localPlanHash: preview.localPlanHash,
    confirmationHash: preview.push.confirmationHash,
  });
  if (
    capabilitiesHash !== preview.push.capabilitiesHash ||
    preview.remoteBase.source.protocolVersion !== "2" ||
    preview.remoteBase.source.revision !== preview.remoteBase.sourceRevision ||
    preview.remoteBase.source.revisionContentHash !==
      preview.remoteBase.sourceV2RevisionHash ||
    sourceHash !== preview.remoteBase.sourceV2RevisionHash ||
    projectedHash !== preview.remoteBase.projectedV3BaseHash ||
    candidateHash !== preview.candidateHash ||
    localPlanHash !== preview.localPlanHash ||
    confirmationHash !== preview.push.confirmationHash ||
    authorizationHash !== preview.authorizationHash
  )
    throw new Error("UPGRADE_PREVIEW_EVIDENCE_MISMATCH");
  if (
    expected &&
    (!sameBinding(preview.binding, expected.binding) ||
      expected.sourceRevision !== preview.remoteBase.sourceRevision ||
      expected.sourceV2RevisionHash !==
        preview.remoteBase.sourceV2RevisionHash ||
      expected.oldBaselineEvidenceHash !== preview.oldBaselineEvidenceHash ||
      expected.projectedV3BaseHash !== preview.remoteBase.projectedV3BaseHash ||
      expected.capabilitiesHash !== preview.push.capabilitiesHash ||
      expected.confirmationHash !== preview.push.confirmationHash ||
      expected.candidateHash !== preview.candidateHash ||
      expected.localPlanHash !== preview.localPlanHash ||
      expected.authorizationHash !== preview.authorizationHash)
  )
    throw new Error("UPGRADE_CONFIRMED_EVIDENCE_MISMATCH");
  if (
    expected &&
    JSON.stringify(expected.payloadPaths) !==
      JSON.stringify(confirmedPayloadPaths(preview))
  )
    throw new Error("UPGRADE_CONFIRMED_PAYLOAD_MISMATCH");
}

export class LocalImageUpgradeCoordinator {
  constructor(
    private readonly repository: LocalImageUpgradeRepository,
    private readonly push: TreePushServiceV3,
    private readonly port: UpgradeCoordinatorPort,
  ) {}

  private intent(preview: UpgradePreview): UpgradeIntent {
    return {
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
      payloadPaths: confirmedPayloadPaths(preview),
      pushOperationId: preview.binding.operationId,
      localTransactionId: crypto.randomUUID(),
      phase: "confirmed",
      verifiedPublication: null,
    };
  }

  private async confirmed(intent: UpgradeIntent): Promise<UpgradePreview> {
    const preview = await this.port.loadConfirmed(intent);
    await assertPreviewEvidence(preview, intent);
    return preview;
  }

  private async advancePublished(intent: UpgradeIntent): Promise<void> {
    const snapshot = await this.port.verifyPublished(intent);
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
      snapshot.revisionContentHash !== intent.candidateHash ||
      snapshotHash !== intent.candidateHash
    )
      throw new Error("UPGRADE_PUBLISHED_SNAPSHOT_MISMATCH");
    const pending: UpgradeIntent = {
      ...intent,
      phase: "local_pending",
      verifiedPublication: {
        revision: snapshot.revision,
        revisionContentHash: snapshot.revisionContentHash,
      },
    };
    await this.repository.write(pending);
    await this.port.applyPublished(pending, snapshot);
    await this.push.markVerified();
    await this.repository.write({ ...pending, phase: "complete" });
  }

  private async reconcileSuperseded(): Promise<void> {
    const child = await this.push.inspect();
    if (child?.remoteState !== "superseded") return;
    const intent = await this.repository.read();
    if (!intent || intent.phase === "superseded") return;
    if (intent.phase !== "confirmed" && intent.phase !== "remote_pending")
      throw new Error("UPGRADE_PARENT_PHASE_MISMATCH");
    await this.repository.write({ ...intent, phase: "superseded" });
  }

  async confirm(
    input: UpgradePreview,
    authorizationHash: string,
    options?: SyncOperationOptions,
  ): Promise<void> {
    const preview = structuredClone(input);
    if (authorizationHash !== preview.authorizationHash)
      throw new Error("UPGRADE_AUTHORIZATION_MISMATCH");
    await assertPreviewEvidence(preview);
    await this.port.revalidate(preview);
    const intent = this.intent(preview);
    await this.port.persistConfirmed(
      structuredClone(intent),
      structuredClone(preview),
    );
    await this.repository.write(intent);
    const confirmedPreview = await this.confirmed(intent);
    try {
      await this.push.publishPrepared(confirmedPreview.push, options);
    } catch (error) {
      await this.reconcileSuperseded();
      throw error;
    }
    const current = await this.repository.read();
    if (!current || current.phase !== "remote_pending")
      throw new Error("UPGRADE_PARENT_PHASE_MISMATCH");
    await this.advancePublished(current);
  }

  async onPushStaged(): Promise<void> {
    const intent = await this.repository.read();
    if (!intent) throw new Error("UPGRADE_PARENT_INTENT_MISSING");
    if (intent.phase === "remote_pending") return;
    if (intent.phase !== "confirmed")
      throw new Error("UPGRADE_PARENT_PHASE_MISMATCH");
    await this.repository.write({ ...intent, phase: "remote_pending" });
  }

  async assertSourceCurrent(baseRevision: string): Promise<void> {
    const intent = await this.repository.read();
    if (!intent || intent.sourceRevision !== baseRevision)
      throw new Error("UPGRADE_SOURCE_MISMATCH");
    if (intent.phase !== "confirmed" && intent.phase !== "remote_pending")
      throw new Error("UPGRADE_PARENT_PHASE_MISMATCH");
    const preview = await this.confirmed(intent);
    await this.port.revalidate(preview);
  }

  async recover(options?: SyncOperationOptions): Promise<void> {
    const intent = await this.repository.read();
    if (!intent || intent.phase === "complete" || intent.phase === "superseded")
      return;
    if (intent.phase === "local_pending") {
      await this.advancePublished(intent);
      return;
    }
    await this.confirmed(intent);
    const child = await this.push.inspect();
    if (child?.remoteState === "superseded") {
      await this.repository.write({ ...intent, phase: "superseded" });
      return;
    }
    if (intent.phase === "confirmed") {
      if (!child) {
        const preview = await this.confirmed(intent);
        await this.push.publishPrepared(preview.push, options);
      } else {
        await this.onPushStaged();
        await this.push.resumePending();
      }
    } else {
      await this.push.resumePending();
    }
    const recoveredChild = await this.push.inspect();
    const current = await this.repository.read();
    if (!current) throw new Error("UPGRADE_PARENT_INTENT_MISSING");
    if (recoveredChild?.remoteState === "superseded") {
      await this.repository.write({ ...current, phase: "superseded" });
      return;
    }
    if (recoveredChild?.remoteState !== "published" || !recoveredChild.result)
      throw new Error("UPGRADE_PUBLICATION_PENDING");
    await this.advancePublished(current);
  }
}
