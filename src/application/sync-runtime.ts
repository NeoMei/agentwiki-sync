import {
  FlatAttachmentPathSchema,
  validatePortableMarkdownPath,
  treeCapabilitiesHashV3,
  treeConfirmationHashV3,
  treeRevisionContentHashV3,
  treeRevisionContentHashV2,
  pathKey,
  type BlobRequirementV3,
  type TreeDeltaItemV3,
  type TreeSyncCapabilitiesV3,
} from "@neomei/agentwiki-sync-protocol";

import { canonicalBytes, contentHash, sha256Hex } from "../agentwiki/protocol";
import { AgentWikiHttpError } from "../agentwiki/client";
import { decodeVaultMarkdown } from "../core/markdown";
import { parseAttachmentReferences } from "../core/attachment-reference";
import type {
  AttachmentPullAction,
  StructuredConflict,
  TreePullAction,
  TreePullActionV3,
} from "../core/merge";
import type {
  LocalTreeScan,
  LocalTreeScanV3,
  TreeScanLimits,
} from "../core/tree-scan";
import { scanLocalTree } from "../core/tree-scan";
import {
  NormalizedPushRuntimeAdapter,
  type NormalizedRuntimeAuthority,
} from "./normalized-push-runtime";
import {
  normalizedPushPaths,
  type NormalizedPushPlan,
  type NormalizedPushJournal,
} from "./normalized-push-plan";
import {
  PushJournalRouter,
  readPushProtocolRequirement,
} from "../storage/push-journal-router";
import type {
  TreeDeltaItem,
  TreeAttachment,
  TreeFolder,
  TreePage,
  TreeSnapshot,
  TreeSnapshotV3,
} from "../core/tree-model";
import type { ControlStorePort } from "../ports/control-store";
import type { PushRemotePort } from "../ports/push-remote";
import type {
  TreeRemotePort,
  TreeRemotePortV3,
  TreeSyncLimits,
} from "../ports/tree-remote";
import type { VaultPort } from "../ports/vault";
import { BaselineRepository } from "../storage/baseline";
import { MutableControlRepository } from "../storage/envelope";
import { TreeBaselineRepository } from "../storage/tree-baseline";
import {
  BlobStagingRepository,
  type BlobStagingJournal,
} from "../storage/blob-staging";
import {
  emptyTreeIdentityState,
  upgradeTreeIdentityState,
  TreeIdentityRepository,
  type TreeAttachmentIdentity,
  type TreeIdentityStateV2,
  type TreeIdentityState,
  type TreePendingAttachmentIdentity,
} from "../storage/tree-identities";
import {
  buildTreePullPreview,
  buildTreePullPreviewV3,
  pendingTreeDecisionCount,
  resolveFolderConflict,
  resolvePageConflict,
  type PageConflictResolution,
  type TreePullPreview,
  type TreePullPreviewV3,
} from "./tree-diff";
import { BlobTransfer } from "./blob-transfer";
import {
  TreeTransaction,
  type TreeTransactionPathState,
} from "./tree-transaction";
import { PullTransaction } from "./pull-transaction";
import { PushService } from "./push-service";
import {
  TreePushService,
  type PreparedTreePushChange,
} from "./tree-push-service";
import {
  TreePushServiceV3,
  type PreparedTreePushChangeV3,
  type TreePushPreviewV3,
} from "./tree-push-service-v3";
import type { SpaceMapping } from "./sync-coordinator";
import {
  cancellationCheckpoint,
  progressCheckpoint,
  reportProgress,
  type SyncOperationOptions,
} from "./progress";
import { readTreeSnapshot, readTreeSnapshotV3 } from "./tree-snapshot-reader";
import {
  expectedV3PathStates,
  prepareTreePushChangesV3,
} from "./local-image-upgrade-plan";
import {
  applyV3ControlAfter,
  desiredV3Identities,
  isV3PullControlAfterState,
  prefixTreePullActionV3,
  verifyResolvedV3Vault,
  type V3PullControlAfterState,
} from "./tree-local-apply-v3";

export type ConflictResolution = PageConflictResolution;

export interface InitialBindingChoice {
  pageId: string;
  remotePath: string;
  remoteBody: string;
  remoteBodyPath?: string;
  localPath: string | null;
  localBody: string | null;
  localVaultByteHash: string | null;
  resolution: "local" | "remote" | "manual" | null;
  manualBody?: string;
}

export interface LocalCandidate {
  path: string;
  vaultByteHash: string;
}

export interface TreeLocalStatus {
  foldersAdded: TreeFolder[];
  foldersMoved: TreeFolder[];
  foldersDeleted: TreeFolder[];
  added: TreePage[];
  modified: TreePage[];
  renamed: TreePage[];
  deleted: TreePage[];
  ambiguous: TreePage[];
}

export interface RuntimeStatus {
  protocolVersion: "1" | "2";
  baseRevision: string;
  remoteRevision: string;
  local: TreeLocalStatus;
}

export interface TreeLocalStatusV3 extends TreeLocalStatus {
  attachmentsAdded: TreeAttachment[];
  attachmentsModified: TreeAttachment[];
  attachmentsRenamed: TreeAttachment[];
  attachmentsDetached: TreeAttachment[];
  attachmentBlockers: LocalTreeScanV3["blockers"];
  attachmentPageCounts: Record<string, number>;
}

export interface RuntimeStatusV3 {
  protocolVersion: "3";
  baseRevision: string;
  remoteRevision: string;
  local: TreeLocalStatusV3;
  capabilities: TreeSyncCapabilitiesV3;
}

export type PublishablePushPreviewV3 = TreePushPreviewV3 & {
  normalizedPush: {
    plan: NormalizedPushPlan;
    candidate: TreeSnapshotV3;
  } | null;
  publishable: true;
  blockers: [];
};

export interface BlockedPushPreviewV3 {
  normalizedPush: null;
  protocolVersion: "3";
  publishable: false;
  spaceId: string;
  baseRevision: string;
  changes: [];
  blockers: LocalTreeScanV3["blockers"];
  capabilities: TreeSyncCapabilitiesV3;
  capabilitiesHash: string;
  credentialId?: string | null;
}

export type PushPreviewV3 = PublishablePushPreviewV3 | BlockedPushPreviewV3;

export interface RemoteDelta {
  baseRevision: string;
  remoteRevision: string;
  ahead: boolean;
  listed: boolean;
  items: TreeDeltaItem[];
}

export interface RemoteDeltaV3 {
  protocolVersion: "3";
  baseRevision: string;
  remoteRevision: string;
  ahead: boolean;
  listed: boolean;
  items: TreeDeltaItemV3[];
  resultingPages: Array<{
    pageId: string;
    path: string;
    referencedAttachmentIds: string[];
  }>;
}

export interface PullPreview extends TreePullPreview {
  artifactRoots: string[];
  scanEpoch: number;
  conflicts: StructuredConflict[];
  conflictResolutions: Record<string, ConflictResolution>;
  initialBindings: InitialBindingChoice[];
  remotePages: TreePage[];
  expectedVaultHashes: Record<string, string | null>;
  conflictValuePaths: Record<
    string,
    { base: string; local: string; remote: string }
  >;
  localCandidates: LocalCandidate[];
}

export interface PullPreviewV3 extends TreePullPreviewV3 {
  artifactRoots: string[];
  scanEpoch: number;
  capabilities: TreeSyncCapabilitiesV3;
  transferId: string | null;
  expectedVaultPathStates: Record<string, TreeTransactionPathState>;
  sameRevisionMissingAttachmentIds?: string[];
}

export interface PullPreviewV3Behavior {
  repairSameRevisionMissingRemoteAttachments?: true;
}

export interface ApplyPullGuard {
  expectedPathStates: Record<string, TreeTransactionPathState>;
  revalidate: () => Promise<void>;
}

export interface PushPreview {
  spaceId: string;
  baseRevision: string;
  changes: PreparedTreePushChange[];
  capabilities: TreeSyncLimits;
  credentialId?: string | null;
  previewId: string;
}

interface MoveHint {
  pageId: string;
  fromPath: string;
  toPath: string;
  observedVaultByteHash: string;
}
interface MoveHintsState {
  schemaVersion: 1;
  hints: MoveHint[];
}
const isMoveHints = (value: unknown): value is MoveHintsState =>
  !!value &&
  typeof value === "object" &&
  (value as Partial<MoveHintsState>).schemaVersion === 1 &&
  Array.isArray((value as Partial<MoveHintsState>).hints);

interface PendingIdentities {
  schemaVersion: 1;
  entries: Record<
    string,
    | { intent: "create"; pageId: string; path: string; contentHash: string }
    | {
        intent: "restore";
        pageId: string;
        path: string;
        contentHash: string;
        archivedBasePath: string;
        archivedBaseTitle: string;
        archivedBaseContentHash: string;
      }
  >;
}
const isPendingIdentities = (value: unknown): value is PendingIdentities => {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<PendingIdentities>;
  if (
    state.schemaVersion !== 1 ||
    !state.entries ||
    typeof state.entries !== "object"
  )
    return false;
  for (const entry of Object.values(state.entries)) {
    if (!entry || typeof entry !== "object") return false;
    const intent = (entry as { intent?: unknown }).intent;
    if (
      typeof (entry as { pageId?: unknown }).pageId !== "string" ||
      typeof (entry as { path?: unknown }).path !== "string" ||
      typeof (entry as { contentHash?: unknown }).contentHash !== "string" ||
      (intent !== "create" && intent !== "restore")
    )
      return false;
  }
  return true;
};
interface PullControlAfterState {
  schemaVersion: 1;
  transactionId: string;
  phase: "pending" | "applied";
  identities: PendingIdentities;
  moveHints: MoveHintsState;
}

const isPullControlAfterState = (
  value: unknown,
): value is PullControlAfterState => {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<PullControlAfterState>;
  return (
    state.schemaVersion === 1 &&
    typeof state.transactionId === "string" &&
    ["pending", "applied"].includes(state.phase ?? "") &&
    isPendingIdentities(state.identities) &&
    isMoveHints(state.moveHints)
  );
};

const safeKey = (value: string) => value.replace(/[^A-Za-z0-9_-]/gu, "_");
const joinRoot = (root: string, relative: string) =>
  root ? `${root}/${relative}` : relative;
const emptySnapshot = (
  protocolVersion: "1" | "2",
  spaceId: string,
): TreeSnapshot => ({
  protocolVersion,
  spaceId,
  revision: "0",
  revisionContentHash: "",
  folders: [],
  pages: [],
});

export class SyncRuntime {
  private normalizedPush: NormalizedPushRuntimeAdapter | null = null;
  private normalizedAuthority: NormalizedRuntimeAuthority | null = null;
  private scanEpoch = 0;
  private readonly invalidationListeners = new Set<() => void>();
  private readonly pushPreviewBindings = new WeakMap<
    PushPreviewV3,
    { epoch: number; authority: NormalizedRuntimeAuthority | null }
  >();
  private readonly root: string;
  private readonly treeBaseline: TreeBaselineRepository;
  private readonly legacyBaseline: BaselineRepository;
  private readonly identities: TreeIdentityRepository;
  private readonly moveHints: MutableControlRepository<MoveHintsState>;
  private readonly pullControlAfter: MutableControlRepository<PullControlAfterState>;
  private readonly v3PullControlAfter: MutableControlRepository<V3PullControlAfterState>;
  private renameQueue: Promise<void> = Promise.resolve();
  private suppressRenameHints = 0;
  private remoteV3: TreeRemotePortV3 | null;

