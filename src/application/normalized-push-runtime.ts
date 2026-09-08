import {
  treeCapabilitiesHashV3,
  treeConfirmationHashV3,
  treeRevisionContentHashV3,
  type TreeSyncCapabilitiesV3,
} from "@neomei/agentwiki-sync-protocol";
import type { LocalTreeScanV3 } from "../core/tree-scan";
import type { TreeSnapshotV3 } from "../core/tree-model";
import { opaqueFileKey } from "../core/identity-key";
import type { VaultPort } from "../ports/vault";
import type { ControlStorePort } from "../ports/control-store";
import type { TreeRemotePortV3 } from "../ports/tree-remote";
import type { TreeBaselineRepository } from "../storage/tree-baseline";
import {
  emptyTreeIdentityState,
  upgradeTreeIdentityState,
  type TreeIdentityRepository,
} from "../storage/tree-identities";
import { NormalizedPushRepository } from "../storage/normalized-push";
import { NormalizedPushLocalCommitter } from "./normalized-push-local";
import { NormalizedPushCoordinator } from "./normalized-push";
import {
  normalizedPushPaths,
  sealNormalizedPushPlan,
  type NormalizedPushPlan,
} from "./normalized-push-plan";
import { prepareTreePushChangesV3 } from "./local-image-upgrade-plan";
import { readTreeSnapshotV3 } from "./tree-snapshot-reader";
import type { TreePushPreviewV3 } from "./tree-push-service-v3";
import type { SyncOperationOptions } from "./progress";
import { canonicalBytes, sha256Hex } from "../agentwiki/protocol";
import { readPushProtocolRequirement } from "../storage/push-journal-router";
import {
  normalizedPlan,
  type NormalizedPushJournal,
} from "./normalized-push-plan";

export interface NormalizedRuntimeAuthority {
  serverOrigin: string;
  serverInstanceId: string;
  deviceId: string;
  credentialId: string;
  vaultId: string;
}

type PreparedNormalization = {
  plan: NormalizedPushPlan;
  candidate: TreeSnapshotV3;
};

export class NormalizedPushRuntimeAdapter {
  readonly coordinator: NormalizedPushCoordinator;
  private readonly repository: NormalizedPushRepository;
  private readonly previews = new WeakMap<
    NormalizedPushPlan,
    { candidate: TreeSnapshotV3; push: TreePushPreviewV3 }
  >();

  constructor(
    private readonly input: {
      authority: NormalizedRuntimeAuthority;
      mapping: { spaceId: string; rootPath: string };
      vault: VaultPort;
      control: ControlStorePort;
      controlRoot: string;
      remote: TreeRemotePortV3;
      baseline: TreeBaselineRepository;
      identities: TreeIdentityRepository;
      scan: (
        base: TreeSnapshotV3,
        caps: TreeSyncCapabilitiesV3,
        options?: SyncOperationOptions,
      ) => Promise<LocalTreeScanV3>;
      epoch: () => number;
    },
  ) {
    this.repository = new NormalizedPushRepository(
      input.control,
      input.controlRoot,
    );
    this.coordinator = new NormalizedPushCoordinator({
      ...input,
      repository: this.repository,
      local: new NormalizedPushLocalCommitter(input),
      authority: {
        revalidate: (plan, mode) => this.revalidate(plan, mode),
        readTarget: (revision) =>
          readTreeSnapshotV3(input.remote, input.mapping.spaceId, revision),
      },
    });
  }

