import {
  treeRevisionContentHashV2,
  pathKey,
} from "@neomei/agentwiki-sync-protocol";

import {
  canonicalBytes,
  contentHash,
  decimalWithinLimit,
  revisionContentHash,
  sha256Hex,
} from "../agentwiki/protocol";
import { decodeVaultMarkdown } from "../core/markdown";
import type {
  FolderConflict,
  FolderConflictResolution,
  PageMergePlan,
  StructuredConflict,
  TreePullAction,
} from "../core/merge";
import type { LocalTreeScan, TreeScanLimits } from "../core/tree-scan";
import { scanLocalTree } from "../core/tree-scan";
import type {
  TreeDeltaItem,
  TreeFolder,
  TreePage,
  TreeSnapshot,
} from "../core/tree-model";
import type { ControlStorePort } from "../ports/control-store";
import type { PushRemotePort } from "../ports/push-remote";
import type { TreeRemotePort, TreeSyncLimits } from "../ports/tree-remote";
import type { VaultPort } from "../ports/vault";
import { BaselineRepository } from "../storage/baseline";
import { MutableControlRepository } from "../storage/envelope";
import { TreeBaselineRepository } from "../storage/tree-baseline";
import {
  emptyTreeIdentityState,
  validateTreeIdentityState,
  type TreeIdentityState,
} from "../storage/tree-identities";
import {
  buildTreePullPreview,
  pendingTreeDecisionCount,
  resolveFolderConflict,
  resolvePageConflict,
  type PageConflictResolution,
  type TreePullPreview,
} from "./tree-diff";
import { TreeTransaction } from "./tree-transaction";
import { PullTransaction } from "./pull-transaction";
import { PushService } from "./push-service";
import {
  TreePushService,
  type PreparedTreePushChange,
} from "./tree-push-service";
import type { SpaceMapping } from "./sync-coordinator";
import {
  progressCheckpoint,
  reportProgress,
  type SyncOperationOptions,
} from "./progress";

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