  constructor(
    private readonly vault: VaultPort,
    private readonly control: ControlStorePort,
    private readonly remote: TreeRemotePort | null,
    private readonly mapping: SpaceMapping,
    deviceKey = "local",
    spaceKey = safeKey(mapping.spaceId),
    private readonly credentialId: string | null = null,
    private readonly legacyRemote: PushRemotePort | null = null,
  ) {
    this.remoteV3 = null;
    this.root =
      ".agentwiki/devices/d-" +
      safeKey(deviceKey) +
      "/spaces/s-" +
      safeKey(spaceKey);
    this.treeBaseline = new TreeBaselineRepository(
      control,
      this.root,
      mapping.spaceId,
      mapping.rootPath,
    );
    this.legacyBaseline = new BaselineRepository(
      control,
      this.root,
      mapping.spaceId,
      mapping.rootPath,
    );
    this.identities = new TreeIdentityRepository(
      control,
      this.root + "/tree-identities.json",
    );
    this.moveHints = new MutableControlRepository(
      control,
      this.root + "/move-hints.json",
      isMoveHints,
    );
    this.pullControlAfter = new MutableControlRepository(
      control,
      this.root + "/pull-control-after.json",
      isPullControlAfterState,
    );
    this.v3PullControlAfter = new MutableControlRepository(
      control,
      this.root + "/v3-pull-control-after.json",
      isV3PullControlAfterState,
    );
  }

  static v3(
    vault: VaultPort,
    control: ControlStorePort,
    remote: TreeRemotePortV3,
    mapping: SpaceMapping,
    deviceKey = "local",
    spaceKey = safeKey(mapping.spaceId),
    credentialId: string | null = null,
  ): SyncRuntime {
    const runtime = new SyncRuntime(
      vault,
      control,
      null,
      mapping,
      deviceKey,
      spaceKey,
      credentialId,
    );
    runtime.remoteV3 = remote;
    return runtime;
  }

  invalidate(): void {
    this.scanEpoch += 1;
    for (const listener of this.invalidationListeners) listener();
  }

  onInvalidate(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => {
      this.invalidationListeners.delete(listener);
    };
  }

  isPushPreviewCurrent(preview: PushPreviewV3): boolean {
    const binding = this.pushPreviewBindings.get(preview);
    return (
      preview.publishable &&
      !!binding &&
      binding.epoch === this.scanEpoch &&
      binding.authority === this.normalizedAuthority &&
      (!this.normalizedAuthority || !!this.normalizedPush)
    );
  }

  async inspectNormalizedPush(): Promise<NormalizedPushJournal | null> {
    if (!this.normalizedPush)
      throw new Error("NORMALIZED_PUSH_AUTHORITY_REQUIRED");
    await this.readJournalSchemaVersion(this.root + "/push/journal.json");
    return this.normalizedPush.coordinator.inspect();
  }

  async cancelNormalizedPush(): Promise<void> {
    if (!this.normalizedPush)
      throw new Error("NORMALIZED_PUSH_AUTHORITY_REQUIRED");
    await this.readJournalSchemaVersion(this.root + "/push/journal.json");
    await this.normalizedPush.coordinator.cancel();
  }

  configureNormalizedPush(authority: NormalizedRuntimeAuthority): void {
    const keys = [
      "serverOrigin",
      "serverInstanceId",
      "deviceId",
      "credentialId",
      "vaultId",
    ] as const;
    if (
      !authority ||
      Object.keys(authority).length !== keys.length ||
      keys.some(
        (key) =>
          typeof authority[key] !== "string" ||
          authority[key].trim().length === 0,
      )
    )
      throw new Error("NORMALIZED_PUSH_AUTHORITY_INVALID");
    if (this.normalizedAuthority) {
      if (
        keys.every(
          (key) => this.normalizedAuthority![key] === authority[key],
        ) &&
        this.normalizedPush
      )
        return;
      this.invalidate();
      this.normalizedPush = null;
      throw new Error("NORMALIZED_PUSH_AUTHORITY_CHANGED");
    }
    if (authority.credentialId !== this.credentialId)
      throw new Error("NORMALIZED_PUSH_AUTHORITY_INVALID");
    this.normalizedAuthority = structuredClone(authority);
    this.normalizedPush = new NormalizedPushRuntimeAdapter({
      authority: this.normalizedAuthority,
      mapping: this.mapping,
      vault: this.vault,
      control: this.control,
      controlRoot: this.root,
      remote: this.requireV3Remote(),
      baseline: this.treeBaseline,
      identities: this.identities,
      scan: (base, caps, options) =>
        this.scanV3(base, caps, options, true, false),
      epoch: () => this.scanEpoch,
    });
  }

  get spaceId(): string {
    return this.mapping.spaceId;
  }

  get protocolVersion(): "1" | "2" | "3" {
    return (
      this.remoteV3?.protocolVersion ?? this.legacyTreeRemote.protocolVersion
    );
  }

  private get legacyTreeRemote(): TreeRemotePort {
    if (!this.remote) throw new Error("SYNC_PROTOCOL_UPGRADE_REQUIRED");
    return this.remote;
  }

  async recordRename(fromPath: string, toPath: string): Promise<void> {
    if (this.suppressRenameHints > 0) return;
    const operation = this.renameQueue.then(() =>
      this.recordRenameNow(fromPath, toPath),
    );
    this.renameQueue = operation.catch(() => undefined);
    return operation;
  }

  private async withoutRenameHints<T>(operation: () => Promise<T>): Promise<T> {
    this.suppressRenameHints += 1;
    try {
      return await operation();
    } finally {
      this.suppressRenameHints -= 1;
    }
  }

  private async recordRenameNow(
    fromPath: string,
    toPath: string,
  ): Promise<void> {
    const prefix = this.mapping.rootPath ? this.mapping.rootPath + "/" : "";
    if (
      (prefix &&
        (!fromPath.startsWith(prefix) || !toPath.startsWith(prefix))) ||
      (!prefix && (!fromPath || !toPath))
    )
      return;
    if (
      fromPath.includes(".agentwiki-tmp-") ||
      toPath.includes(".agentwiki-tmp-")
    )
      return;
    const baseV3 = await this.readBaseSnapshotV3();
    const fromRel = fromPath.slice(prefix.length);
    const toRel = toPath.slice(prefix.length);
    const toAttachmentPath = FlatAttachmentPathSchema.safeParse(toRel);
    const attachment = baseV3?.attachments.find(
      (item) => pathKey(item.path) === pathKey(fromRel),
    );
    if (attachment) {
      if (!toAttachmentPath.success) return;
      const bytes = await this.vault.read(toPath);
      if (!bytes || (await sha256Hex(bytes)) !== attachment.contentHash) return;
      const identities = await this.readIdentities();
      if (identities.schemaVersion === 2) {
        const attachments = (identities.attachments ??= {});
        attachments[attachment.attachmentId] = {
          attachmentId: attachment.attachmentId,
          path: toAttachmentPath.data,
          pathKey: pathKey(toAttachmentPath.data),
          baseContentHash: attachment.contentHash,
          active: true,
        };
      } else {
        // Schema 1 remains durable until a confirmed v3 activation. A rename
        // hint can still preserve the stable ID as pending without activating
        // schema 2 merely because Obsidian emitted a file event.
        (identities.pendingAttachments ??= {})[attachment.attachmentId] = {
          attachmentId: attachment.attachmentId,
          path: toAttachmentPath.data,
          pathKey: pathKey(toAttachmentPath.data),
          contentHash: attachment.contentHash,
        };
      }
      await this.identities.write(identities);
      return;
    }
    const base = baseV3 ?? (await this.readBaseSnapshot());
    if (!base) return;
    const page = base.pages.find(
      (item) => pathKey(item.path) === pathKey(fromRel),
    );
    if (!page || !page.path.startsWith("pages/") || !toRel.startsWith("pages/"))
      return;
    try {
      validatePortableMarkdownPath(toRel);
    } catch {
      return;
    }
    const bytes = await this.vault.read(toPath);
    if (!bytes) return;
    const current = (await this.moveHints.read())?.payload.hints ?? [];
    const hints = current.filter((item) => item.pageId !== page.pageId);
    hints.push({
      pageId: page.pageId,
      fromPath: page.path,
      toPath: toRel,
      observedVaultByteHash: await sha256Hex(bytes),
    });
    await this.moveHints.write({ schemaVersion: 1, hints });
  }

  private async readIdentities(): Promise<TreeIdentityState> {
    return (await this.identities.read())?.payload ?? emptyTreeIdentityState();
  }

  private async readBaseSnapshot(): Promise<TreeSnapshot | null> {
    const manifest = await this.treeBaseline.readOptional();
    if (manifest) {
      const snapshot = await this.treeBaseline.readSnapshot();
      if (snapshot.protocolVersion === "3")
        throw new Error("Sync v3 runtime is not enabled yet");
      return snapshot;
    }
    return this.treeBaseline.readLegacyEvidence(this.legacyBaseline);
  }

  private async readBaseSnapshotV3(): Promise<TreeSnapshotV3 | null> {
    const manifest = await this.treeBaseline.readOptional();
    if (!manifest) return null;
    const snapshot = await this.treeBaseline.readSnapshot();
    if (snapshot.protocolVersion !== "3") return null;
    return snapshot;
  }

  private async scan(
    options?: SyncOperationOptions,
    preBindPages?: TreePage[],
  ): Promise<LocalTreeScan> {
    const epoch = this.scanEpoch;
    const status = await this.vault.rootStatus(this.mapping.rootPath);
    if (status === "missing") throw new Error("MAPPING_ROOT_MISSING");
    if (status === "file") throw new Error("MAPPING_ROOT_NOT_DIRECTORY");
    const capabilities = await this.legacyTreeRemote.capabilities();
    const base = await this.readBaseSnapshot();
    const identities = await this.readIdentities();
    const hints = (await this.moveHints.read())?.payload.hints ?? [];
    for (const hint of hints) {
      const bytes = await this.vault.read(
        joinRoot(this.mapping.rootPath, hint.toPath),
      );
      if (!bytes) continue;
      const body = decodeVaultMarkdown(bytes).normalized;
      identities.pendingPages[hint.pageId] = {
        pageId: hint.pageId,
        path: hint.toPath,
        contentHash: await contentHash(body),
      };
    }
    if (preBindPages) {
      const baseIds = new Set((base?.pages ?? []).map((page) => page.pageId));
      for (const page of preBindPages) {
        if (!baseIds.has(page.pageId) && !identities.pendingPages[page.pageId])
          identities.pendingPages[page.pageId] = {
            pageId: page.pageId,
            path: page.path,
            contentHash: page.contentHash,
          };
      }
    }
    reportProgress(options, {
      phase: "scan",
      completed: 0,
      cancellable: true,
    });
    const limits: TreeScanLimits = {
      maxFolders: capabilities.maxClientSpaceFolders ?? 10000,
      maxPages: capabilities.maxClientSpacePages,
      maxPageBytes: capabilities.maxPageBytes,
      maxTotalBodyBytes: capabilities.maxClientTotalBodyBytes,
    };
    const local = await scanLocalTree(
      this.vault,
      this.mapping.rootPath,
      base ??
        emptySnapshot(
          this.legacyTreeRemote.protocolVersion,
          this.mapping.spaceId,
        ),
      identities,
      limits,
      async (completed) => {
        await progressCheckpoint(options, {
          phase: "scan",
          completed,
          total: undefined,
          cancellable: true,
        });
      },
    );
    if (this.legacyTreeRemote.protocolVersion === "1") {
      local.folders = [];
      for (const page of local.pages) page.folderId = null;
      identities.pendingFolders = {};
    }
    if (epoch !== this.scanEpoch) throw new Error("扫描纪元已变更");
    await this.identities.write(identities);
    return local;
  }

  private async downloadRemoteSnapshot(
    revision: string,
    options?: SyncOperationOptions,
  ): Promise<TreeSnapshot> {
    return readTreeSnapshot(
      this.legacyTreeRemote,
      this.mapping.spaceId,
      revision,
      options,
    );
  }

  private requireV3Remote(): TreeRemotePortV3 {
    if (!this.remoteV3) throw new Error("SYNC_PROTOCOL_UPGRADE_REQUIRED");
    return this.remoteV3;
  }