  private async candidate(
    base: TreeSnapshotV3,
    local: LocalTreeScanV3,
    push: TreePushPreviewV3,
  ): Promise<TreeSnapshotV3> {
    const tree = structuredClone(local);
    for (const change of push.changes) {
      if (change.operation === "upsert_page") {
        const page = tree.pages.find((p) => p.pageId === change.page.pageId);
        if (page) page.updatedAt = change.page.updatedAt;
      } else if (change.operation === "upsert_folder") {
        const folder = tree.folders.find(
          (f) => f.folderId === change.folder.folderId,
        );
        if (folder) folder.updatedAt = change.folder.updatedAt;
      } else if (change.operation === "upsert_attachment") {
        const attachment = tree.attachments.find(
          (a) => a.attachmentId === change.attachment.attachmentId,
        );
        if (attachment) attachment.updatedAt = change.attachment.updatedAt;
      }
    }
    const prepared = await prepareTreePushChangesV3({
      base,
      candidate: {
        protocolVersion: "3",
        spaceId: this.input.mapping.spaceId,
        folders: tree.folders,
        pages: tree.pages,
        attachments: tree.attachments,
      },
      vaultRoot: this.input.mapping.rootPath,
      control: this.input.control,
      payloadRoot: `${this.input.controlRoot}/push-preview/revalidation`,
      stagePages: false,
    });
    const confirmationHash = await treeConfirmationHashV3({
      protocolVersion: "3",
      spaceId: this.input.mapping.spaceId,
      baseRevision: base.revision,
      capabilitiesHash: push.capabilitiesHash,
      changes: prepared.changes.map((change) => {
        if (change.operation === "upsert_page") {
          const {
            payloadPath: _path,
            bodyBytes: _bytes,
            ...page
          } = change.page;
          return { operation: change.operation, page };
        }
        if (change.operation === "upsert_attachment")
          return { operation: change.operation, attachment: change.attachment };
        return change;
      }),
    });
    if (confirmationHash !== push.confirmationHash)
      throw new Error("NORMALIZED_PUSH_AUTHORIZATION_CHANGED");
    return {
      ...prepared.candidate,
      revision: base.revision,
      revisionContentHash: await treeRevisionContentHashV3(prepared.candidate),
    };
  }

  private async seal(
    base: TreeSnapshotV3,
    local: LocalTreeScanV3,
    push: TreePushPreviewV3,
    candidate: TreeSnapshotV3,
    operationId: string,
    transactionId: string,
    scanEpoch = this.input.epoch(),
  ): Promise<NormalizedPushPlan> {
    const paths = normalizedPushPaths(this.input.controlRoot, operationId);
    const localPlan = await Promise.all(
      local.normalizations.map(async (normalization) => {
        const page = candidate.pages.find(
          (p) =>
            p.pageId === normalization.pageId &&
            p.path === normalization.pagePath,
        );
        if (!page) throw new Error("NORMALIZED_PAGE_MISSING");
        return {
          kind: "write_page" as const,
          pageId: page.pageId,
          path: page.path,
          beforeHash: normalization.rawHash,
          contentHash: page.contentHash,
          byteLength: new TextEncoder().encode(page.body).byteLength,
          payloadPath: `${paths.payloadRoot}/${await opaqueFileKey(page.pageId)}.md`,
        };
      }),
    );
    return sealNormalizedPushPlan({
      mode: push.changes.length ? "remote_push" : "local_only",
      binding: {
        ...this.input.authority,
        operationId,
        spaceId: this.input.mapping.spaceId,
        mappingRootKey: this.input.mapping.rootPath,
      },
      sourceRevision: base.revision,
      sourceTreeHash: base.revisionContentHash,
      capabilitiesHash: push.capabilitiesHash,
      wireConfirmationHash: push.confirmationHash,
      candidateHash: candidate.revisionContentHash,
      localTransactionId: transactionId,
      localPlan,
      normalizations: local.normalizations,
      rawPathStates: local.rawPathStates,
      identities: upgradeTreeIdentityState(
        (await this.input.identities.read())?.payload ??
          emptyTreeIdentityState(),
      ),
      scanEpoch,
    });
  }

  async prepare(
    base: TreeSnapshotV3,
    local: LocalTreeScanV3,
    push: TreePushPreviewV3,
  ): Promise<PreparedNormalization | null> {
    if (!local.normalizations.length) return null;
    const candidate = await this.candidate(base, local, push);
    const plan = await this.seal(
      base,
      local,
      push,
      candidate,
      crypto.randomUUID(),
      crypto.randomUUID(),
    );
    for (const action of plan.localPlan) {
      const page = candidate.pages.find((p) => p.pageId === action.pageId)!;
      await this.input.control.write(action.payloadPath, page.body);
    }
    this.previews.set(plan, {
      candidate: structuredClone(candidate),
      push: structuredClone(push),
    });
    return { plan, candidate };
  }

