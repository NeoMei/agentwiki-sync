import { treeRevisionContentHashV3 } from "@neomei/agentwiki-sync-protocol";

import { canonicalBytes } from "../agentwiki/protocol";
import type { TreeSnapshotV3 } from "../core/tree-model";
import { validateTreeSnapshotV3 } from "../core/tree-validation";
import type { ControlStorePort } from "../ports/control-store";
import type { TreeRemotePortV3 } from "../ports/tree-remote";
import type { VaultPort } from "../ports/vault";
import type {
  NormalizedPushRepository,
  RawNormalizedPageBytes,
} from "../storage/normalized-push";
import type { SyncOperationOptions } from "./progress";
import type { NormalizedPushLocalCommitter } from "./normalized-push-local";
import {
  normalizedPushPaths,
  type NormalizedPushJournal,
  type NormalizedPushPlan,
} from "./normalized-push-plan";
import {
  TreePushServiceV3,
  type PreparedTreePushChangeV3,
  type TreePushPreviewV3,
} from "./tree-push-service-v3";

export interface NormalizedPushAuthority {
  revalidate(
    plan: NormalizedPushPlan,
    mode?: "current_head" | "confirmed_local_only",
  ): Promise<string>;
  readTarget(revision: string): Promise<TreeSnapshotV3>;
}

type CoordinatorInput = {
  remote: TreeRemotePortV3;
  vault: VaultPort;
  control: ControlStorePort;
  controlRoot: string;
  repository: NormalizedPushRepository;
  local: NormalizedPushLocalCommitter;
  authority: NormalizedPushAuthority;
};

const content = (snapshot: TreeSnapshotV3) => ({
  protocolVersion: snapshot.protocolVersion,
  spaceId: snapshot.spaceId,
  folders: snapshot.folders,
  pages: snapshot.pages,
  attachments: snapshot.attachments,
});
const sortedContent = (snapshot: TreeSnapshotV3) => ({
  folders: [...snapshot.folders].sort((a, b) =>
    a.folderId.localeCompare(b.folderId),
  ),
  pages: [...snapshot.pages].sort((a, b) => a.pageId.localeCompare(b.pageId)),
  attachments: [...snapshot.attachments].sort((a, b) =>
    a.attachmentId.localeCompare(b.attachmentId),
  ),
});
const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.byteLength === right.byteLength &&
  left.every((value, index) => value === right[index]);

export class NormalizedPushCoordinator {
  constructor(private readonly input: CoordinatorInput) {}

  private async revalidate(
    plan: NormalizedPushPlan,
    mode: "current_head" | "confirmed_local_only" = "current_head",
  ): Promise<void> {
    if (
      (await this.input.authority.revalidate(plan, mode)) !==
      plan.authorizationHash
    )
      throw new Error("NORMALIZED_PUSH_AUTHORIZATION_CHANGED");
  }

  private async rawPageBytes(
    plan: NormalizedPushPlan,
    push: TreePushPreviewV3,
  ): Promise<RawNormalizedPageBytes> {
    const paths = Object.entries(plan.rawPathStates)
      .filter(
        ([path, state]) =>
          state.kind === "file" &&
          path.startsWith("pages/") &&
          path.endsWith(".md"),
      )
      .map(([path]) => path)
      .sort();
    const result: RawNormalizedPageBytes = {};
    let total = 0;
    for (const path of paths) {
      const bytes = await this.input.vault.read(
        `${plan.binding.mappingRootKey}/${path}`,
      );
      if (!bytes) throw new Error("NORMALIZED_PUSH_RAW_PAGE_MISSING");
      total += bytes.byteLength;
      if (
        bytes.byteLength > push.capabilities.maxPageBytes ||
        total > push.capabilities.maxClientTotalBodyBytes
      )
        throw new Error("NORMALIZED_PUSH_RAW_PAGE_QUOTA_EXCEEDED");
      result[path] = bytes;
    }
    return result;
  }