  private emptySnapshotV3(): TreeSnapshotV3 {
    return {
      protocolVersion: "3",
      spaceId: this.mapping.spaceId,
      revision: "0",
      revisionContentHash: "",
      folders: [],
      pages: [],
      attachments: [],
    };
  }

  private async downloadRemoteSnapshotV3(
    revision: string,
    options?: SyncOperationOptions,
  ): Promise<TreeSnapshotV3> {
    return readTreeSnapshotV3(
      this.requireV3Remote(),
      this.mapping.spaceId,
      revision,
      options,
    );
  }

  private async scanV3(
    base: TreeSnapshotV3,
    capabilities: TreeSyncCapabilitiesV3,
    options?: SyncOperationOptions,
    normalizeShortestImages = false,
    persistIdentities = true,
  ): Promise<LocalTreeScanV3> {
    const epoch = this.scanEpoch;
    const status = await this.vault.rootStatus(this.mapping.rootPath);
    if (status === "missing") throw new Error("MAPPING_ROOT_MISSING");
    if (status === "file") throw new Error("MAPPING_ROOT_NOT_DIRECTORY");
    const identities = await this.readIdentities();
    const hints = (await this.moveHints.read())?.payload.hints ?? [];
    const scanBase = structuredClone(base);
    for (const hint of hints) {
      const page = scanBase.pages.find((item) => item.pageId === hint.pageId);
      if (!page || !hint.toPath.startsWith("pages/")) continue;
      try {
        validatePortableMarkdownPath(hint.toPath);
      } catch {
        continue;
      }
      page.path = hint.toPath;
    }
    const renamedById = new Map<
      string,
      TreeAttachmentIdentity | TreePendingAttachmentIdentity
    >([
      ...Object.values(identities.attachments ?? {})
        .filter((identity) => identity.active)
        .map((identity) => [identity.attachmentId, identity] as const),
      ...Object.values(identities.pendingAttachments ?? {}).map(
        (identity) => [identity.attachmentId, identity] as const,
      ),
    ]);
    scanBase.attachments = scanBase.attachments.map((attachment) => {
      const identity = renamedById.get(attachment.attachmentId);
      return identity &&
        ("baseContentHash" in identity
          ? identity.baseContentHash
          : identity.contentHash) === attachment.contentHash
        ? { ...attachment, path: identity.path }
        : attachment;
    });
    reportProgress(options, {
      phase: "scan",
      completed: 0,
      cancellable: true,
    });
    const scan = await scanLocalTree(
      this.vault,
      this.mapping.rootPath,
      scanBase,
      identities,
      {
        ...capabilities,
        maxFolders: capabilities.maxClientSpaceFolders,
        maxPages: capabilities.maxClientSpacePages,
        maxTotalBodyBytes: capabilities.maxClientTotalBodyBytes,
      },
      async (completed) =>
        progressCheckpoint(options, {
          phase: "scan",
          completed,
          cancellable: true,
        }),
      {
        normalizeShortestImages:
          normalizeShortestImages && this.normalizedPush !== null,
      },
    );
    if (epoch !== this.scanEpoch) throw new Error("扫描纪元已变更");
    if (persistIdentities) {
      for (const hint of hints) {
        const page = scan.pages.find(
          (item) => item.pageId === hint.pageId && item.path === hint.toPath,
        );
        if (page)
          identities.pendingPages[page.pageId] = {
            pageId: page.pageId,
            path: page.path,
            contentHash: page.contentHash,
          };
      }
      await this.identities.write(identities);
    }
    return scan;
  }

  private async discardOrphanPreviews(): Promise<void> {
    for (const dir of ["push-preview"]) {
      try {
        await this.control.removeTree?.(this.root + "/" + dir);
      } catch {
        // Best-effort: orphaned preview artifacts are inert.
      }
    }
  }

  private async discardTerminalPullPreviewBodies(): Promise<void> {
    try {
      await this.control.removeTree?.(this.root + "/tree-preview-body");
    } catch {
      // Terminal transaction metadata no longer depends on preview bodies.
    }
  }

