import {
  treeRevisionContentHashV2,
  pathKey,
} from "@neomei/agentwiki-sync-protocol";

import { contentHash, sha256Hex } from "../agentwiki/protocol";
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
  private renameQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly vault: VaultPort,
    private readonly control: ControlStorePort,
    private readonly remote: TreeRemotePort,
    private readonly mapping: SpaceMapping,
    deviceKey = "local",
    spaceKey = safeKey(mapping.spaceId),
    private readonly credentialId: string | null = null,
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

  private async scan(options?: SyncOperationOptions): Promise<LocalTreeScan> {
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
    );
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
    let head: {
      protocolVersion: "1" | "2";
      spaceId: string;
      revision: string;
      revisionContentHash: string;
    } | null = null;
    for await (const segment of this.remote.snapshotPages(revision)) {
      if (head) {
        if (
          head.revision !== segment.revision ||
          head.revisionContentHash !== segment.revisionContentHash ||
          head.spaceId !== segment.spaceId
        )
          throw new Error("快照分页元数据已变更");
      } else {
        head = {
          protocolVersion: segment.protocolVersion,
          spaceId: segment.spaceId,
          revision: segment.revision,
          revisionContentHash: segment.revisionContentHash,
        };
      }
      folders.push(...segment.folders);
      pages.push(...segment.pages);
      await progressCheckpoint(options, {
        phase: "download",
        completed: pages.length + folders.length,
        total: undefined,
        cancellable: true,
      });
    }
    if (!head) throw new Error("快照未返回元数据");
    return {
      protocolVersion: head.protocolVersion,
      spaceId: head.spaceId,
      revision: head.revision,
      revisionContentHash: head.revisionContentHash,
      folders,
      pages,
    };
  }

  private async discardOrphanPreviews(): Promise<void> {
    for (const dir of ["pull", "push"]) {
      try {
        await this.control.removeTree?.(this.root + "/" + dir);
      } catch {
        // Best-effort: orphaned preview artifacts are inert.
      }
    }
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

    const pushService = new TreePushService(
      this.remote,
      this.control,
      this.root + "/push",
    );
    const push = await pushService.inspect();
    if (push && push.localCommitPhase !== "verified") {
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
      } else if (push.remoteState !== "superseded") {
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
    }
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
    const local = await this.scan(options);
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
    await this.commitIdentities(preview.resolvedFolders);
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
        !before ||
        before.path !== folder.path ||
        before.parentFolderId !== folder.parentFolderId ||
        before.name !== folder.name
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
      if (!localFolders.has(folder.folderId))
        changes.push({
          operation: "archive_folder",
          folderId: folder.folderId,
          previousPath: folder.path,
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

  private async commitIdentities(folders: TreeFolder[]): Promise<void> {
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
      pendingPages: {},
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