  private child(journal: NormalizedPushJournal): TreePushServiceV3 {
    const paths = normalizedPushPaths(
      this.input.controlRoot,
      journal.binding.operationId,
    );
    const onStaged = async () => {
      const current = await this.requireJournal();
      if (current.phase === "remote_pending") return;
      if (current.phase !== "confirmed")
        throw new Error("NORMALIZED_PUSH_PARENT_PHASE_MISMATCH");
      await this.input.repository.write({
        ...current,
        phase: "remote_pending",
      });
    };
    return new TreePushServiceV3(
      this.input.remote,
      this.input.control,
      paths.remoteRoot,
      {
        readBlob: (path) => this.input.vault.read(path),
        revalidateConfirmation: async (wire) => {
          await this.revalidate(journal);
          this.assertWireOwnership(journal, wire);
          return journal.wireConfirmationHash;
        },
      },
      {
        operationId: journal.binding.operationId,
        assertSourceCurrent: async (revision) => {
          if (revision !== journal.sourceRevision)
            throw new Error("NORMALIZED_PUSH_SOURCE_MISMATCH");
          await this.revalidate(journal);
        },
        onStaged,
      },
    );
  }

  private assertWireOwnership(
    journal: NormalizedPushJournal,
    wire: {
      spaceId: string;
      baseRevision: string;
      capabilitiesHash: string;
      changes: PreparedTreePushChangeV3[];
    },
  ): void {
    if (
      wire.spaceId !== journal.binding.spaceId ||
      wire.baseRevision !== journal.sourceRevision ||
      wire.capabilitiesHash !== journal.capabilitiesHash
    )
      throw new Error("NORMALIZED_PUSH_WIRE_OWNERSHIP_MISMATCH");
  }

  private async requireJournal(): Promise<NormalizedPushJournal> {
    const journal = await this.input.repository.read();
    if (!journal) throw new Error("NORMALIZED_PUSH_JOURNAL_MISSING");
    return journal;
  }

  private async verifiedTarget(
    journal: NormalizedPushJournal,
    candidate: TreeSnapshotV3,
    revision: string,
  ): Promise<TreeSnapshotV3> {
    const target = validateTreeSnapshotV3(
      await this.input.authority.readTarget(revision),
    );
    const targetHash = await treeRevisionContentHashV3(content(target));
    const candidateHash = await treeRevisionContentHashV3(content(candidate));
    if (
      target.protocolVersion !== "3" ||
      target.spaceId !== journal.binding.spaceId ||
      target.revision !== revision ||
      target.revisionContentHash !== journal.candidateHash ||
      targetHash !== journal.candidateHash ||
      candidate.revisionContentHash !== journal.candidateHash ||
      candidateHash !== journal.candidateHash ||
      !sameBytes(
        canonicalBytes(sortedContent(target)),
        canonicalBytes(sortedContent(candidate)),
      )
    )
      throw new Error("NORMALIZED_PUSH_FIXED_TARGET_MISMATCH");
    return target;
  }

  private async finishLocal(
    journal: NormalizedPushJournal,
    candidate: TreeSnapshotV3,
  ): Promise<void> {
    if (!journal.verifiedTarget)
      throw new Error("NORMALIZED_PUSH_TARGET_MISSING");
    const target = await this.verifiedTarget(
      journal,
      candidate,
      journal.verifiedTarget.revision,
    );
    const completion = await this.input.local.recover(journal, target);
    if (journal.mode === "remote_push")
      await this.child(journal).markVerified();
    const current = await this.requireJournal();
    if (current.phase !== "local_pending")
      throw new Error("NORMALIZED_PUSH_PARENT_PHASE_MISMATCH");
    const complete: NormalizedPushJournal = {
      ...current,
      verifiedTarget: journal.verifiedTarget,
      completion,
      phase: "complete",
    };
    await this.input.repository.write(complete);
    await this.input.repository.cleanup(complete);
  }

  private async reconcileChildSuperseded(
    journal: NormalizedPushJournal,
    child: TreePushServiceV3,
  ): Promise<boolean> {
    const state = await child.inspect();
    if (state?.remoteState !== "superseded") return false;
    const current = await this.requireJournal();
    if (current.phase !== "confirmed" && current.phase !== "remote_pending")
      throw new Error("NORMALIZED_PUSH_PARENT_PHASE_MISMATCH");
    await this.input.repository.write({ ...current, phase: "superseded" });
    return true;
  }