  private async readJournalSchemaVersion(path: string): Promise<number | null> {
    if (path === this.root + "/push/journal.json") {
      const requirement = await readPushProtocolRequirement(
        this.control,
        this.root,
        {
          spaceId: this.mapping.spaceId,
          ...(this.normalizedAuthority
            ? {
                normalizedAuthority: {
                  ...this.normalizedAuthority,
                  mappingRootKey: this.mapping.rootPath,
                },
              }
            : {}),
        },
      );
      return requirement?.schemaVersion ?? null;
    }
    let best: { writeGeneration: number; version: number } | null = null;
    for (const candidate of [path, path + ".prev", path + ".next"]) {
      const raw = await this.control.read(candidate);
      if (raw === null) continue;
      let parsed: {
        envelopeSchemaVersion?: unknown;
        writeGeneration?: unknown;
        payload?: { schemaVersion?: unknown };
      };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        throw new Error("控制存储已损坏");
      }
      if (
        typeof parsed.envelopeSchemaVersion === "number" &&
        parsed.envelopeSchemaVersion > 1
      )
        throw new Error("不支持的控制存储版本");
      if (parsed.envelopeSchemaVersion !== 1) throw new Error("控制存储已损坏");
      const version = parsed.payload?.schemaVersion;
      if (typeof version !== "number") continue;
      const writeGeneration =
        typeof parsed.writeGeneration === "number" ? parsed.writeGeneration : 0;
      if (!best || writeGeneration > best.writeGeneration)
        best = { writeGeneration, version };
    }
    return best ? best.version : null;
  }

  private prefixAction(action: TreePullAction): TreePullAction {
    const prefix = this.mapping.rootPath ? this.mapping.rootPath + "/" : "";
    const bodyPath = (path: string): string => this.root + "/" + path;
    switch (action.kind) {
      case "create_directory":
      case "trash_directory":
      case "trash_page":
        return { ...action, path: prefix + action.path };
      case "create_page":
        return {
          ...action,
          path: prefix + action.path,
          bodyPath: bodyPath(action.bodyPath),
        };
      case "write_page":
        return {
          ...action,
          path: prefix + action.path,
          bodyPath: bodyPath(action.bodyPath),
          ...(action.beforePath
            ? { beforePath: prefix + action.beforePath }
            : {}),
        };
      case "move_page":
        return {
          ...action,
          fromPath: prefix + action.fromPath,
          path: prefix + action.path,
          bodyPath: bodyPath(action.bodyPath),
          ...(action.beforePath
            ? { beforePath: prefix + action.beforePath }
            : {}),
        };
      case "move_directory":
        return {
          ...action,
          fromPath: prefix + action.fromPath,
          path: prefix + action.path,
          ...(action.beforePath
            ? { beforePath: prefix + action.beforePath }
            : {}),
        };
    }
  }

  private prefixActionV3(action: TreePullActionV3): TreePullActionV3 {
    return prefixTreePullActionV3(action, this.mapping.rootPath, this.root);
  }

  private expectedV3VaultPathStates(
    local: LocalTreeScanV3,
    actions: TreePullActionV3[],
  ): Record<string, TreeTransactionPathState> {
    return expectedV3PathStates(local, actions);
  }

  private async readVaultPathState(
    path: string,
  ): Promise<TreeTransactionPathState> {
    const kind = await this.vault.pathStatus(path);
    if (kind === "directory") return { kind, hash: null };
    if (kind === "missing") return { kind, hash: null };
    const bytes = await this.vault.read(path);
    return {
      kind: "file",
      hash: bytes ? await sha256Hex(bytes) : null,
    };
  }

  private async assertV3PreviewVaultState(
    preview: PullPreviewV3,
    expectedPathStates: Record<string, TreeTransactionPathState>,
  ): Promise<void> {
    if (preview.scanEpoch !== this.scanEpoch)
      throw new Error("STALE_PULL_PREVIEW");
    {
      const scannedFresh = await this.scanV3(
        preview.base,
        preview.capabilities,
        undefined,
        preview.local.normalizations.length > 0,
        false,
      );
      const repair = preview.sameRevisionMissingAttachmentIds?.length
        ? await this.repairSameRevisionMissingRemoteAttachments(
            scannedFresh,
            preview.base,
            preview.remote,
          )
        : { local: scannedFresh, attachmentIds: [] };
      const fresh = repair.local;
      if (
        JSON.stringify(repair.attachmentIds) !==
        JSON.stringify(preview.sameRevisionMissingAttachmentIds ?? [])
      )
        throw new Error("STALE_PULL_PREVIEW");
      expectedV3PathStates(fresh, preview.actions);
      if (
        fresh.blockers.length ||
        canonicalBytes(fresh.normalizations).toString() !==
          canonicalBytes(preview.local.normalizations).toString()
      )
        throw new Error("STALE_PULL_PREVIEW");
    }
    for (const [path, expected] of Object.entries(expectedPathStates)) {
      if (
        (await this.vault.pathStatus(path)) === "file" &&
        (expected.kind !== "file" || !expected.hash)
      )
        throw new Error("STALE_PULL_PREVIEW");
      const actual = await this.readVaultPathState(path);
      if (actual.kind !== expected.kind || actual.hash !== expected.hash)
        throw new Error("STALE_PULL_PREVIEW");
    }
  }

  private async assertVaultPathStates(
    expectedPathStates: Record<string, TreeTransactionPathState>,
  ): Promise<void> {
    for (const [path, expected] of Object.entries(expectedPathStates)) {
      const actual = await this.readVaultPathState(path);
      if (actual.kind !== expected.kind || actual.hash !== expected.hash)
        throw new Error("STALE_PULL_PREVIEW");
    }
  }

  async establishEmptyBase(): Promise<void> {
    const head = await this.legacyTreeRemote.head();
    await this.treeBaseline.prepare(
      {
        protocolVersion: "2",
        spaceId: this.mapping.spaceId,
        revision: head.revision,
        revisionContentHash: "",
        folders: [],
        pages: [],
      },
      "initialize",
    );
    await this.treeBaseline.commit();
  }

  async recover(): Promise<void> {
    if (
      (await this.readJournalSchemaVersion(
        this.root + "/push/journal.json",
      )) === 4
    ) {
      if (!this.normalizedPush)
        throw new Error("NORMALIZED_PUSH_AUTHORITY_REQUIRED");
      await this.normalizedPush.coordinator.recover();
    }
    await this.discardOrphanPreviews();
    const pullVersion = await this.readJournalSchemaVersion(
      this.root + "/pull/journal.json",
    );
    if (pullVersion === 1) await this.recoverLegacyPull();
    else if (pullVersion === 2 || pullVersion === 3)
      await this.recoverTreePull();
    else if (pullVersion !== null) throw new Error("不支持的拉取日志版本");

    const pushVersion = await this.readJournalSchemaVersion(
      this.root + "/push/journal.json",
    );
    if (this.remoteV3 && (pushVersion === 1 || pushVersion === 2)) {
      // A separate image upgrade can leave the old owner's proven terminal root.
      // The router retains it and rejects pending/foreign candidates before v3 proceeds.
      await new PushJournalRouter(this.control, this.root).v3Port().read();
      return;
    }
    if (pushVersion === 1) await this.recoverLegacyPush();
    else if (pushVersion === 2) await this.recoverTreePush();
    else if (pushVersion === 3) {
      if (!this.remoteV3) throw new Error("不支持的推送日志版本");
      await this.recoverTreePushV3();
    } else if (pushVersion !== null && pushVersion !== 4)
      throw new Error("不支持的推送日志版本");
  }

  private async recoverLegacyPull(): Promise<void> {
    const pullTx = new PullTransaction(
      this.vault,
      this.control,
      this.root + "/pull",
    );
    const pull = await pullTx.inspect();
    let committedTransactionId: string | null =
      pull?.state === "committed" ? pull.transactionId : null;
    if (pull && !committedTransactionId) {
      await pullTx.recover();
      const recovered = await pullTx.inspect();
      committedTransactionId =
        recovered?.state === "committed" ? recovered.transactionId : null;
    }
    await this.legacyBaseline.recover(committedTransactionId);
    if (committedTransactionId)
      await this.applyPullControlAfter(committedTransactionId);
  }

  private async applyPullControlAfter(transactionId: string): Promise<void> {
    const after = await this.pullControlAfter.read();
    if (
      !after ||
      after.payload.transactionId !== transactionId ||
      after.payload.phase === "applied"
    )
      return;
    const identities = await this.readIdentities();
    for (const entry of Object.values(after.payload.identities.entries))
      identities.pendingPages[entry.pageId] = {
        pageId: entry.pageId,
        path: entry.path,
        contentHash: entry.contentHash,
      };
    await this.identities.write(identities);
    const current = (await this.moveHints.read())?.payload.hints ?? [];
    const merged = new Map(
      after.payload.moveHints.hints.map((hint) => [hint.pageId, hint]),
    );
    for (const hint of current) merged.set(hint.pageId, hint);
    await this.moveHints.write({
      schemaVersion: 1,
      hints: [...merged.values()],
    });
    await this.pullControlAfter.write({ ...after.payload, phase: "applied" });
  }

  private async recoverTreePull(): Promise<void> {
    const treeTx = new TreeTransaction(
      this.vault,
      this.control,
      this.root + "/pull",
    );
    const tree = await treeTx.inspect();
    const v3After = await this.v3PullControlAfter.read();
    if (tree?.schemaVersion === 3 && tree.deferCommit) {
      if ((tree.state === "verified" || tree.state === "committed") && !v3After)
        throw new Error("V3_PULL_CONTROL_RECOVERY_EVIDENCE_MISSING");
      if (
        (tree.state === "verified" || tree.state === "committed") &&
        v3After?.payload.transactionId !== tree.transactionId
      )
        throw new Error("V3_PULL_CONTROL_STATE_INCONSISTENT");
      if (tree.state === "committed" && v3After?.payload.phase !== "applied")
        throw new Error("V3_PULL_CONTROL_STATE_INCONSISTENT");
      if (tree.state === "verified") {
        await treeTx.assertApplied();
        const baselineJournal = await this.treeBaseline.inspectJournal();
        const currentBaseline = await this.treeBaseline.readOptional();
        if (baselineJournal?.transactionId !== tree.transactionId) {
          if (
            currentBaseline &&
            currentBaseline.baseRevision !== tree.baseRevision
          )
            throw new Error("V3_BASELINE_RECOVERY_EVIDENCE_MISSING");
          await this.withoutRenameHints(() => treeTx.rollbackVerified());
          await new BlobStagingRepository(
            this.control,
            this.root + "/pull-staging",
          ).cleanup();
          await this.discardTerminalPullPreviewBodies();
          return;
        }
        await this.treeBaseline.recover(tree.transactionId);
        const recoveredBaselineJournal =
          await this.treeBaseline.inspectJournal();
        if (recoveredBaselineJournal?.phase !== "committed")
          throw new Error("V3_BASELINE_RECOVERY_STATE_INCONSISTENT");
        const baseline = await this.treeBaseline.readOptional();
        if (!baseline || baseline.schemaVersion !== 3)
          throw new Error("V3_BASELINE_RECOVERY_EVIDENCE_MISSING");
        await this.applyV3ControlAfter(tree.transactionId);
        await treeTx.markCommitted();
      } else if (tree.state === "committed") {
        const baselineJournal = await this.treeBaseline.inspectJournal();
        if (
          baselineJournal?.transactionId === tree.transactionId &&
          baselineJournal.phase !== "committed"
        )
          throw new Error("V3_BASELINE_RECOVERY_STATE_INCONSISTENT");
        const baseline = await this.treeBaseline.readOptional();
        if (!baseline || baseline.schemaVersion !== 3)
          throw new Error("V3_BASELINE_RECOVERY_EVIDENCE_MISSING");
        if (!baselineJournal && baseline.baseRevision !== tree.targetRevision)
          throw new Error("V3_BASELINE_RECOVERY_EVIDENCE_MISSING");
      } else {
        await this.withoutRenameHints(() => treeTx.recover());
        await this.treeBaseline.recover(null);
      }
      await new BlobStagingRepository(
        this.control,
        this.root + "/pull-staging",
      ).cleanup();
      const terminalTree = await treeTx.inspect();
      if (
        terminalTree?.state === "committed" ||
        terminalTree?.state === "rolled_back"
      )
        await this.discardTerminalPullPreviewBodies();
      return;
    }
    let committedTransactionId: string | null =
      tree?.state === "committed" ? tree.transactionId : null;
    if (tree && !committedTransactionId) {
      await this.withoutRenameHints(() => treeTx.recover());
      const recovered = await treeTx.inspect();
      committedTransactionId =
        recovered?.state === "committed" ? recovered.transactionId : null;
    }
    await this.treeBaseline.recover(committedTransactionId);
    const terminalTree = await treeTx.inspect();
    if (
      terminalTree?.state === "committed" ||
      terminalTree?.state === "rolled_back"
    )
      await this.discardTerminalPullPreviewBodies();
  }

  private async recoverLegacyPush(): Promise<void> {
    if (!this.legacyRemote) throw new Error("缺少旧版推送恢复所需的连接");
    const pushService = new PushService(
      this.legacyRemote,
      this.control,
      this.root + "/push",
    );
    const push = await pushService.inspect();
    if (!push || push.localCommitPhase === "verified") return;
    const credentialRotated =
      this.credentialId !== null &&
      push.credentialIdAtCreation !== null &&
      this.credentialId !== push.credentialIdAtCreation;
    if (
      credentialRotated &&
      push.remoteState !== "published" &&
      push.remoteState !== "superseded"
    ) {
      await pushService.supersede();
      return;
    }
    if (push.remoteState === "superseded") return;
    const result =
      push.remoteState === "published" && push.result
        ? push.result
        : await pushService.resume();
    if (!result) throw new Error("PUSH_RECOVERY_REQUIRED");
    await pushService.markVerified();
  }

  private async recoverTreePush(): Promise<void> {
    const pushService = new TreePushService(
      this.legacyTreeRemote,
      this.control,
      this.root + "/push",
    );
    const push = await pushService.inspect();
    if (!push || push.localCommitPhase === "verified") return;
    const credentialRotated =
      this.credentialId !== null &&
      push.credentialIdAtCreation !== null &&
      this.credentialId !== push.credentialIdAtCreation;
    if (
      credentialRotated &&
      push.remoteState !== "published" &&
      push.remoteState !== "superseded"
    ) {
      await pushService.supersede();
      return;
    }
    if (push.remoteState === "superseded") return;
    const result =
      push.remoteState === "published" && push.result
        ? push.result
        : await pushService.resume();
    if (!result) throw new Error("PUSH_RECOVERY_REQUIRED");
    const base = await this.readBaseSnapshot();
    if (!base || base.revision !== result.revision) {
      await this.commitBaseline(
        await this.downloadRemoteSnapshot(result.revision),
        "push",
      );
    }
    await this.clearIdentities();
    await pushService.markVerified();
  }

  private v3PushService(): TreePushServiceV3 {
    return new TreePushServiceV3(
      this.requireV3Remote(),
      this.control,
      this.root + "/push",
      {
        readBlob: (vaultPath) => this.vault.read(vaultPath),
        revalidateConfirmation: async ({
          spaceId,
          baseRevision,
          capabilitiesHash,
          changes: expectedChanges,
        }) => {
          if (spaceId !== this.mapping.spaceId)
            throw new Error("PUSH_SPACE_MISMATCH");
          const base = await this.readBaseSnapshotV3();
          if (!base || base.revision !== baseRevision)
            throw new Error("BASE_STALE");
          const capabilities = await this.requireV3Remote().capabilities();
          if ((await treeCapabilitiesHashV3(capabilities)) !== capabilitiesHash)
            throw new Error("CAPABILITIES_CHANGED");
          const local = await this.scanV3(base, capabilities);
          const changes = await this.preparePushChangesV3(
            base,
            local,
            undefined,
            false,
          );
          const expectedUpdatedAt = new Map<string, string>();
          for (const change of expectedChanges) {
            if (change.operation === "upsert_folder")
              expectedUpdatedAt.set(
                `folder:${change.folder.folderId}`,
                change.folder.updatedAt,
              );
            else if (change.operation === "upsert_page")
              expectedUpdatedAt.set(
                `page:${change.page.pageId}`,
                change.page.updatedAt,
              );
            else if (change.operation === "upsert_attachment")
              expectedUpdatedAt.set(
                `attachment:${change.attachment.attachmentId}`,
                change.attachment.updatedAt,
              );
          }
          for (const change of changes) {
            if (change.operation === "upsert_folder")
              change.folder.updatedAt =
                expectedUpdatedAt.get(`folder:${change.folder.folderId}`) ??
                change.folder.updatedAt;
            else if (change.operation === "upsert_page")
              change.page.updatedAt =
                expectedUpdatedAt.get(`page:${change.page.pageId}`) ??
                change.page.updatedAt;
            else if (change.operation === "upsert_attachment")
              change.attachment.updatedAt =
                expectedUpdatedAt.get(
                  `attachment:${change.attachment.attachmentId}`,
                ) ?? change.attachment.updatedAt;
          }
          return treeConfirmationHashV3({
            protocolVersion: "3",
            spaceId,
            baseRevision,
            capabilitiesHash,
            changes: changes.map((change) => this.pushManifestChangeV3(change)),
          });
        },
      },
      undefined,
      new PushJournalRouter(this.control, this.root).v3Port(),
    );
  }

  private async recoverTreePushV3(): Promise<void> {
    const service = this.v3PushService();
    const push = await service.inspect();
    if (!push || push.localCommitPhase === "verified") return;
    const credentialRotated =
      this.credentialId !== null &&
      push.credentialIdAtCreation !== null &&
      this.credentialId !== push.credentialIdAtCreation;
    if (
      credentialRotated &&
      push.remoteState !== "published" &&
      push.remoteState !== "superseded"
    ) {
      await service.supersede();
      return;
    }
    if (push.remoteState === "superseded") return;
    const result =
      push.remoteState === "published" && push.result
        ? push.result
        : await service.resumePending();
    if (!result) {
      if ((await service.inspect())?.remoteState === "superseded") return;
      throw new Error("PUSH_RECOVERY_REQUIRED");
    }
    await this.finishV3Push(service, result);
  }

  async status(options?: SyncOperationOptions): Promise<RuntimeStatus> {
    const base = await this.readBaseSnapshot();
    const local = await this.scan(options);
    const head = await this.legacyTreeRemote.head();
    return {
      protocolVersion: this.legacyTreeRemote.protocolVersion,
      baseRevision: base?.revision ?? "0",
      remoteRevision: head.revision,
      local: computeTreeStatus(
        base ??
          emptySnapshot(
            this.legacyTreeRemote.protocolVersion,
            this.mapping.spaceId,
          ),
        local,
      ),
    };
  }

  async statusV3(options?: SyncOperationOptions): Promise<RuntimeStatusV3> {
    const remote = this.requireV3Remote();
    const base = (await this.readBaseSnapshotV3()) ?? this.emptySnapshotV3();
    const capabilities = await remote.capabilities();
    const local = await this.scanV3(base, capabilities, options);
    const head = await remote.head();
    return {
      protocolVersion: "3",
      baseRevision: base.revision,
      remoteRevision: head.revision,
      local: computeTreeStatusV3(base, local),
      capabilities,
    };
  }

  async remoteDelta(): Promise<RemoteDelta> {
    const base = await this.readBaseSnapshot();
    const head = await this.legacyTreeRemote.head();
    const baseRevision = base?.revision ?? "0";
    const ahead = head.revision !== baseRevision;
    if (!ahead || baseRevision === "0" || !base) {
      return {
        baseRevision,
        remoteRevision: head.revision,
        ahead,
        items: [],
        listed: false,
      };
    }
    try {
      const delta = await this.legacyTreeRemote.delta(baseRevision);
      return {
        baseRevision,
        remoteRevision: delta.toRevision,
        ahead: true,
        items: delta.items,
        listed: true,
      };
    } catch {
      return {
        baseRevision,
        remoteRevision: head.revision,
        ahead: true,
        items: [],
        listed: false,
      };
    }
  }

  async remoteDeltaV3(): Promise<RemoteDeltaV3> {
    const remote = this.requireV3Remote();
    const base = await this.readBaseSnapshotV3();
    const head = await remote.head();
    const baseRevision = base?.revision ?? "0";
    const ahead = head.revision !== baseRevision;
    if (!ahead || baseRevision === "0" || !base)
      return {
        protocolVersion: "3",
        baseRevision,
        remoteRevision: head.revision,
        ahead,
        items: [],
        listed: false,
        resultingPages: [],
      };
    try {
      const delta = await remote.delta(baseRevision);
      const resultingPages = new Map(
        base.pages.map((page) => [
          page.pageId,
          {
            pageId: page.pageId,
            path: page.path,
            referencedAttachmentIds: [...page.referencedAttachmentIds],
          },
        ]),
      );
      for (const item of delta.items) {
        if (item.operation === "upsert_page")
          resultingPages.set(item.page.pageId, {
            pageId: item.page.pageId,
            path: item.page.path,
            referencedAttachmentIds: [...item.page.referencedAttachmentIds],
          });
        else if (item.operation === "archive_page")
          resultingPages.delete(item.pageId);
      }
      return {
        protocolVersion: "3",
        baseRevision,
        remoteRevision: delta.toRevision,
        ahead: true,
        items: delta.items,
        listed: true,
        resultingPages: [...resultingPages.values()].sort(
          (left, right) =>
            left.path.localeCompare(right.path) ||
            left.pageId.localeCompare(right.pageId),
        ),
      };
    } catch {
      return {
        protocolVersion: "3",
        baseRevision,
        remoteRevision: head.revision,
        ahead: true,
        items: [],
        listed: false,
        resultingPages: [],
      };
    }
  }

  async hasUnfinishedPush(): Promise<boolean> {
    const version = await this.readJournalSchemaVersion(
      this.root + "/push/journal.json",
    );
    if (version === 4) {
      if (!this.normalizedPush)
        throw new Error("NORMALIZED_PUSH_AUTHORITY_REQUIRED");
      const journal = await this.normalizedPush.coordinator.inspect();
      return (
        !!journal &&
        journal.phase !== "complete" &&
        journal.phase !== "superseded"
      );
    }
    if (this.remoteV3) {
      if (version === null) return false;
      const push = await this.v3PushService().inspect();
      return (
        !!push &&
        push.remoteState !== "superseded" &&
        push.localCommitPhase !== "verified"
      );
    }
    if (version === 1) {
      if (!this.legacyRemote) return true;
      const push = await new PushService(
        this.legacyRemote,
        this.control,
        this.root + "/push",
      ).inspect();
      return (
        !!push &&
        push.remoteState !== "superseded" &&
        push.localCommitPhase !== "verified"
      );
    }
    if (version === null) return false;
    const push = await new TreePushService(
      this.legacyTreeRemote,
      this.control,
      this.root + "/push",
    ).inspect();
    return (
      !!push &&
      push.remoteState !== "superseded" &&
      push.localCommitPhase !== "verified"
    );
  }

  async previewBootstrapPullV3(options?: SyncOperationOptions) {
    await progressCheckpoint(options, {
      phase: "download",
      completed: 0,
      total: 1,
      cancellable: true,
    });
    const preview = await this.requireV3Remote().bootstrapPreview();
    await progressCheckpoint(options, {
      phase: "download",
      completed: 1,
      total: 1,
      cancellable: true,
    });
    return preview;
  }

  async confirmBootstrapPullV3(
    preview: Awaited<ReturnType<TreeRemotePortV3["bootstrapPreview"]>>,
    options?: SyncOperationOptions,
  ): Promise<PullPreviewV3> {
    if (preview.blockers.length > 0) throw new Error("V3_BOOTSTRAP_BLOCKED");
    cancellationCheckpoint(options, true);
    reportProgress(options, {
      phase: "finalize",
      completed: 0,
      total: 1,
      cancellable: false,
      nonCancellableReason:
        "首次启用确认正在服务端原子提交，完成后将继续生成 Pull 预览。",
    });
    await this.requireV3Remote().bootstrapConfirmed({
      baseRevision: preview.baseRevision,
      confirmationHash: preview.candidateHash,
      userConfirmed: true,
    });
    const handoffOptions: SyncOperationOptions | undefined = options
      ? {
          onProgress: (progress) =>
            options.onProgress?.({
              ...progress,
              cancellable: false,
              nonCancellableReason:
                "首次启用已提交，正在生成必须再次确认的 Pull 预览。",
            }),
        }
      : undefined;
    return this.previewPullV3(handoffOptions);
  }

  private async assertNoActiveV3PullTransaction(): Promise<void> {
    const active = await new TreeTransaction(
      this.vault,
      this.control,
      this.root + "/pull",
    ).inspect();
    if (
      active &&
      active.state !== "committed" &&
      active.state !== "rolled_back"
    )
      throw new Error("PULL_RECOVERY_REQUIRED");
  }

  private blobRequirements(attachments: TreeAttachment[]): BlobRequirementV3[] {
    const byHash = new Map<string, BlobRequirementV3>();
    for (const attachment of attachments)
      if (!byHash.has(attachment.contentHash))
        byHash.set(attachment.contentHash, {
          contentHash: attachment.contentHash,
          sizeBytes: attachment.sizeBytes,
          mimeType: attachment.mimeType,
          width: attachment.width,
          height: attachment.height,
        });
    return [...byHash.values()].sort((left, right) =>
      left.contentHash.localeCompare(right.contentHash),
    );
  }

  private stagingMatchesPull(
    journal: BlobStagingJournal,
    revision: string,
    attachments: TreeAttachment[],
  ): boolean {
    if (journal.schemaVersion !== 2 || journal.revision !== revision)
      return false;
    const requirements = this.blobRequirements(attachments);
    if (Object.keys(journal.blobs).length !== requirements.length) return false;
    return requirements.every(
      (expected) =>
        JSON.stringify(journal.blobs[expected.contentHash]?.expected) ===
        JSON.stringify(expected),
    );
  }

  private async isMissingAttachmentTargetCreatable(
    relativePath: string,
  ): Promise<boolean> {
    const segments = relativePath.split("/");
    for (let length = segments.length; length > 0; length -= 1) {
      const path = joinRoot(
        this.mapping.rootPath,
        segments.slice(0, length).join("/"),
      );
      const status = await this.vault.pathStatus(path);
      if (length === segments.length) {
        if (status !== "missing") return false;
      } else if (status === "file") return false;
    }
    return true;
  }

  private async repairSameRevisionMissingRemoteAttachments(
    local: LocalTreeScanV3,
    base: TreeSnapshotV3,
    remote: TreeSnapshotV3,
  ): Promise<{ local: LocalTreeScanV3; attachmentIds: string[] }> {
    if (
      base.revision === "0" ||
      base.revision !== remote.revision ||
      base.revisionContentHash !== remote.revisionContentHash
    )
      throw new Error("SAME_REVISION_REPAIR_REQUIRES_MATCHING_BASE");
    const candidate = structuredClone(local);
    const baseAttachments = new Map(
      base.attachments.map((attachment) => [
        attachment.attachmentId,
        attachment,
      ]),
    );
    const remoteAttachments = new Map(
      remote.attachments.map((attachment) => [
        attachment.attachmentId,
        attachment,
      ]),
    );
    const basePages = new Map(base.pages.map((page) => [page.pageId, page]));
    const remotePages = new Map(
      remote.pages.map((page) => [page.pageId, page]),
    );
    const repairedBlockers = new Set<number>();
    const repairedIds = new Set<string>();

    for (const [index, blocker] of candidate.blockers.entries()) {
      if (
        blocker.code !== "ATTACHMENT_MISSING" ||
        !blocker.pagePath ||
        (!blocker.path && !blocker.target)
      )
        continue;
      const missingPath = blocker.path ?? `assets/${blocker.target!}`;
      if (!(await this.isMissingAttachmentTargetCreatable(missingPath)))
        continue;
      const localPage = candidate.pages.find(
        (page) => pathKey(page.path) === pathKey(blocker.pagePath!),
      );
      if (!localPage) continue;
      const basePage = basePages.get(localPage.pageId);
      const remotePage = remotePages.get(localPage.pageId);
      if (!basePage || !remotePage) continue;
      const matches = remotePage.referencedAttachmentIds.filter(
        (attachmentId) => {
          if (!basePage.referencedAttachmentIds.includes(attachmentId))
            return false;
          const baseAttachment = baseAttachments.get(attachmentId);
          const remoteAttachment = remoteAttachments.get(attachmentId);
          return (
            !!baseAttachment &&
            !!remoteAttachment &&
            pathKey(baseAttachment.path) === pathKey(missingPath) &&
            baseAttachment.path === remoteAttachment.path &&
            baseAttachment.mimeType === remoteAttachment.mimeType &&
            baseAttachment.sizeBytes === remoteAttachment.sizeBytes &&
            baseAttachment.width === remoteAttachment.width &&
            baseAttachment.height === remoteAttachment.height &&
            baseAttachment.contentHash === remoteAttachment.contentHash &&
            baseAttachment.updatedAt === remoteAttachment.updatedAt
          );
        },
      );
      if (matches.length !== 1) continue;
      localPage.referencedAttachmentIds = [
        ...new Set([...localPage.referencedAttachmentIds, matches[0]!]),
      ].sort();
      repairedBlockers.add(index);
      repairedIds.add(matches[0]!);
    }

    candidate.blockers = candidate.blockers.filter(
      (_blocker, index) => !repairedBlockers.has(index),
    );
    return { local: candidate, attachmentIds: [...repairedIds].sort() };
  }

  async previewPullV3(
    options?: SyncOperationOptions,
    behavior?: PullPreviewV3Behavior,
  ): Promise<PullPreviewV3> {
    if (await this.hasUnfinishedPush())
      throw new Error("PUSH_RECOVERY_REQUIRED");
    await this.assertNoActiveV3PullTransaction();
    const remotePort = this.requireV3Remote();
    const space = (await remotePort.spaces()).find(
      (item) => item.spaceId === this.mapping.spaceId,
    );
    if (space?.syncMode === "bootstrap_required")
      throw new Error("V3_BOOTSTRAP_CONFIRMATION_REQUIRED");
    const head = await remotePort.head();
    const remote = await this.downloadRemoteSnapshotV3(head.revision, options);
    const capabilities = await remotePort.capabilities();
    const base = (await this.readBaseSnapshotV3()) ?? this.emptySnapshotV3();
    const scannedLocal = await this.scanV3(base, capabilities, options, true);
    const repair = behavior?.repairSameRevisionMissingRemoteAttachments
      ? await this.repairSameRevisionMissingRemoteAttachments(
          scannedLocal,
          base,
          remote,
        )
      : { local: scannedLocal, attachmentIds: [] };
    const local = repair.local;
    const scanEpoch = this.scanEpoch;
    const missing = remote.attachments.filter((attachment) => {
      if (
        behavior?.repairSameRevisionMissingRemoteAttachments &&
        !repair.attachmentIds.includes(attachment.attachmentId)
      )
        return false;
      const localAttachment = local.attachments.find(
        (item) => item.attachmentId === attachment.attachmentId,
      );
      return localAttachment?.contentHash !== attachment.contentHash;
    });
    const staging = new BlobStagingRepository(
      this.control,
      this.root + "/pull-staging",
      capabilities,
    );
    const existingStaging = await staging.readJournal();
    let transferId: string | null = null;
    if (missing.length > 0) {
      const reusable =
        existingStaging &&
        this.stagingMatchesPull(existingStaging, remote.revision, missing)
          ? existingStaging
          : null;
      if (existingStaging && !reusable) await staging.cleanup();
      transferId = reusable?.transferId ?? crypto.randomUUID();
      const expiresAt =
        reusable?.expiresAt ??
        new Date(
          Date.now() + capabilities.blobStagingTtlSeconds * 1000,
        ).toISOString();
      await new BlobTransfer(remotePort, staging, capabilities).downloadMissing(
        {
          transferId,
          expiresAt,
          revision: remote.revision,
          attachments: missing,
          signal: options?.signal,
        },
      );
    } else if (existingStaging) await staging.cleanup();
    await progressCheckpoint(options, {
      phase: "merge",
      completed: 0,
      cancellable: true,
    });
    const tree = await buildTreePullPreviewV3(base, local, remote);
    return {
      ...tree,
      artifactRoots: transferId ? [this.root + "/pull-staging"] : [],
      scanEpoch,
      capabilities,
      transferId,
      expectedVaultPathStates: this.expectedV3VaultPathStates(
        local,
        tree.actions,
      ),
      sameRevisionMissingAttachmentIds: repair.attachmentIds,
    };
  }

  private async attachmentSourceBytes(
    preview: PullPreviewV3,
    action: Extract<
      AttachmentPullAction,
      { kind: "create_attachment" | "write_attachment" }
    >,
  ): Promise<Uint8Array | null> {
    const staging = new BlobStagingRepository(
      this.control,
      this.root + "/pull-staging",
      preview.capabilities,
    );
    if (preview.transferId) {
      const staged = await staging.readComplete(action.attachment.contentHash);
      if (staged) return staged;
    }
    const aliases = preview.attachmentPlan.identityAliases;
    const remappedSourceAttachmentId =
      preview.attachmentPlan.sourceAttachmentIdByAttachmentId[
        action.attachment.attachmentId
      ];
    const sourceAttachmentId =
      remappedSourceAttachmentId ?? action.attachment.attachmentId;
    const selected =
      action.source === "local"
        ? preview.local.attachments
        : action.source === "base"
          ? preview.base.attachments
          : preview.remote.attachments;
    if (
      remappedSourceAttachmentId &&
      !selected.some(
        (item) =>
          item.attachmentId === sourceAttachmentId &&
          item.contentHash === action.attachment.contentHash,
      )
    )
      return null;
    const candidatePool = [
      ...selected,
      ...preview.local.attachments,
      ...preview.base.attachments,
      ...preview.remote.attachments,
    ];
    const candidates = candidatePool.filter(
      (item, index, all) =>
        (remappedSourceAttachmentId
          ? item.attachmentId === sourceAttachmentId
          : (aliases[item.attachmentId] ?? item.attachmentId) ===
            sourceAttachmentId) &&
        item.contentHash === action.attachment.contentHash &&
        all.findIndex(
          (candidate) =>
            candidate.path === item.path &&
            candidate.contentHash === item.contentHash,
        ) === index,
    );
    for (const candidate of candidates) {
      const bytes = await this.vault.read(
        joinRoot(this.mapping.rootPath, candidate.path),
      );
      if (bytes && (await sha256Hex(bytes)) === action.attachment.contentHash)
        return bytes;
    }
    return null;
  }

  private async desiredV3Identities(
    preview: PullPreviewV3,
  ): Promise<TreeIdentityStateV2> {
    return desiredV3Identities(await this.readIdentities(), preview);
  }

  private async verifyResolvedV3Vault(
    preview: PullPreviewV3,
    identities: TreeIdentityStateV2,
  ): Promise<void> {
    await verifyResolvedV3Vault({
      vault: this.vault,
      rootPath: this.mapping.rootPath,
      spaceId: this.mapping.spaceId,
      preview,
      identities,
      capabilities: preview.capabilities,
    });
  }

  private async applyV3ControlAfter(transactionId: string): Promise<void> {
    await applyV3ControlAfter(
      this.v3PullControlAfter,
      this.identities,
      transactionId,
    );
  }

  async applyPullV3(
    preview: PullPreviewV3,
    options?: SyncOperationOptions,
  ): Promise<void> {
    if (await this.hasUnfinishedPush())
      throw new Error("PUSH_RECOVERY_REQUIRED");
    if (pendingTreeDecisionCount(preview) > 0)
      throw new Error("拉取存在未解决的结构化冲突");
    const expectedPathStates = this.expectedV3VaultPathStates(
      preview.local,
      preview.actions,
    );
    await this.assertV3PreviewVaultState(preview, expectedPathStates);
    await progressCheckpoint(options, {
      phase: "apply",
      completed: 0,
      cancellable: true,
    });
    await this.assertV3PreviewVaultState(preview, expectedPathStates);
    for (const page of preview.resolvedPages)
      await this.control.write(
        this.root + "/tree-preview-body/" + page.pageId + ".md",
        page.body,
      );
    const identities = await this.desiredV3Identities(preview);
    const tx = new TreeTransaction(
      this.vault,
      this.control,
      this.root + "/pull",
      (action) => this.attachmentSourceBytes(preview, action),
    );
    const transactionId = crypto.randomUUID();
    await tx.prepare(
      {
        baseRevision: preview.base.revision,
        targetRevision: preview.revision,
        targetTreeHash: await treeRevisionContentHashV3({
          protocolVersion: "3",
          spaceId: this.mapping.spaceId,
          folders: preview.resolvedFolders,
          pages: preview.resolvedPages,
          attachments: preview.resolvedAttachments,
        }),
        actions: preview.actions.map((action) => this.prefixActionV3(action)),
        deferCommit: true,
        expectedPathStates,
      },
      transactionId,
    );
    await this.v3PullControlAfter.write({
      schemaVersion: 2,
      transactionId,
      phase: "pending",
      identities,
    });
    try {
      await this.withoutRenameHints(() => tx.apply());
      await this.verifyResolvedV3Vault(preview, identities);
      await tx.markVerified();
    } catch (error) {
      await this.withoutRenameHints(() => tx.recover());
      await this.treeBaseline.recover(null);
      throw error;
    }
    try {
      await this.treeBaseline.prepare(preview.remote, "pull", transactionId);
      await this.treeBaseline.setPhase("applying");
      await tx.assertApplied();
      await this.treeBaseline.recover(transactionId);
    } catch (error) {
      // If no baseline journal exists, the pointer cannot have switched and a
      // verified Vault result is still safely reversible. Once the journal
      // exists, recovery decides whether to finish the durable pointer switch.
      const baselineJournalExists =
        await this.treeBaseline.hasTransaction(transactionId);
      if (!baselineJournalExists) {
        await this.withoutRenameHints(() => tx.rollbackVerified());
        await new BlobStagingRepository(
          this.control,
          this.root + "/pull-staging",
          preview.capabilities,
        ).cleanup();
      }
      throw error;
    }
    await this.applyV3ControlAfter(transactionId);
    await tx.markCommitted();
    await new BlobStagingRepository(
      this.control,
      this.root + "/pull-staging",
      preview.capabilities,
    ).cleanup();
    await this.discardPullPreviewV3(preview);
    this.mapping.status = "active";
  }

  async discardPullPreviewV3(preview: PullPreviewV3): Promise<void> {
    for (const page of preview.resolvedPages)
      await this.control.remove(
        this.root + "/tree-preview-body/" + page.pageId + ".md",
      );
    if (preview.transferId)
      await new BlobStagingRepository(
        this.control,
        this.root + "/pull-staging",
        preview.capabilities,
      ).cleanup();
  }

  async discardPushPreviewV3(preview: PushPreviewV3): Promise<void> {
    if (preview.normalizedPush) {
      if (!this.normalizedPush)
        throw new Error("NORMALIZED_PUSH_AUTHORITY_REQUIRED");
      await this.readJournalSchemaVersion(this.root + "/push/journal.json");
      const journal = await this.normalizedPush.coordinator.inspect();
      if (
        journal &&
        journal.binding.operationId ===
          preview.normalizedPush.plan.binding.operationId &&
        journal.phase !== "complete" &&
        journal.phase !== "superseded"
      )
        throw new Error("PUSH_RECOVERY_REQUIRED");
      await this.control.removeTree?.(
        normalizedPushPaths(
          this.root,
          preview.normalizedPush.plan.binding.operationId,
        ).payloadRoot,
      );
    }
    if ("previewId" in preview && preview.previewId)
      await this.control.removeTree?.(
        this.root + "/push-preview/" + safeKey(preview.previewId),
      );
  }

  private pushManifestChangeV3(
    change: PreparedTreePushChangeV3,
  ): Parameters<typeof treeConfirmationHashV3>[0]["changes"][number] {
    switch (change.operation) {
      case "upsert_folder":
        return { operation: change.operation, folder: change.folder };
      case "archive_folder":
        return { ...change };
      case "upsert_attachment":
        return { operation: change.operation, attachment: change.attachment };
      case "upsert_page": {
        const {
          payloadPath: _payloadPath,
          bodyBytes: _bodyBytes,
          ...page
        } = change.page;
        return { operation: change.operation, page };
      }
      case "archive_page":
        return { ...change };
      case "detach_attachment":
        return { ...change };
    }
  }

  private pushSemanticChangeV3(change: PreparedTreePushChangeV3): unknown {
    switch (change.operation) {
      case "upsert_folder": {
        const { updatedAt: _updatedAt, ...folder } = change.folder;
        return { operation: change.operation, folder };
      }
      case "upsert_attachment": {
        const { updatedAt: _updatedAt, ...attachment } = change.attachment;
        return { operation: change.operation, attachment };
      }
      case "upsert_page": {
        const {
          payloadPath: _payloadPath,
          bodyBytes: _bodyBytes,
          updatedAt: _updatedAt,
          ...page
        } = change.page;
        return { operation: change.operation, page };
      }
      case "archive_folder":
      case "archive_page":
      case "detach_attachment":
        return { ...change };
    }
  }

  private async pushSemanticHashV3(
    changes: PreparedTreePushChangeV3[],
  ): Promise<string> {
    return sha256Hex(
      canonicalBytes(
        changes.map((change) => this.pushSemanticChangeV3(change)),
      ),
    );
  }

  private async preparePushChangesV3(
    base: TreeSnapshotV3,
    local: LocalTreeScanV3,
    options?: SyncOperationOptions,
    stagePages = true,
  ): Promise<PreparedTreePushChangeV3[]> {
    if (local.blockers.length > 0) throw new Error("V3_PUSH_BLOCKED");
    const previewId = crypto.randomUUID();
    const prepared = await prepareTreePushChangesV3({
      base,
      candidate: {
        protocolVersion: "3",
        spaceId: this.mapping.spaceId,
        folders: local.folders,
        pages: local.pages,
        attachments: local.attachments,
      },
      vaultRoot: this.mapping.rootPath,
      control: this.control,
      payloadRoot: `${this.root}/push-preview/${previewId}`,
      options,
      stagePages,
    });
    return prepared.changes;
  }

  async previewPushV3(options?: SyncOperationOptions): Promise<PushPreviewV3> {
    if (await this.hasUnfinishedPush())
      throw new Error("PUSH_RECOVERY_REQUIRED");
    const remote = this.requireV3Remote();
    const base = await this.readBaseSnapshotV3();
    if (!base) throw new Error("INITIAL_PULL_REQUIRED");
    const head = await remote.head();
    if (head.revision !== base.revision) throw new Error("BASE_STALE");
    const capabilities = await remote.capabilities();
    const capabilitiesHash = await treeCapabilitiesHashV3(capabilities);
    if (capabilitiesHash !== (await remote.capabilitiesHash))
      throw new Error("CAPABILITIES_CHANGED");
    const local = await this.scanV3(base, capabilities, options, true);
    if (local.blockers.length > 0)
      return {
        protocolVersion: "3",
        publishable: false,
        normalizedPush: null,
        spaceId: this.mapping.spaceId,
        baseRevision: base.revision,
        changes: [],
        blockers: structuredClone(local.blockers),
        capabilities,
        capabilitiesHash,
        credentialId: this.credentialId,
      };
    const changes = await this.preparePushChangesV3(base, local, options);
    const confirmationHash = await treeConfirmationHashV3({
      protocolVersion: "3",
      spaceId: this.mapping.spaceId,
      baseRevision: base.revision,
      capabilitiesHash,
      changes: changes.map((change) => this.pushManifestChangeV3(change)),
    });
    const preview: PublishablePushPreviewV3 = {
      protocolVersion: "3",
      publishable: true,
      normalizedPush: null,
      blockers: [],
      spaceId: this.mapping.spaceId,
      baseRevision: base.revision,
      changes,
      capabilities,
      capabilitiesHash,
      confirmationHash,
      credentialId: this.credentialId,
      previewId:
        changes.find((change) => change.operation === "upsert_page")
          ?.operation === "upsert_page"
          ? changes
              .find((change) => change.operation === "upsert_page")!
              .page.payloadPath.split("/")
              .at(-2)
          : crypto.randomUUID(),
    };
    preview.normalizedPush =
      (await this.normalizedPush?.prepare(base, local, preview)) ?? null;
    this.pushPreviewBindings.set(preview, {
      epoch: this.scanEpoch,
      authority: this.normalizedAuthority,
    });
    return preview;
  }

  private async finishV3Push(
    service: TreePushServiceV3,
    result: Awaited<ReturnType<TreePushServiceV3["resumePending"]>> & {},
    options?: SyncOperationOptions,
  ): Promise<void> {
    if (!result) throw new Error("PUSH_TERMINAL_RESULT_MISSING");
    const terminalOptions: SyncOperationOptions | undefined = options
      ? {
          onProgress: (progress) =>
            options.onProgress?.({ ...progress, cancellable: false }),
        }
      : undefined;
    const snapshot = await this.downloadRemoteSnapshotV3(
      result.revision,
      terminalOptions,
    );
    if (
      snapshot.revisionContentHash !== result.revisionContentHash ||
      String(snapshot.folders.length) !== result.folderCount ||
      String(snapshot.pages.length) !== result.pageCount ||
      String(snapshot.attachments.length) !== result.attachmentCount
    )
      throw new Error("PUSH_TERMINAL_SNAPSHOT_MISMATCH");
    await this.treeBaseline.prepare(snapshot, "push");
    await this.treeBaseline.commit();
    const capabilities = await this.requireV3Remote().capabilities();
    const local = await this.scanV3(snapshot, capabilities);
    const identities = upgradeTreeIdentityState(await this.readIdentities());
    identities.folders = Object.fromEntries(
      snapshot.folders.map((folder) => [
        folder.folderId,
        {
          folderId: folder.folderId,
          path: folder.path,
          pathKey: pathKey(folder.path),
        },
      ]),
    );
    identities.pendingFolders = {};
    identities.pendingPages = Object.fromEntries(
      local.pages
        .filter((page) => {
          const remotePage = snapshot.pages.find(
            (item) => item.pageId === page.pageId,
          );
          return (
            !remotePage ||
            remotePage.path !== page.path ||
            remotePage.contentHash !== page.contentHash
          );
        })
        .map((page) => [
          page.pageId,
          {
            pageId: page.pageId,
            path: page.path,
            contentHash: page.contentHash,
          },
        ]),
    );
    identities.pendingAttachments = Object.fromEntries(
      local.attachments
        .filter((attachment) => {
          const remoteAttachment = snapshot.attachments.find(
            (item) => item.attachmentId === attachment.attachmentId,
          );
          return (
            !remoteAttachment ||
            remoteAttachment.path !== attachment.path ||
            remoteAttachment.contentHash !== attachment.contentHash
          );
        })
        .map((attachment) => [
          attachment.attachmentId,
          {
            attachmentId: attachment.attachmentId,
            path: attachment.path,
            pathKey: pathKey(attachment.path),
            contentHash: attachment.contentHash,
          },
        ]),
    );
    const projectedAttachmentIds = new Set(
      snapshot.attachments.map((attachment) => attachment.attachmentId),
    );
    identities.attachments = Object.fromEntries<TreeAttachmentIdentity>([
      ...snapshot.attachments.map(
        (attachment) =>
          [
            attachment.attachmentId,
            {
              attachmentId: attachment.attachmentId,
              path: attachment.path,
              pathKey: pathKey(attachment.path),
              baseContentHash: attachment.contentHash,
              active: true,
            },
          ] as const,
      ),
      ...Object.values(identities.attachments)
        .filter(
          (identity) =>
            !projectedAttachmentIds.has(identity.attachmentId) &&
            !identities.pendingAttachments[identity.attachmentId],
        )
        .map(
          (identity) =>
            [identity.attachmentId, { ...identity, active: false }] as const,
        ),
    ]);
    await this.identities.write(identities);
    await service.markVerified();
    this.mapping.status = "active";
  }

  async applyPushV3(
    preview: PushPreviewV3,
    options?: SyncOperationOptions,
  ): Promise<void> {
    if (!preview.publishable || preview.blockers.length > 0)
      throw new Error("V3_PUSH_BLOCKED");
    if (preview.normalizedPush) {
      if (!this.normalizedPush)
        throw new Error("NORMALIZED_PUSH_AUTHORITY_REQUIRED");
      const wire: TreePushPreviewV3 = {
        protocolVersion: preview.protocolVersion,
        spaceId: preview.spaceId,
        baseRevision: preview.baseRevision,
        changes: preview.changes,
        capabilities: preview.capabilities,
        capabilitiesHash: preview.capabilitiesHash,
        confirmationHash: preview.confirmationHash,
        credentialId: preview.credentialId,
        ...(preview.previewId ? { previewId: preview.previewId } : {}),
      };
      await this.normalizedPush.coordinator.confirm(
        preview.normalizedPush.plan,
        wire,
        preview.normalizedPush.candidate,
        options,
      );
      return;
    }
    if (!preview.changes.length) return;
    const service = this.v3PushService();
    let effectivePreview = preview;
    let result;
    try {
      result = await service.publishPrepared(effectivePreview, options);
    } catch (error) {
      if (syncErrorCodeV3(error) !== "CAPABILITIES_CHANGED") throw error;
      await service.supersede();
      const rebuilt = await this.previewPushV3(options);
      if (!rebuilt.publishable) throw new Error("PUSH_CONFIRMATION_REQUIRED");
      if (
        (await this.pushSemanticHashV3(rebuilt.changes)) !==
        (await this.pushSemanticHashV3(preview.changes))
      ) {
        if (rebuilt.previewId)
          await this.control.removeTree?.(
            this.root + "/push-preview/" + safeKey(rebuilt.previewId),
          );
        throw new Error("PUSH_CONFIRMATION_REQUIRED");
      }
      effectivePreview = rebuilt;
      result = await service.publishPrepared(effectivePreview, options);
    }
    reportProgress(options, {
      phase: "apply",
      completed: 0,
      cancellable: false,
    });
    await this.finishV3Push(service, result, options);
    if (preview.previewId)
      await this.control.removeTree?.(
        this.root + "/push-preview/" + safeKey(preview.previewId),
      );
    if (
      effectivePreview.previewId &&
      effectivePreview.previewId !== preview.previewId
    )
      await this.control.removeTree?.(
        this.root + "/push-preview/" + safeKey(effectivePreview.previewId),
      );
  }

  async previewPull(options?: SyncOperationOptions): Promise<PullPreview> {
    const base = await this.readBaseSnapshot();
    const head = await this.legacyTreeRemote.head();
    const remote = await this.downloadRemoteSnapshot(head.revision, options);
    if (
      remote.pages.some((page) => this.hasLegacyManagedImageCandidate(page)) ||
      (await this.hasLocalImageCandidate())
    )
      throw new Error("SYNC_PROTOCOL_UPGRADE_REQUIRED");
    const local = await this.scan(options, base ? undefined : remote.pages);
    const tree = await buildTreePullPreview(
      base ?? emptySnapshot(remote.protocolVersion, remote.spaceId),
      local,
      remote,
    );
    return {
      ...tree,
      artifactRoots: [],
      scanEpoch: this.scanEpoch,
      conflicts: tree.pageConflicts,
      conflictResolutions: tree.pageConflictResolutions,
      initialBindings: [],
      remotePages: remote.pages,
      expectedVaultHashes: {},
      conflictValuePaths: {},
      localCandidates: local.pages.map((page) => ({
        path: page.path,
        vaultByteHash: page.contentHash,
      })),
    };
  }

  private hasLegacyManagedImageCandidate(page: TreePage): boolean {
    return parseAttachmentReferences(page.body, page.path).some(
      (reference) =>
        reference.classification !== "external" &&
        reference.classification !== "page_embed",
    );
  }

  async hasLocalImageCandidate(): Promise<boolean> {
    const capabilities = await (
      this.remoteV3 ?? this.legacyTreeRemote
    ).capabilities();
    let count = 0;
    let total = 0;
    const assertSize = (size: number) => {
      if (!Number.isSafeInteger(size) || size < 0)
        throw new Error("INVALID_RAW_PAGE_SIZE");
      if (
        size > capabilities.maxPageBytes ||
        total + size > capabilities.maxClientTotalBodyBytes
      )
        throw new Error("SPACE_TOO_LARGE: image probe raw bytes");
    };
    for await (const entry of this.vault.listTree(this.mapping.rootPath, {
      metadataOnly: true,
    })) {
      if (entry.kind !== "markdown" || !entry.relativePath.startsWith("pages/"))
        continue;
      validatePortableMarkdownPath(entry.relativePath);
      if (++count > capabilities.maxClientSpacePages)
        throw new Error("SPACE_TOO_LARGE: image probe page count");
      if (entry.byteLength !== undefined) assertSize(entry.byteLength);
      const bytes =
        entry.bytes ??
        (await this.vault.read(
          joinRoot(this.mapping.rootPath, entry.relativePath),
        ));
      if (!bytes) throw new Error("RAW_PAGE_MISSING");
      assertSize(bytes.byteLength);
      if (
        entry.byteLength !== undefined &&
        entry.byteLength !== bytes.byteLength
      )
        throw new Error("RAW_PAGE_SIZE_CHANGED");
      total += bytes.byteLength;
      const body = decodeVaultMarkdown(bytes).normalized;
      if (
        parseAttachmentReferences(body, entry.relativePath).some(
          (reference) =>
            reference.classification !== "external" &&
            reference.classification !== "page_embed",
        )
      )
        return true;
    }
    return false;
  }

  async applyPull(
    preview: PullPreview,
    options?: SyncOperationOptions,
    guard?: ApplyPullGuard,
  ): Promise<void> {
    const expectedPathStates = guard
      ? Object.freeze(
          Object.fromEntries(
            Object.entries(guard.expectedPathStates).map(([path, state]) => [
              path,
              Object.freeze(structuredClone(state)),
            ]),
          ),
        )
      : undefined;
    if (guard) {
      await guard.revalidate();
      await this.assertVaultPathStates(expectedPathStates!);
    }
    await progressCheckpoint(options, {
      phase: "apply",
      completed: 0,
      cancellable: true,
    });
    if (expectedPathStates)
      await this.assertVaultPathStates(expectedPathStates);
    for (const conflict of [...preview.pageConflicts]) {
      const resolution = preview.pageConflictResolutions[conflict.conflictId];
      if (resolution)
        await resolvePageConflict(preview, conflict.conflictId, resolution);
    }
    for (const conflict of [...preview.folderConflicts]) {
      const resolution = preview.folderConflictResolutions[conflict.conflictId];
      if (resolution)
        resolveFolderConflict(preview, conflict.conflictId, resolution);
    }
    if (pendingTreeDecisionCount(preview) > 0)
      throw new Error("拉取存在未解决的结构化冲突");
    if (expectedPathStates)
      await this.assertVaultPathStates(expectedPathStates);
    const snapshot: TreeSnapshot = {
      protocolVersion: "2",
      spaceId: this.mapping.spaceId,
      revision: preview.revision,
      revisionContentHash: "",
      folders: preview.remote.folders,
      pages: preview.remote.pages,
    };
    const baselineTx = await this.treeBaseline.prepare(snapshot, "pull");
    for (const page of preview.resolvedPages)
      await this.control.write(
        this.root + "/tree-preview-body/" + page.pageId + ".md",
        page.body,
      );
    await this.treeBaseline.setPhase("applying");
    const tx = new TreeTransaction(
      this.vault,
      this.control,
      this.root + "/pull",
    );
    const actions = preview.actions.map((action) => this.prefixAction(action));
    await tx.prepare(
      {
        baseRevision: preview.base.revision,
        targetRevision: preview.revision,
        targetTreeHash: await treeRevisionContentHashV2({
          protocolVersion: "2",
          spaceId: this.mapping.spaceId,
          folders: preview.resolvedFolders,
          pages: preview.resolvedPages,
        }),
        actions,
        ...(expectedPathStates ? { expectedPathStates } : {}),
      },
      baselineTx.transactionId,
    );
    await this.withoutRenameHints(() => tx.apply());
    await this.treeBaseline.commit();
    await this.commitIdentities(
      preview.resolvedFolders,
      preview.resolvedPages,
      preview.remote.pages,
    );
    await this.moveHints.clear();
    await this.discardPullPreview(preview);
    this.mapping.status = "active";
  }

  async previewPush(options?: SyncOperationOptions): Promise<PushPreview> {
    if (this.remoteV3) throw new Error("V3_PUSH_NOT_IMPLEMENTED");
    const base = await this.readBaseSnapshot();
    const head = await this.legacyTreeRemote.head();
    if (this.mapping.status === "pending") {
      const remoteHasContent =
        head.pageCount !== "0" || head.folderCount !== "0";
      if (remoteHasContent) throw new Error("INITIAL_PULL_REQUIRED");
    }
    const baseRevision =
      this.mapping.status === "pending" &&
      (!base || (base.revision === "0" && base.pages.length === 0))
        ? head.revision
        : (base?.revision ?? "0");
    if (head.revision !== baseRevision) throw new Error("BASE_STALE");
    const local = await this.scan(options);
    const changes = await this.computePushChanges(
      base ??
        emptySnapshot(
          this.legacyTreeRemote.protocolVersion,
          this.mapping.spaceId,
        ),
      local,
      options,
    );
    const capabilities = await this.legacyTreeRemote.capabilities();
    return {
      spaceId: this.mapping.spaceId,
      baseRevision,
      changes,
      capabilities,
      credentialId: this.credentialId,
      previewId: crypto.randomUUID(),
    };
  }

  private async computePushChanges(
    base: TreeSnapshot,
    local: LocalTreeScan,
    options?: SyncOperationOptions,
  ): Promise<PreparedTreePushChange[]> {
    const isV1 = this.legacyTreeRemote.protocolVersion === "1";
    const baseFolders = new Map(base.folders.map((f) => [f.folderId, f]));
    const localFolders = new Map(local.folders.map((f) => [f.folderId, f]));
    const basePages = new Map(base.pages.map((p) => [p.pageId, p]));
    const localPages = new Map(local.pages.map((p) => [p.pageId, p]));
    const changes: PreparedTreePushChange[] = [];
    const previewId = crypto.randomUUID();
    let prepared = 0;
    const total =
      local.folders.length +
      base.folders.length +
      local.pages.length +
      base.pages.length;
    for (const folder of local.folders) {
      const before = baseFolders.get(folder.folderId);
      if (
        !isV1 &&
        (!before ||
          before.path !== folder.path ||
          before.parentFolderId !== folder.parentFolderId ||
          before.name !== folder.name)
      )
        changes.push({ operation: "upsert_folder", folder });
      prepared += 1;
      if (prepared % 50 === 0)
        await progressCheckpoint(options, {
          phase: "merge",
          completed: prepared,
          total,
          cancellable: true,
        });
    }
    for (const folder of base.folders) {
      if (!isV1 && !localFolders.has(folder.folderId))
        changes.push({
          operation: "archive_folder",
          folderId: folder.folderId,
          previousPath: folder.path,
        });
      prepared += 1;
      if (prepared % 50 === 0)
        await progressCheckpoint(options, {
          phase: "merge",
          completed: prepared,
          total,
          cancellable: true,
        });
    }
    for (const page of local.pages) {
      const before = basePages.get(page.pageId);
      if (
        !before ||
        before.contentHash !== page.contentHash ||
        before.title !== page.title ||
        before.path !== page.path ||
        before.folderId !== page.folderId
      ) {
        const payloadPath =
          this.root +
          "/push-preview/" +
          previewId +
          "/" +
          safeKey(page.pageId) +
          ".md";
        await this.control.write(payloadPath, page.body);
        const { body: _body, ...metadata } = page;
        changes.push({
          operation: "upsert_page",
          page: {
            ...metadata,
            payloadPath,
            bodyBytes: new TextEncoder().encode(page.body).byteLength,
          },
        });
      }
      prepared += 1;
      if (prepared % 50 === 0)
        await progressCheckpoint(options, {
          phase: "merge",
          completed: prepared,
          total,
          cancellable: true,
        });
    }
    for (const page of base.pages) {
      if (!localPages.has(page.pageId))
        changes.push({
          operation: "archive_page",
          pageId: page.pageId,
          previousPath: page.path,
        });
      prepared += 1;
      if (prepared % 50 === 0)
        await progressCheckpoint(options, {
          phase: "merge",
          completed: prepared,
          total,
          cancellable: true,
        });
    }
    return changes;
  }

  async applyPush(
    preview: PushPreview,
    options?: SyncOperationOptions,
  ): Promise<void> {
    if (!preview.changes.length) return;
    const service = new TreePushService(
      this.legacyTreeRemote,
      this.control,
      this.root + "/push",
    );
    const result = await service.publishPrepared(preview, options);
    reportProgress(options, {
      phase: "apply",
      completed: 0,
      cancellable: false,
    });
    await this.commitBaseline(
      await this.downloadRemoteSnapshot(result.revision),
      "push",
    );
    await this.clearIdentities();
    await service.markVerified();
    await this.discardPushPreview(preview);
    this.mapping.status = "active";
  }

  private async commitBaseline(
    snapshot: TreeSnapshot,
    kind: "pull" | "push" | "initialize",
  ): Promise<void> {
    const v2: TreeSnapshot = {
      ...snapshot,
      protocolVersion: "2",
      spaceId: this.mapping.spaceId,
    };
    await this.treeBaseline.prepare(v2, kind);
    await this.treeBaseline.commit();
  }

  private async commitIdentities(
    folders: TreeFolder[],
    resolvedPages: TreePage[],
    remotePages: TreePage[],
  ): Promise<void> {
    const remoteIds = new Set(remotePages.map((page) => page.pageId));
    const pendingPages = Object.fromEntries(
      resolvedPages
        .filter((page) => !remoteIds.has(page.pageId))
        .map((page) => [
          page.pageId,
          {
            pageId: page.pageId,
            path: page.path,
            contentHash: page.contentHash,
          },
        ]),
    );
    await this.identities.write({
      schemaVersion: 1,
      folders: Object.fromEntries(
        folders.map((folder) => [
          folder.folderId,
          {
            folderId: folder.folderId,
            path: folder.path,
            pathKey: pathKey(folder.path),
          },
        ]),
      ),
      pendingFolders: {},
      pendingPages,
    });
  }

  private async clearIdentities(): Promise<void> {
    await this.identities.write(emptyTreeIdentityState());
  }

  async discardPullPreview(preview: PullPreview): Promise<void> {
    for (const page of preview.resolvedPages)
      await this.control.remove(
        this.root + "/tree-preview-body/" + page.pageId + ".md",
      );
  }

  async discardPushPreview(preview: PushPreview): Promise<void> {
    await this.control.removeTree?.(
      this.root + "/push-preview/" + safeKey(preview.previewId),
    );
  }

  async conflictSummary(
    _preview: PullPreview,
    conflict: StructuredConflict,
  ): Promise<{ base: string; local: string; remote: string }> {
    return {
      base: conflict.base,
      local: conflict.local,
      remote: conflict.remote,
    };
  }
}

