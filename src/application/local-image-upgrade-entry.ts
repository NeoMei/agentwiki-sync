import {
  canonicalBytes,
  pathKey,
  treeRevisionContentHashV2,
} from "@neomei/agentwiki-sync-protocol";

import type { AgentWikiClient } from "../agentwiki/client";
import { sha256Hex } from "../agentwiki/protocol";
import { SessionResponseSchema } from "../agentwiki/protocol";
import { V2TreeRemote } from "../agentwiki/v2-tree-remote";
import { V3TreeRemote } from "../agentwiki/v3-tree-remote";
import {
  initialTreeBindingRequirements,
  resolveExplicitInitialTreeBindings,
  type ExplicitInitialTreeBinding,
  type InitialTreeBindingRequirement,
  type ResolvedInitialTreeBindings,
} from "../core/initial-binding";
import { parseAttachmentReferences } from "../core/attachment-reference";
import type { LocalTreeScan, LocalTreeScanV3 } from "../core/tree-scan";
import { scanLocalTree } from "../core/tree-scan";
import {
  readPushProtocolRequirement,
  PushJournalRouter,
} from "../storage/push-journal-router";
import type { ControlStorePort } from "../ports/control-store";
import type { VaultPort } from "../ports/vault";
import { ConfirmedUpgradePreviewRepository } from "../storage/local-image-upgrade-confirmation";
import {
  inspectLocalImageUpgrade,
  LocalImageUpgradeRepository,
  type UpgradeBinding,
  type UpgradeIntent,
} from "../storage/local-image-upgrade";
import { TreeBaselineRepository } from "../storage/tree-baseline";
import {
  emptyTreeIdentityState,
  TreeIdentityRepository,
  upgradeTreeIdentityState,
  type TreeIdentityStateV2,
} from "../storage/tree-identities";
import { UpgradeLocalApply } from "./local-image-upgrade-local";
import {
  expectedV3PathStates,
  mergeLegacyUpgrade,
  prepareLegacyUpgradePreview,
  projectLegacyBase,
  type LegacyUpgradeBase,
  type UpgradePreview,
} from "./local-image-upgrade-plan";
import { LocalImageUpgradeCoordinator } from "./local-image-upgrade";
import type { ProtocolNegotiator } from "./protocol-negotiator";
import type { SyncOperationOptions } from "./progress";
import type { SpaceMapping } from "./sync-coordinator";
import {
  buildTreePullPreview,
  pendingTreeDecisionCount,
  rebuildTreeCalculationPreviewV3,
  resolveFolderConflict,
  resolvePageConflict,
  type TreePullPreviewV3,
} from "./tree-diff";
import type { PullPreview } from "./sync-runtime";
import type { TreeTransactionPathState } from "./tree-transaction";
import { TreePushServiceV3 } from "./tree-push-service-v3";
import { readTreeSnapshot } from "./tree-snapshot-reader";

const EMPTY_REVISION_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface LocalImageUpgradeAuthority {
  serverOrigin: string;
  serverInstanceId: string;
  pluginVersion: string;
  deviceId: string;
  credentialId: string;
  vaultId: string;
}

export interface LocalImageUpgradeEntryDeps {
  client: AgentWikiClient;
  protocols: ProtocolNegotiator;
  vault: VaultPort;
  control: ControlStorePort;
  controlRoot: string;
  mapping: SpaceMapping;
  authority: LocalImageUpgradeAuthority;
}

interface UpgradeDraftFixed {
  binding: UpgradeBinding;
  base: LegacyUpgradeBase;
  remote: LegacyUpgradeBase;
  rawLocal: LocalTreeScanV3;
  local: LocalTreeScanV3;
  identities: TreeIdentityStateV2;
  scanEpoch: number;
  oldBaselineEvidenceHash: string;
  v2CapabilitiesHash: string;
  v3CapabilitiesHash: string;
  v3Capabilities: UpgradePreview["push"]["capabilities"];
  initialBindingEvidence: ResolvedInitialTreeBindings["evidence"];
}

export interface LocalImageUpgradeDraft {
  kind: "upgrade_draft";
  fixed: UpgradeDraftFixed;
  merge: TreePullPreviewV3<LegacyUpgradeBase["projected"]>;
}

export interface LocalImageUpgradeInitialBindingRequired {
  kind: "initial_binding_required";
  fixed: Omit<UpgradeDraftFixed, "local" | "initialBindingEvidence">;
  requirements: InitialTreeBindingRequirement[];
}

export interface LocalImageUpgradeTextPreviewRequired {
  kind: "text_preview_required";
  draft: LocalImageUpgradeDraft;
}