export interface RemoteDelta {
  baseRevision: string;
  remoteRevision: string;
  ahead: boolean;
  listed: boolean;
  items: TreeDeltaItem[];
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

const isTreeIdentityState = (value: unknown): value is TreeIdentityState => {
  try {
    validateTreeIdentityState(value);
    return true;
  } catch {
    return false;
  }
};

const safeKey = (value: string) => value.replace(/[^A-Za-z0-9_-]/gu, "_");
const joinRoot = (root: string, relative: string) => root + "/" + relative;
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
  private scanEpoch = 0;
  private readonly root: string;
  private readonly treeBaseline: TreeBaselineRepository;
  private readonly legacyBaseline: BaselineRepository;
  private readonly identities: MutableControlRepository<TreeIdentityState>;
  private readonly moveHints: MutableControlRepository<MoveHintsState>;
  private readonly pullControlAfter: MutableControlRepository<PullControlAfterState>;
  private renameQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly vault: VaultPort,
    private readonly control: ControlStorePort,
    private readonly remote: TreeRemotePort,
    private readonly mapping: SpaceMapping,
    deviceKey = "local",
    spaceKey = safeKey(mapping.spaceId),
    private readonly credentialId: string | null = null,
    private readonly legacyRemote: PushRemotePort | null = null,
  ) {
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
    this.identities = new MutableControlRepository(
      control,
      this.root + "/tree-identities.json",
      isTreeIdentityState,
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
  }

  invalidate(): void {
    this.scanEpoch += 1;
  }

  get spaceId(): string {
    return this.mapping.spaceId;
  }

  get protocolVersion(): "1" | "2" {
    return this.remote.protocolVersion;
  }

  async recordRename(fromPath: string, toPath: string): Promise<void> {
    const operation = this.renameQueue.then(() =>
      this.recordRenameNow(fromPath, toPath),
    );
    this.renameQueue = operation.catch(() => undefined);
    return operation;
  }

  private async recordRenameNow(
    fromPath: string,
    toPath: string,
  ): Promise<void> {
    const prefix = this.mapping.rootPath + "/";
    if (!fromPath.startsWith(prefix) || !toPath.startsWith(prefix)) return;
    if (
      fromPath.includes(".agentwiki-tmp-") ||
      toPath.includes(".agentwiki-tmp-")
    )
      return;
    const base = await this.readBaseSnapshot();
    if (!base) return;
    const fromRel = fromPath.slice(prefix.length);
    const toRel = toPath.slice(prefix.length);
    const page = base.pages.find(
      (item) => pathKey(item.path) === pathKey(fromRel),
    );
    const bytes = await this.vault.read(toPath);
    if (!page || !bytes) return;
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
    if (manifest) return this.treeBaseline.readSnapshot();
    return this.treeBaseline.readLegacyEvidence(this.legacyBaseline);
  }

  private async scan(
    options?: SyncOperationOptions,
    preBindPages?: TreePage[],
  ): Promise<LocalTreeScan> {
    const epoch = this.scanEpoch;
    const status = await this.vault.rootStatus(this.mapping.rootPath);
    if (status === "missing") throw new Error("MAPPING_ROOT_MISSING");
    if (status === "file") throw new Error("MAPPING_ROOT_NOT_DIRECTORY");
    const capabilities = await this.remote.capabilities();
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
      maxPageBytes: capabilities.maxClientTotalBodyBytes,
    };
    const local = await scanLocalTree(
      this.vault,
      this.mapping.rootPath,
      base ?? emptySnapshot(this.remote.protocolVersion, this.mapping.spaceId),
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
    if (this.remote.protocolVersion === "1") {
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
    const folders: TreeFolder[] = [];
    const pages: TreePage[] = [];
    let totalBodyBytes = 0;
    let pinned: {
      protocolVersion: "1" | "2";
      spaceId: string;
      revision: string;
      revisionContentHash: string;
      folderCount: string;
      pageCount: string;
      revisionManifestByteLength: string;
      revisionBodyBytes: string;
    } | null = null;
    const capabilities = await this.remote.capabilities();
    for await (const segment of this.remote.snapshotPages(revision)) {
      const current = {
        protocolVersion: segment.protocolVersion,
        spaceId: segment.spaceId,
        revision: segment.revision,
        revisionContentHash: segment.revisionContentHash,
        folderCount: segment.folderCount,
        pageCount: segment.pageCount,
        revisionManifestByteLength: segment.revisionManifestByteLength,
        revisionBodyBytes: segment.revisionBodyBytes,
      };
      if (pinned && JSON.stringify(pinned) !== JSON.stringify(current))
        throw new Error("快照分页元数据已变更");
      pinned = current;
      folders.push(...segment.folders);
      for (const page of segment.pages) {
        if ((await contentHash(page.body)) !== page.contentHash)
          throw new Error("快照页面内容哈希不匹配");
        const bodyBytes = new TextEncoder().encode(page.body).byteLength;
        if (bodyBytes > capabilities.maxPageBytes)
          throw new Error("PAGE_TOO_LARGE");
        totalBodyBytes += bodyBytes;
      }
      pages.push(...segment.pages);
      await progressCheckpoint(options, {
        phase: "download",
        completed: pages.length + folders.length,
        total: undefined,
        cancellable: true,
      });
    }
    if (!pinned) throw new Error("快照未返回元数据");
    if (revision !== "current" && pinned.revision !== revision)
      throw new Error("快照修订不匹配");
    decimalWithinLimit(pinned.pageCount, capabilities.maxClientSpacePages);
    decimalWithinLimit(
      pinned.folderCount,
      capabilities.maxClientSpaceFolders ?? 10000,
    );
    if (
      String(folders.length) !== pinned.folderCount ||
      String(pages.length) !== pinned.pageCount
    )
      throw new Error("快照对象数量不匹配");
    decimalWithinLimit(
      pinned.revisionBodyBytes,
      capabilities.maxClientTotalBodyBytes,
    );
    if (totalBodyBytes !== Number(pinned.revisionBodyBytes))
      throw new Error("快照字节数不匹配");
    const manifestBytes = this.computeManifestBytes(
      pinned.protocolVersion,
      pinned.spaceId,
      folders,
      pages,
    );
    decimalWithinLimit(
      pinned.revisionManifestByteLength,
      capabilities.maxClientManifestBytes,
    );
    if (manifestBytes > capabilities.maxClientManifestBytes)
      throw new Error("SPACE_TOO_LARGE");
    const contentHashValue =
      pinned.protocolVersion === "2"
        ? await treeRevisionContentHashV2({
            protocolVersion: "2",
            spaceId: pinned.spaceId,
            folders,
            pages,
          })
        : await revisionContentHash({
            protocolVersion: "1",
            spaceId: pinned.spaceId,
            pages: pages.map((page) => ({
              pageId: page.pageId,
              path: page.path,
              title: page.title,
              contentHash: page.contentHash,
            })),
          });
    if (contentHashValue !== pinned.revisionContentHash)
      throw new Error("快照完整性不匹配");
    return {
      protocolVersion: pinned.protocolVersion,
      spaceId: pinned.spaceId,
      revision: pinned.revision,
      revisionContentHash: pinned.revisionContentHash,
      folders,
      pages,
    };
  }

  private computeManifestBytes(
    protocolVersion: "1" | "2",
    spaceId: string,
    folders: TreeFolder[],
    pages: TreePage[],
  ): number {
    if (protocolVersion === "1")
      return canonicalBytes({
        protocolVersion: "1",
        spaceId,
        pages: pages.map((page) => ({
          pageId: page.pageId,
          path: page.path,
          title: page.title,
          contentHash: page.contentHash,
        })),
      }).byteLength;
    return canonicalBytes({
      protocolVersion: "2",
      spaceId,
      folders,
      pages: pages.map((page) => ({
        pageId: page.pageId,
        folderId: page.folderId,
        path: page.path,
        title: page.title,
        contentHash: page.contentHash,
        updatedAt: page.updatedAt,
      })),
    }).byteLength;
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

  private async readJournalSchemaVersion(path: string): Promise<number | null> {
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
    const prefix = this.mapping.rootPath + "/";
    switch (action.kind) {
      case "create_directory":
      case "trash_directory":
      case "create_page":
      case "trash_page":
        return { ...action, path: prefix + action.path };
      case "write_page":
        return {
          ...action,
          path: prefix + action.path,
          ...(action.beforePath
            ? { beforePath: prefix + action.beforePath }
            : {}),
        };
      case "move_page":
        return {
          ...action,
          fromPath: prefix + action.fromPath,
          path: prefix + action.path,
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

  async establishEmptyBase(): Promise<void> {
    const head = await this.remote.head();
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
    await this.discardOrphanPreviews();
    const pullVersion = await this.readJournalSchemaVersion(
      this.root + "/pull/journal.json",
    );
    if (pullVersion === 1) await this.recoverLegacyPull();
    else if (pullVersion === 2) await this.recoverTreePull();
    else if (pullVersion !== null) throw new Error("不支持的拉取日志版本");

    const pushVersion = await this.readJournalSchemaVersion(
      this.root + "/push/journal.json",
    );
    if (pushVersion === 1) await this.recoverLegacyPush();
    else if (pushVersion === 2) await this.recoverTreePush();
    else if (pushVersion !== null) throw new Error("不支持的推送日志版本");
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
    let committedTransactionId: string | null =
      tree?.state === "committed" ? tree.transactionId : null;
    if (tree && !committedTransactionId) {
      await treeTx.recover();
      const recovered = await treeTx.inspect();
      committedTransactionId =
        recovered?.state === "committed" ? recovered.transactionId : null;
    }
    await this.treeBaseline.recover(committedTransactionId);
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
      this.remote,
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

  async status(options?: SyncOperationOptions): Promise<RuntimeStatus> {
    const base = await this.readBaseSnapshot();
    const local = await this.scan(options);
    const head = await this.remote.head();
    return {
      protocolVersion: this.remote.protocolVersion,
      baseRevision: base?.revision ?? "0",
      remoteRevision: head.revision,
      local: computeTreeStatus(
        base ??
          emptySnapshot(this.remote.protocolVersion, this.mapping.spaceId),
        local,
      ),
    };
  }

  async remoteDelta(): Promise<RemoteDelta> {
    const base = await this.readBaseSnapshot();
    const head = await this.remote.head();
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
      const delta = await this.remote.delta(baseRevision);
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

  async hasUnfinishedPush(): Promise<boolean> {
    const version = await this.readJournalSchemaVersion(
      this.root + "/push/journal.json",
    );
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
      this.remote,
      this.control,
      this.root + "/push",
    ).inspect();
    return (
      !!push &&
      push.remoteState !== "superseded" &&
      push.localCommitPhase !== "verified"
    );
  }

  async previewPull(options?: SyncOperationOptions): Promise<PullPreview> {
    const base = await this.readBaseSnapshot();
    const head = await this.remote.head();
    const remote = await this.downloadRemoteSnapshot(head.revision, options);
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

  async applyPull(
    preview: PullPreview,
    options?: SyncOperationOptions,
  ): Promise<void> {
    await progressCheckpoint(options, {
      phase: "apply",
      completed: 0,
      cancellable: true,
    });
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
        "tree-preview-body/" + page.pageId + ".md",
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
      },
      baselineTx.transactionId,
    );
    await tx.apply();
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
    const base = await this.readBaseSnapshot();
    const head = await this.remote.head();
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
      base ?? emptySnapshot(this.remote.protocolVersion, this.mapping.spaceId),
      local,
      options,
    );
    const capabilities = await this.remote.capabilities();
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
    const isV1 = this.remote.protocolVersion === "1";
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
      this.remote,
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
      await this.control.remove("tree-preview-body/" + page.pageId + ".md");
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

function computeTreeStatus(
  base: TreeSnapshot,
  local: LocalTreeScan,
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