function syncErrorCodeV3(error: unknown): string | null {
  if (
    error instanceof Error &&
    (error.message === "CAPABILITIES_CHANGED" || error.message === "BASE_STALE")
  )
    return error.message;
  if (!(error instanceof AgentWikiHttpError)) return null;
  const body = error.body;
  if (!body || typeof body !== "object") return null;
  const code = (body as { error?: { code?: unknown } }).error?.code;
  return typeof code === "string" ? code : null;
}

function computeTreeStatus(
  base: Pick<TreeSnapshot, "folders" | "pages">,
  local: Pick<LocalTreeScan, "folders" | "pages">,
): TreeLocalStatus {
  const baseFolders = new Map(base.folders.map((f) => [f.folderId, f]));
  const localFolders = new Map(local.folders.map((f) => [f.folderId, f]));
  const basePages = new Map(base.pages.map((p) => [p.pageId, p]));
  const localPages = new Map(local.pages.map((p) => [p.pageId, p]));
  const foldersAdded = local.folders.filter(
    (f) => !baseFolders.has(f.folderId),
  );
  const foldersMoved = local.folders.filter(
    (f) =>
      baseFolders.has(f.folderId) &&
      baseFolders.get(f.folderId)!.path !== f.path,
  );
  const foldersDeleted = base.folders.filter(
    (f) => !localFolders.has(f.folderId),
  );
  const added = local.pages.filter((p) => !basePages.has(p.pageId));
  const modified = local.pages.filter(
    (p) =>
      basePages.has(p.pageId) &&
      (basePages.get(p.pageId)!.contentHash !== p.contentHash ||
        basePages.get(p.pageId)!.title !== p.title),
  );
  const renamed = local.pages.filter(
    (p) => basePages.has(p.pageId) && basePages.get(p.pageId)!.path !== p.path,
  );
  const deleted = base.pages.filter((p) => !localPages.has(p.pageId));
  const ambiguous: TreePage[] = [];
  return {
    foldersAdded,
    foldersMoved,
    foldersDeleted,
    added,
    modified,
    renamed,
    deleted,
    ambiguous,
  };
}