  private async revalidate(
    plan: NormalizedPushPlan,
    mode: "current_head" | "confirmed_local_only" = "current_head",
  ): Promise<string> {
    const epoch = this.input.epoch();
    const authority = {
      ...this.input.authority,
      spaceId: this.input.mapping.spaceId,
      mappingRootKey: this.input.mapping.rootPath,
      operationId: plan.binding.operationId,
    };
    if (
      canonicalBytes(authority).toString() !==
      canonicalBytes(plan.binding).toString()
    )
      throw new Error("NORMALIZED_PUSH_AUTHORITY_CHANGED");
    await readPushProtocolRequirement(
      this.input.control,
      this.input.controlRoot,
      {
        spaceId: this.input.mapping.spaceId,
        normalizedAuthority: {
          ...this.input.authority,
          mappingRootKey: this.input.mapping.rootPath,
        },
      },
    );
    const journal = await this.repository.read();
    if (
      mode === "confirmed_local_only" &&
      (!journal ||
        journal.binding.operationId !== plan.binding.operationId ||
        journal.mode !== "local_only" ||
        journal.phase !== "confirmed" ||
        plan.mode !== "local_only")
    )
      throw new Error("NORMALIZED_PUSH_RECOVERY_OWNERSHIP_MISMATCH");
    let stored;
    if (journal?.binding.operationId === plan.binding.operationId) {
      stored = await this.repository.loadConfirmed(journal);
      if (
        canonicalBytes(stored.plan).toString() !==
        canonicalBytes(normalizedPlan(plan as NormalizedPushJournal)).toString()
      )
        throw new Error("NORMALIZED_PUSH_AUTHORIZATION_CHANGED");
    } else {
      stored = this.previews.get(plan);
      if (!stored || epoch !== plan.scanEpoch)
        throw new Error("NORMALIZED_PUSH_PREVIEW_MISSING");
    }
    const base = await this.input.baseline.readSnapshot();
    if (
      !base ||
      base.protocolVersion !== "3" ||
      base.revision !== plan.sourceRevision ||
      base.revisionContentHash !== plan.sourceTreeHash
    )
      throw new Error("BASE_STALE");
    if (mode !== "confirmed_local_only") {
      const head = await this.input.remote.head();
      if (
        head.revision !== plan.sourceRevision ||
        head.revisionContentHash !== plan.sourceTreeHash
      )
        throw new Error("BASE_STALE");
    }
    const capabilities = await this.input.remote.capabilities();
    if (
      (await treeCapabilitiesHashV3(capabilities)) !== plan.capabilitiesHash ||
      (await this.input.remote.capabilitiesHash) !== plan.capabilitiesHash
    )
      throw new Error("CAPABILITIES_CHANGED");
    const local = await this.input.scan(base, capabilities);
    if (local.blockers.length) throw new Error("V3_PUSH_BLOCKED");
    if (journal?.binding.operationId === plan.binding.operationId) {
      for (const [path, expected] of Object.entries(plan.rawPathStates)) {
        if (
          !path.startsWith("pages/") ||
          path.toLowerCase().endsWith(".md") ||
          expected.kind !== "file"
        )
          continue;
        if (!expected.hash || !local.unmanagedPaths?.includes(path))
          throw new Error("NORMALIZED_PUSH_AUTHORIZATION_CHANGED");
        const bytes = await this.input.vault.read(
          `${this.input.mapping.rootPath}/${path}`,
        );
        if (!bytes || (await sha256Hex(bytes)) !== expected.hash)
          throw new Error("NORMALIZED_PUSH_AUTHORIZATION_CHANGED");
        local.rawPathStates[path] = structuredClone(expected);
      }
    }
    const candidate = await this.candidate(base, local, stored.push);
    const current = await this.seal(
      base,
      local,
      stored.push,
      candidate,
      plan.binding.operationId,
      plan.localTransactionId,
      plan.scanEpoch,
    );
    if (this.input.epoch() !== epoch)
      throw new Error("NORMALIZED_PUSH_PREVIEW_STALE");
    return current.authorizationHash;
  }
}