export interface LocalImageUpgradeTextSyncPreview {
  kind: "text_sync_preview";
  draft: LocalImageUpgradeDraft;
  pull: PullPreview;
  candidate: {
    protocolVersion: "2";
    spaceId: string;
    folders: PullPreview["resolvedFolders"];
    pages: PullPreview["resolvedPages"];
  };
  candidateHash: string;
  expectedPathStates: Record<string, TreeTransactionPathState>;
  authorizationHash: string;
}

interface FreshUpgradeInputs {
  base: LegacyUpgradeBase;
  remote: LegacyUpgradeBase;
  rawLocal: LocalTreeScanV3;
  identities: TreeIdentityStateV2;
  oldBaselineEvidenceHash: string;
  v2CapabilitiesHash: string;
  v3CapabilitiesHash: string;
  v3Capabilities: UpgradeDraftFixed["v3Capabilities"];
}

function semanticLocal(
  local: LocalTreeScanV3,
  includeNormalizations = Object.hasOwn(local, "normalizations"),
  includeUnmanaged = Object.hasOwn(local, "unmanagedPaths"),
): unknown {
  return {
    rootPath: local.rootPath,
    folders: local.folders.map(({ updatedAt: _updatedAt, ...item }) => item),
    pages: local.pages.map(({ updatedAt: _updatedAt, ...item }) => item),
    attachments: local.attachments.map(
      ({ updatedAt: _updatedAt, ...item }) => item,
    ),
    blockers: local.blockers,
    rawPathStates: local.rawPathStates,
    ...(includeNormalizations ? { normalizations: local.normalizations } : {}),
    ...(includeUnmanaged ? { unmanagedPaths: local.unmanagedPaths } : {}),
  };
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalBytes(left).toString() === canonicalBytes(right).toString();
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function legacyScan(local: LocalTreeScanV3): LocalTreeScan {
  return {
    rootPath: local.rootPath,
    folders: structuredClone(local.folders),
    pages: local.pages.map(
      ({ referencedAttachmentIds: _attachmentIds, ...page }) => page,
    ),
  };
}

function mergeResultEvidence(merge: LocalImageUpgradeDraft["merge"]): unknown {
  return {
    actions: merge.actions,
    blockers: merge.blockers,
    attachmentConflicts: merge.attachmentConflicts,
    attachmentConflictResolutions: merge.attachmentConflictResolutions,
    folderConflicts: merge.folderConflicts,
    folderConflictResolutions: merge.folderConflictResolutions,
    pageConflicts: merge.pageConflicts,
    pageConflictResolutions: merge.pageConflictResolutions,
    resolvedFolders: merge.resolvedFolders,
    resolvedPages: merge.resolvedPages,
    resolvedAttachments: merge.resolvedAttachments,
  };
}

function retainFixedScanTimestamps(
  fresh: LocalTreeScanV3,
  fixed: LocalTreeScanV3,
): LocalTreeScanV3 {
  const folderTimes = new Map(
    fixed.folders.map((item) => [item.folderId, item.updatedAt]),
  );
  const pageTimes = new Map(
    fixed.pages.map((item) => [item.pageId, item.updatedAt]),
  );
  const attachmentTimes = new Map(
    fixed.attachments.map((item) => [item.attachmentId, item.updatedAt]),
  );
  return {
    ...structuredClone(fresh),
    folders: fresh.folders.map((item) => ({
      ...item,
      updatedAt: folderTimes.get(item.folderId) ?? item.updatedAt,
    })),
    pages: fresh.pages.map((item) => ({
      ...item,
      updatedAt: pageTimes.get(item.pageId) ?? item.updatedAt,
    })),
    attachments: fresh.attachments.map((item) => ({
      ...item,
      updatedAt: attachmentTimes.get(item.attachmentId) ?? item.updatedAt,
    })),
  };
}

function seedScanIdentities(
  input: TreeIdentityStateV2,
  local: LocalTreeScanV3,
): TreeIdentityStateV2 {
  const identities = structuredClone(input);
  const knownFolders = new Set([
    ...Object.keys(identities.folders),
    ...Object.keys(identities.pendingFolders),
  ]);
  for (const folder of local.folders)
    if (!knownFolders.has(folder.folderId))
      identities.pendingFolders[folder.folderId] = {
        folderId: folder.folderId,
        path: folder.path,
        pathKey: pathKey(folder.path),
      };
  for (const page of local.pages)
    if (!identities.pendingPages[page.pageId])
      identities.pendingPages[page.pageId] = {
        pageId: page.pageId,
        path: page.path,
        contentHash: page.contentHash,
      };
  for (const attachment of local.attachments)
    if (
      !identities.attachments[attachment.attachmentId] &&
      !identities.pendingAttachments[attachment.attachmentId]
    )
      identities.pendingAttachments[attachment.attachmentId] = {
        attachmentId: attachment.attachmentId,
        path: attachment.path,
        pathKey: pathKey(attachment.path),
        contentHash: attachment.contentHash,
      };
  return identities;
}

export class LocalImageUpgradeEntry {
  private readonly baseline: TreeBaselineRepository;
  private readonly identities: TreeIdentityRepository;
  private scanEpoch = 0;
  private pending: UpgradeIntent | null;
  private readonly invalidationListeners = new Set<() => void>();

  private constructor(
    private readonly deps: LocalImageUpgradeEntryDeps,
    pending: UpgradeIntent | null,
  ) {
    this.pending = pending;
    this.baseline = new TreeBaselineRepository(
      deps.control,
      deps.controlRoot,
      deps.mapping.spaceId,
      deps.mapping.rootPath,
    );
    this.identities = new TreeIdentityRepository(
      deps.control,
      `${deps.controlRoot}/tree-identities.json`,
    );
  }

  static async create(
    deps: LocalImageUpgradeEntryDeps,
  ): Promise<LocalImageUpgradeEntry> {
    const pending = await inspectLocalImageUpgrade(
      deps.control,
      deps.controlRoot,
      {
        serverInstanceId: deps.authority.serverInstanceId,
        spaceId: deps.mapping.spaceId,
        deviceId: deps.authority.deviceId,
        credentialId: deps.authority.credentialId,
        mappingRootKey: deps.mapping.rootPath,
      },
    );
    return new LocalImageUpgradeEntry(deps, pending);
  }

  get pendingIntent(): UpgradeIntent | null {
    return this.pending ? structuredClone(this.pending) : null;
  }

  invalidate(): void {
    this.scanEpoch += 1;
    for (const listener of this.invalidationListeners) listener();
  }

  onInvalidate(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  isCurrent(draft: LocalImageUpgradeDraft): boolean {
    return this.pending === null && draft.fixed.scanEpoch === this.scanEpoch;
  }

  private binding(): UpgradeBinding {
    return {
      operationId: crypto.randomUUID(),
      serverInstanceId: this.deps.authority.serverInstanceId,
      spaceId: this.deps.mapping.spaceId,
      deviceId: this.deps.authority.deviceId,
      credentialId: this.deps.authority.credentialId,
      mappingRootKey: this.deps.mapping.rootPath,
    };
  }

  private async assertSession(): Promise<void> {
    const session = SessionResponseSchema.parse(
      (await this.deps.client.raw("GET", "/api/integrations/obsidian/session"))
        .json,
    );
    const expected = this.deps.authority;
    if (
      session.serverInstanceId !== expected.serverInstanceId ||
      session.credentialId !== expected.credentialId ||
      session.deviceId !== expected.deviceId ||
      session.vaultId !== expected.vaultId ||
      session.credentialStatus !== "active"
    )
      throw new Error("UPGRADE_SESSION_BINDING_MISMATCH");
  }

  private async baselineInputs(): Promise<{
    base: LegacyUpgradeBase;
    evidenceHash: string;
  }> {
    const manifest = await this.baseline.readOptional();
    if (!manifest) {
      return {
        base: await projectLegacyBase({
          protocolVersion: "2",
          spaceId: this.deps.mapping.spaceId,
          revision: "0",
          revisionContentHash: EMPTY_REVISION_HASH,
          folders: [],
          pages: [],
        }),
        evidenceHash: await sha256Hex(
          canonicalBytes({
            kind: "missing_tree_baseline",
            spaceId: this.deps.mapping.spaceId,
            rootPath: this.deps.mapping.rootPath,
          }),
        ),
      };
    }
    if (manifest.protocolVersion !== "2")
      throw new Error("SPACE_PROTOCOL_INCONSISTENT");
    const snapshot = await this.baseline.readSnapshot();
    if (snapshot.protocolVersion !== "2")
      throw new Error("SPACE_PROTOCOL_INCONSISTENT");
    return {
      base: await projectLegacyBase({ ...snapshot, protocolVersion: "2" }),
      evidenceHash: await sha256Hex(
        canonicalBytes({ kind: "tree_baseline", manifest }),
      ),
    };
  }

  private async freshInputs(
    options?: SyncOperationOptions,
    seed?: LocalTreeScanV3,
    requirePublish = false,
    normalizeShortestImages = true,
  ): Promise<FreshUpgradeInputs> {
    const push = await readPushProtocolRequirement(
      this.deps.control,
      this.deps.controlRoot,
      {
        spaceId: this.deps.mapping.spaceId,
        normalizedAuthority: {
          serverOrigin: this.deps.authority.serverOrigin,
          serverInstanceId: this.deps.authority.serverInstanceId,
          deviceId: this.deps.authority.deviceId,
          credentialId: this.deps.authority.credentialId,
          vaultId: this.deps.authority.vaultId,
          mappingRootKey: this.deps.mapping.rootPath,
        },
      },
    );
    if (push) {
      const journal = (
        await new PushJournalRouter(
          this.deps.control,
          this.deps.controlRoot,
        ).read()
      )?.payload;
      if (
        ((journal?.schemaVersion === 1 || journal?.schemaVersion === 2) &&
          journal.remoteState !== "superseded" &&
          journal.localCommitPhase !== "verified") ||
        (journal?.schemaVersion === 4 &&
          journal.phase !== "complete" &&
          journal.phase !== "superseded")
      )
        throw new Error("PUSH_RECOVERY_REQUIRED");
    }
    await this.assertSession();
    const v3Selection = await this.deps.protocols.selectV3Fresh();
    const v2Selection = await this.deps.protocols.selectV2Fresh();
    const v3Remote = new V3TreeRemote(
      this.deps.client,
      this.deps.mapping.spaceId,
      v3Selection,
    );
    const space = (await v3Remote.spaces()).find(
      (item) => item.spaceId === this.deps.mapping.spaceId,
    );
    if (!space) throw new Error("SPACE_FORBIDDEN");
    if (space.syncMode !== "legacy_v2")
      throw new Error("SPACE_MODE_REFRESH_REQUIRED");
    if (requirePublish && !space.canPublish) throw new Error("SPACE_READ_ONLY");
    const v2Remote = new V2TreeRemote(
      this.deps.client,
      this.deps.mapping.spaceId,
      v2Selection,
    );
    const head = await v2Remote.head();
    if (
      head.spaceId !== this.deps.mapping.spaceId ||
      head.revision !== space.currentRevision
    )
      throw new Error("SPACE_MODE_REFRESH_REQUIRED");
    const remoteSnapshot = await readTreeSnapshot(
      v2Remote,
      this.deps.mapping.spaceId,
      head.revision,
      options,
    );
    if (
      remoteSnapshot.protocolVersion !== "2" ||
      remoteSnapshot.revisionContentHash !== head.revisionContentHash
    )
      throw new Error("BASE_STALE");
    const remote = await projectLegacyBase({
      ...remoteSnapshot,
      protocolVersion: "2",
    });
    const baseline = await this.baselineInputs();
    const identityBefore = upgradeTreeIdentityState(
      (await this.identities.read())?.payload ?? emptyTreeIdentityState(),
    );
    const scanIdentities = seed
      ? seedScanIdentities(identityBefore, seed)
      : structuredClone(identityBefore);
    const rootStatus = await this.deps.vault.rootStatus(
      this.deps.mapping.rootPath,
    );
    if (rootStatus === "missing") throw new Error("MAPPING_ROOT_MISSING");
    if (rootStatus === "file") throw new Error("MAPPING_ROOT_NOT_DIRECTORY");
    const epoch = this.scanEpoch;
    const rawLocal = await scanLocalTree(
      this.deps.vault,
      this.deps.mapping.rootPath,
      baseline.base.projected,
      scanIdentities,
      {
        ...v3Selection.capabilities,
        maxFolders: Math.min(
          v2Selection.capabilities.maxClientSpaceFolders,
          v3Selection.capabilities.maxClientSpaceFolders,
        ),
        maxPages: Math.min(
          v2Selection.capabilities.maxClientSpacePages,
          v3Selection.capabilities.maxClientSpacePages,
        ),
        maxPageBytes: Math.min(
          v2Selection.capabilities.maxPageBytes,
          v3Selection.capabilities.maxPageBytes,
        ),
        maxTotalBodyBytes: Math.min(
          v2Selection.capabilities.maxClientTotalBodyBytes,
          v3Selection.capabilities.maxClientTotalBodyBytes,
        ),
      },
      undefined,
      { normalizeShortestImages },
    );
    if (epoch !== this.scanEpoch) throw new Error("STALE_UPGRADE_PREVIEW");
    return {
      base: baseline.base,
      remote,
      rawLocal,
      identities: identityBefore,
      oldBaselineEvidenceHash: baseline.evidenceHash,
      v2CapabilitiesHash: v2Selection.capabilitiesHash,
      v3CapabilitiesHash: v3Selection.capabilitiesHash,
      v3Capabilities: v3Selection.capabilities,
    };
  }

  async prepare(
    options?: SyncOperationOptions,
  ): Promise<LocalImageUpgradeDraft | LocalImageUpgradeInitialBindingRequired> {
    if (this.pending) throw new Error("UPGRADE_RECOVERY_REQUIRED");
    const fresh = await this.freshInputs(options);
    if (fresh.rawLocal.attachments.length === 0)
      throw new Error("SYNC_PROTOCOL_UPGRADE_REQUIRED");
    const fixed = {
      binding: this.binding(),
      ...fresh,
      scanEpoch: this.scanEpoch,
    };
    const initialBase =
      fresh.base.projected.folders.length === 0 &&
      fresh.base.projected.pages.length === 0;
    const requirements = initialBase
      ? initialTreeBindingRequirements(fresh.rawLocal, fresh.remote.projected)
      : [];
    if (requirements.length > 0)
      return {
        kind: "initial_binding_required",
        fixed,
        requirements,
      };
    const initialBindingEvidence = {
      originalLocal: structuredClone(fresh.rawLocal),
      choices: [],
    };
    return {
      kind: "upgrade_draft",
      fixed: {
        ...fixed,
        local: structuredClone(fresh.rawLocal),
        initialBindingEvidence,
      },
      merge: await mergeLegacyUpgrade({
        base: fresh.base,
        remote: fresh.remote,
        local: fresh.rawLocal,
      }),
    };
  }

  async resolveInitialBindings(
    required: LocalImageUpgradeInitialBindingRequired,
    choices: ExplicitInitialTreeBinding[],
  ): Promise<LocalImageUpgradeDraft> {
    const resolved = resolveExplicitInitialTreeBindings(
      required.fixed.rawLocal,
      required.fixed.remote.projected,
      required.fixed.identities,
      choices,
    );
    return {
      kind: "upgrade_draft",
      fixed: {
        ...structuredClone(required.fixed),
        local: resolved.local,
        initialBindingEvidence: resolved.evidence,
      },
      merge: await mergeLegacyUpgrade({
        base: required.fixed.base,
        remote: required.fixed.remote,
        local: resolved.local,
      }),
    };
  }

  async recompute(
    input: LocalImageUpgradeDraft,
  ): Promise<LocalImageUpgradeDraft | LocalImageUpgradeTextPreviewRequired> {
    const draft = structuredClone(input);
    const merge = await rebuildTreeCalculationPreviewV3(draft.merge);
    const next = { ...draft, merge };
    return merge.resolvedAttachments.length === 0
      ? { kind: "text_preview_required", draft: next }
      : next;
  }

  private async rebuildFreshDraft(
    input: LocalImageUpgradeDraft,
    options: SyncOperationOptions | undefined,
    requirePublish: boolean,
  ): Promise<LocalImageUpgradeDraft> {
    if (!this.isCurrent(input)) throw new Error("STALE_UPGRADE_PREVIEW");
    const initial = input.fixed.initialBindingEvidence;
    const fresh = await this.freshInputs(
      options,
      initial.originalLocal,
      requirePublish,
    );
    if (!this.isCurrent(input)) throw new Error("STALE_UPGRADE_PREVIEW");
    const resolved = resolveExplicitInitialTreeBindings(
      fresh.rawLocal,
      fresh.remote.projected,
      fresh.identities,
      initial.choices,
    );
    if (
      fresh.oldBaselineEvidenceHash !== input.fixed.oldBaselineEvidenceHash ||
      fresh.v2CapabilitiesHash !== input.fixed.v2CapabilitiesHash ||
      fresh.v3CapabilitiesHash !== input.fixed.v3CapabilitiesHash ||
      !sameCanonical(fresh.base, input.fixed.base) ||
      !sameCanonical(fresh.remote, input.fixed.remote) ||
      !sameCanonical(
        semanticLocal(fresh.rawLocal),
        semanticLocal(initial.originalLocal),
      ) ||
      !sameCanonical(
        semanticLocal(resolved.local),
        semanticLocal(input.fixed.local),
      ) ||
      !sameCanonical(resolved.evidence.choices, initial.choices) ||
      !sameCanonical(fresh.identities, input.fixed.identities)
    )
      throw new Error("STALE_UPGRADE_PREVIEW");
    const stableLocal = retainFixedScanTimestamps(
      resolved.local,
      input.fixed.local,
    );
    const seeded = await mergeLegacyUpgrade({
      base: fresh.base,
      remote: fresh.remote,
      local: stableLocal,
    });
    seeded.folderConflictResolutions = structuredClone(
      input.merge.folderConflictResolutions,
    );
    seeded.pageConflictResolutions = structuredClone(
      input.merge.pageConflictResolutions,
    );
    seeded.attachmentConflictResolutions = structuredClone(
      input.merge.attachmentConflictResolutions,
    );
    const merge = await rebuildTreeCalculationPreviewV3(seeded);
    if (
      !sameCanonical(
        mergeResultEvidence(merge),
        mergeResultEvidence(input.merge),
      )
    )
      throw new Error("STALE_UPGRADE_PREVIEW");
    return {
      kind: "upgrade_draft",
      fixed: {
        binding: structuredClone(input.fixed.binding),
        ...fresh,
        local: stableLocal,
        scanEpoch: input.fixed.scanEpoch,
        initialBindingEvidence: structuredClone(initial),
      },
      merge,
    };
  }

  private async buildTextSyncPreview(
    draft: LocalImageUpgradeDraft,
  ): Promise<LocalImageUpgradeTextSyncPreview> {
    if (
      draft.merge.resolvedAttachments.length > 0 ||
      draft.merge.blockers.length > 0 ||
      pendingTreeDecisionCount(draft.merge) > 0
    )
      throw new Error("UPGRADE_PREVIEW_DECISION_REQUIRED");
    const tree = await buildTreePullPreview(
      draft.fixed.base.source,
      legacyScan(draft.fixed.local),
      draft.fixed.remote.source,
    );
    for (const [conflictId, resolution] of Object.entries(
      draft.merge.folderConflictResolutions,
    ).sort(([left], [right]) => left.localeCompare(right)))
      resolveFolderConflict(tree, conflictId, resolution);
    for (const [conflictId, resolution] of Object.entries(
      draft.merge.pageConflictResolutions,
    ).sort(([left], [right]) => left.localeCompare(right)))
      await resolvePageConflict(tree, conflictId, resolution);
    if (pendingTreeDecisionCount(tree) > 0)
      throw new Error("UPGRADE_PREVIEW_DECISION_REQUIRED");
    const pull: PullPreview = {
      ...tree,
      artifactRoots: [],
      scanEpoch: draft.fixed.scanEpoch,
      conflicts: tree.pageConflicts,
      conflictResolutions: tree.pageConflictResolutions,
      initialBindings: [],
      remotePages: draft.fixed.remote.source.pages,
      expectedVaultHashes: {},
      conflictValuePaths: {},
      localCandidates: tree.local.pages.map((page) => ({
        path: page.path,
        vaultByteHash: page.contentHash,
      })),
    };
    const candidate: LocalImageUpgradeTextSyncPreview["candidate"] = {
      protocolVersion: "2",
      spaceId: draft.fixed.remote.source.spaceId,
      folders: structuredClone(pull.resolvedFolders),
      pages: structuredClone(pull.resolvedPages),
    };
    const expectedCandidate = {
      protocolVersion: "2" as const,
      spaceId: draft.merge.remote.spaceId,
      folders: draft.merge.resolvedFolders,
      pages: draft.merge.resolvedPages.map(
        ({ referencedAttachmentIds: _attachmentIds, ...page }) => page,
      ),
    };
    if (!sameCanonical(candidate, expectedCandidate))
      throw new Error("UPGRADE_TEXT_CANDIDATE_MISMATCH");
    for (const page of candidate.pages)
      if (
        parseAttachmentReferences(page.body, page.path).some(
          (reference) =>
            reference.classification !== "external" &&
            reference.classification !== "page_embed",
        )
      )
        throw new Error("UPGRADE_TEXT_CANDIDATE_HAS_LOCAL_IMAGES");
    const expectedPathStates = expectedV3PathStates(
      draft.fixed.rawLocal,
      pull.actions,
    );
    const candidateHash = await treeRevisionContentHashV2(candidate);
    const authorizationHash = await sha256Hex(
      canonicalBytes({
        kind: "text_sync_preview",
        fixed: {
          binding: draft.fixed.binding,
          base: draft.fixed.base,
          remote: draft.fixed.remote,
          rawLocal: semanticLocal(draft.fixed.rawLocal),
          local: semanticLocal(draft.fixed.local),
          identities: draft.fixed.identities,
          scanEpoch: draft.fixed.scanEpoch,
          oldBaselineEvidenceHash: draft.fixed.oldBaselineEvidenceHash,
          v2CapabilitiesHash: draft.fixed.v2CapabilitiesHash,
          v3CapabilitiesHash: draft.fixed.v3CapabilitiesHash,
          initialBindingEvidence: draft.fixed.initialBindingEvidence,
        },
        decisions: {
          folders: draft.merge.folderConflictResolutions,
          pages: draft.merge.pageConflictResolutions,
          attachments: draft.merge.attachmentConflictResolutions,
        },
        candidateHash,
        actions: pull.actions,
        expectedPathStates,
      }),
    );
    return deepFreeze({
      kind: "text_sync_preview",
      draft: structuredClone(draft),
      pull,
      candidate,
      candidateHash,
      expectedPathStates,
      authorizationHash,
    });
  }

  async prepareTextSyncPreview(
    input: LocalImageUpgradeTextPreviewRequired,
    options?: SyncOperationOptions,
  ): Promise<LocalImageUpgradeTextSyncPreview> {
    const fresh = await this.rebuildFreshDraft(input.draft, options, false);
    return this.buildTextSyncPreview(fresh);
  }

  async revalidateTextSyncPreview(
    input: LocalImageUpgradeTextSyncPreview,
    options?: SyncOperationOptions,
  ): Promise<void> {
    const freshDraft = await this.rebuildFreshDraft(input.draft, options, true);
    const fresh = await this.buildTextSyncPreview(freshDraft);
    if (
      fresh.authorizationHash !== input.authorizationHash ||
      !sameCanonical(fresh.candidate, input.candidate) ||
      !sameCanonical(fresh.pull.actions, input.pull.actions) ||
      !sameCanonical(fresh.expectedPathStates, input.expectedPathStates) ||
      !this.isCurrent(input.draft)
    )
      throw new Error("STALE_UPGRADE_PREVIEW");
  }

  async finalizePreview(
    input: LocalImageUpgradeDraft,
    options?: SyncOperationOptions,
  ): Promise<UpgradePreview> {
    if (!this.isCurrent(input)) throw new Error("STALE_UPGRADE_PREVIEW");
    const draft = await this.recompute(input);
    if (!this.isCurrent(input)) throw new Error("STALE_UPGRADE_PREVIEW");
    if (draft.kind === "text_preview_required")
      throw new Error("UPGRADE_PREVIEW_NO_IMAGES_RECONFIRM_TEXT");
    if (pendingTreeDecisionCount(draft.merge) > 0)
      throw new Error("UPGRADE_PREVIEW_DECISION_REQUIRED");
    return prepareLegacyUpgradePreview({
      binding: draft.fixed.binding,
      base: draft.fixed.base,
      remote: draft.fixed.remote,
      local: draft.fixed.local,
      identities: draft.fixed.identities,
      scanEpoch: draft.fixed.scanEpoch,
      oldBaselineEvidenceHash: draft.fixed.oldBaselineEvidenceHash,
      capabilities: draft.fixed.v3Capabilities,
      capabilitiesHash: draft.fixed.v3CapabilitiesHash,
      v2CapabilitiesHash: draft.fixed.v2CapabilitiesHash,
      control: this.deps.control,
      controlRoot: this.deps.controlRoot,
      merge: draft.merge,
      initialBindingEvidence: draft.fixed.initialBindingEvidence,
      options,
    });
  }

  private async revalidate(preview: UpgradePreview): Promise<void> {
    const epoch = this.scanEpoch;
    const includeUnmanaged = Object.hasOwn(
      preview.localPlanEvidence,
      "unmanagedPaths",
    );
    const includeNormalizations = Object.hasOwn(
      preview.localPlanEvidence,
      "normalizations",
    );
    const initial = preview.localPlanEvidence.initialBindings;
    if (!initial) throw new Error("UPGRADE_INITIAL_BINDING_EVIDENCE_MISSING");
    const fresh = await this.freshInputs(
      undefined,
      initial.originalLocal,
      true,
      includeNormalizations,
    );
    if (!includeUnmanaged && fresh.rawLocal.unmanagedPaths?.length) {
      const intent = await new LocalImageUpgradeRepository(
        this.deps.control,
        this.deps.controlRoot,
        preview.binding,
      ).read();
      if (!intent) throw new Error("STALE_UPGRADE_PREVIEW");
      const owned = await new ConfirmedUpgradePreviewRepository(
        this.deps.control,
        this.deps.controlRoot,
      ).load(intent);
      if (!sameCanonical(owned, preview))
        throw new Error("STALE_UPGRADE_PREVIEW");
      for (const path of fresh.rawLocal.unmanagedPaths) {
        const expected = initial.originalLocal.rawPathStates[path];
        if (!expected || expected.kind !== "file" || !expected.hash)
          throw new Error("STALE_UPGRADE_PREVIEW");
        const bytes = await this.deps.vault.read(
          `${this.deps.mapping.rootPath}/${path}`,
        );
        if (!bytes || (await sha256Hex(bytes)) !== expected.hash)
          throw new Error("STALE_UPGRADE_PREVIEW");
        fresh.rawLocal.rawPathStates[path] = structuredClone(expected);
      }
      delete fresh.rawLocal.unmanagedPaths;
    }
    expectedV3PathStates(fresh.rawLocal, preview.localActions);
    const resolved = resolveExplicitInitialTreeBindings(
      fresh.rawLocal,
      fresh.remote.projected,
      fresh.identities,
      initial.choices,
    );
    if (
      fresh.oldBaselineEvidenceHash !== preview.oldBaselineEvidenceHash ||
      fresh.v2CapabilitiesHash !==
        preview.localPlanEvidence.v2CapabilitiesHash ||
      !sameCanonical(fresh.base.projected, preview.merge.base) ||
      fresh.v3CapabilitiesHash !== preview.push.capabilitiesHash ||
      fresh.remote.sourceRevision !== preview.remoteBase.sourceRevision ||
      fresh.remote.sourceV2RevisionHash !==
        preview.remoteBase.sourceV2RevisionHash ||
      !sameCanonical(fresh.remote, preview.remoteBase) ||
      !sameCanonical(
        semanticLocal(fresh.rawLocal, includeNormalizations, includeUnmanaged),
        semanticLocal(
          initial.originalLocal,
          includeNormalizations,
          includeUnmanaged,
        ),
      ) ||
      !sameCanonical(
        semanticLocal(resolved.local, includeNormalizations, includeUnmanaged),
        semanticLocal(
          preview.merge.local,
          includeNormalizations,
          includeUnmanaged,
        ),
      ) ||
      !sameCanonical(fresh.identities, preview.localPlanEvidence.identities)
    )
      throw new Error("STALE_UPGRADE_PREVIEW");
    if (epoch !== this.scanEpoch) throw new Error("STALE_UPGRADE_PREVIEW");
  }

  private coordinator(preview: UpgradePreview): LocalImageUpgradeCoordinator {
    const binding = preview.binding;
    const repository = new LocalImageUpgradeRepository(
      this.deps.control,
      this.deps.controlRoot,
      binding,
    );
    const confirmed = new ConfirmedUpgradePreviewRepository(
      this.deps.control,
      this.deps.controlRoot,
    );
    const remote = new V3TreeRemote(
      this.deps.client,
      this.deps.mapping.spaceId,
      {
        version: "3",
        capabilities: preview.push.capabilities,
        capabilitiesHash: preview.push.capabilitiesHash,
      },
    );
    let coordinator!: LocalImageUpgradeCoordinator;
    const push = new TreePushServiceV3(
      remote,
      this.deps.control,
      `${this.deps.controlRoot}/local-image-upgrade/${binding.operationId}/push`,
      {
        readBlob: (path) => this.deps.vault.read(path),
        revalidateConfirmation: async () => {
          await this.revalidate(preview);
          return preview.push.confirmationHash;
        },
      },
      {
        operationId: binding.operationId,
        assertSourceCurrent: (revision) =>
          coordinator.assertSourceCurrent(revision),
        onStaged: () => coordinator.onPushStaged(),
      },
    );
    const local = new UpgradeLocalApply({
      remote,
      push,
      control: this.deps.control,
      controlRoot: this.deps.controlRoot,
      baseline: this.baseline,
      identities: this.identities,
      vault: this.deps.vault,
      loadConfirmed: (intent) => confirmed.load(intent),
    });
    coordinator = new LocalImageUpgradeCoordinator(repository, push, {
      revalidate: (candidate) => this.revalidate(candidate),
      persistConfirmed: (intent, candidate) =>
        confirmed.persist(intent, candidate),
      loadConfirmed: (intent) => confirmed.load(intent),
      verifyPublished: (intent) => local.verifyPublished(intent),
      applyPublished: (intent, snapshot) =>
        local.applyPublished(intent, snapshot),
    });
    return coordinator;
  }

  async confirm(
    preview: UpgradePreview,
    authorizationHash: string,
    options?: SyncOperationOptions,
  ): Promise<void> {
    await this.coordinator(preview).confirm(
      preview,
      authorizationHash,
      options,
    );
    this.pending = null;
  }

  async recover(options?: SyncOperationOptions): Promise<void> {
    const intent = this.pending;
    if (!intent) return;
    const repository = new LocalImageUpgradeRepository(
      this.deps.control,
      this.deps.controlRoot,
      intent.binding,
    );
    if (intent.phase === "complete" || intent.phase === "superseded") {
      await repository.cleanupCompleted();
      this.pending = null;
      return;
    }
    const preview = await new ConfirmedUpgradePreviewRepository(
      this.deps.control,
      this.deps.controlRoot,
    ).load(intent);
    await this.coordinator(preview).recover(options);
    this.pending = await inspectLocalImageUpgrade(
      this.deps.control,
      this.deps.controlRoot,
      {
        serverInstanceId: this.deps.authority.serverInstanceId,
        spaceId: this.deps.mapping.spaceId,
        deviceId: this.deps.authority.deviceId,
        credentialId: this.deps.authority.credentialId,
        mappingRootKey: this.deps.mapping.rootPath,
      },
    );
  }
}