function computeTreeStatusV3(
  base: TreeSnapshotV3,
  local: LocalTreeScanV3,
): TreeLocalStatusV3 {
  const pages = computeTreeStatus(base, local);
  const baseAttachments = new Map(
    base.attachments.map((attachment) => [attachment.attachmentId, attachment]),
  );
  const localAttachmentIds = new Set(
    local.attachments.map((attachment) => attachment.attachmentId),
  );
  return {
    ...pages,
    attachmentsAdded: local.attachments.filter(
      (attachment) => !baseAttachments.has(attachment.attachmentId),
    ),
    attachmentsModified: local.attachments.filter((attachment) => {
      const previous = baseAttachments.get(attachment.attachmentId);
      return !!previous && previous.contentHash !== attachment.contentHash;
    }),
    attachmentsRenamed: local.attachments.filter((attachment) => {
      const previous = baseAttachments.get(attachment.attachmentId);
      return !!previous && previous.path !== attachment.path;
    }),
    attachmentsDetached: base.attachments.filter(
      (attachment) => !localAttachmentIds.has(attachment.attachmentId),
    ),
    attachmentBlockers: local.blockers,
    attachmentPageCounts: Object.fromEntries(
      base.attachments
        .concat(local.attachments)
        .map((attachment) => attachment.attachmentId)
        .filter(
          (attachmentId, index, values) =>
            values.indexOf(attachmentId) === index,
        )
        .map((attachmentId) => [
          attachmentId,
          local.pages.filter((page) =>
            page.referencedAttachmentIds.includes(attachmentId),
          ).length,
        ]),
    ),
  };
}