  async confirm(
    plan: NormalizedPushPlan,
    push: TreePushPreviewV3,
    candidate: TreeSnapshotV3,
    options?: SyncOperationOptions,
  ): Promise<void> {
    if (plan.localPlan.length === 0 && push.changes.length === 0) return;
    await this.revalidate(plan);
    const rawPageBytes = await this.rawPageBytes(plan, push);
    await this.input.repository.stage(plan, push, candidate, rawPageBytes);
    await this.recover(options);
  }

  async recover(options?: SyncOperationOptions): Promise<void> {
    let journal = await this.input.repository.read();
    if (!journal || journal.phase === "superseded") return;
    if (journal.phase === "complete") {
      await this.input.repository.cleanup(journal);
      return;
    }
    const frozen = await this.input.repository.loadConfirmed(journal);
    if (journal.phase === "local_pending") {
      await this.finishLocal(journal, frozen.candidate);
      return;
    }
    if (journal.mode === "local_only") {
      if (journal.phase !== "confirmed")
        throw new Error("NORMALIZED_PUSH_PARENT_PHASE_MISMATCH");
      await this.revalidate(frozen.plan, "confirmed_local_only");
      const target = await this.verifiedTarget(
        journal,
        frozen.candidate,
        journal.sourceRevision,
      );
      journal = {
        ...journal,
        verifiedTarget: {
          revision: target.revision,
          revisionContentHash: target.revisionContentHash,
        },
        phase: "local_pending",
      };
      await this.input.repository.write(journal);
      await this.finishLocal(journal, frozen.candidate);
      return;
    }

    const child = this.child(journal);
    let childState = await child.inspect();
    try {
      if (journal.phase === "confirmed") {
        if (!childState) await child.publishPrepared(frozen.push, options);
        else {
          await this.input.repository.write({
            ...journal,
            phase: "remote_pending",
          });
          await child.resumePending();
        }
      } else if (journal.phase === "remote_pending") {
        if (!childState) throw new Error("NORMALIZED_PUSH_CHILD_MISSING");
        await child.resumePending();
      } else {
        throw new Error("NORMALIZED_PUSH_PARENT_PHASE_MISMATCH");
      }
    } catch (error) {
      if (await this.reconcileChildSuperseded(journal, child)) return;
      throw error;
    }
    if (await this.reconcileChildSuperseded(journal, child)) return;
    childState = await child.inspect();
    if (childState?.remoteState !== "published" || !childState.result)
      throw new Error("NORMALIZED_PUSH_PUBLICATION_PENDING");
    journal = await this.requireJournal();
    const target = await this.verifiedTarget(
      journal,
      frozen.candidate,
      childState.result.revision,
    );
    journal = {
      ...journal,
      verifiedTarget: {
        revision: target.revision,
        revisionContentHash: target.revisionContentHash,
      },
      phase: "local_pending",
    };
    await this.input.repository.write(journal);
    await this.finishLocal(journal, frozen.candidate);
  }

  async cancel(): Promise<void> {
    const journal = await this.input.repository.read();
    if (!journal || journal.phase === "superseded") return;
    if (journal.phase === "complete")
      throw new Error("NORMALIZED_PUSH_ALREADY_COMPLETE");
    if (journal.phase === "local_pending") {
      if (journal.mode !== "local_only")
        throw new Error("NORMALIZED_PUSH_PUBLISHED_CANNOT_CANCEL");
      await this.input.local.rollbackUncommitted(journal);
      await this.input.repository.write({ ...journal, phase: "superseded" });
      return;
    }
    if (journal.mode === "local_only") {
      if (journal.phase !== "confirmed")
        throw new Error("NORMALIZED_PUSH_PARENT_PHASE_MISMATCH");
      await this.input.repository.write({ ...journal, phase: "superseded" });
      return;
    }
    const child = this.child(journal);
    const before = await child.inspect();
    if (!before) {
      if (journal.phase !== "confirmed")
        throw new Error("NORMALIZED_PUSH_CHILD_MISSING");
      await this.input.repository.write({ ...journal, phase: "superseded" });
      return;
    }
    await child.supersede();
    if (!(await this.reconcileChildSuperseded(journal, child)))
      throw new Error("NORMALIZED_PUSH_CANCEL_OUTCOME_UNKNOWN");
  }

  inspect(): Promise<NormalizedPushJournal | null> {
    return this.input.repository.read();
  }
}
