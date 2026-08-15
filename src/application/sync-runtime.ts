import {
  canonicalBytes,
  contentHash,
  decimalWithinLimit,
  parseCapabilities,
  revisionContentHash,
  sha256Hex,
  type SyncCapabilities,
  type SyncPage,
} from "../agentwiki/protocol";
import { mergeBody, mergeField, type StructuredConflict } from "../core/merge";
import type { LocalStatus, MoveHint, ScanResult } from "../core/model";
import {
  portablePathKey,
  titleFromPath,
  validatePortablePath,
} from "../core/portable-path";
import {
  computeStatus,
  resolvePageIdentities,
  scanMapping,
} from "../core/status";
import { decodeVaultMarkdown } from "../core/markdown";
import type { ControlStorePort } from "../ports/control-store";
import type {
  FinalizeResult,
  PushRemotePort,
  SnapshotResult,
} from "../ports/push-remote";
import type { VaultPort } from "../ports/vault";
import { BaselineRepository, type BaselineState } from "../storage/baseline";
import { MutableControlRepository } from "../storage/envelope";
import { PullTransaction, type PullAction } from "./pull-transaction";
import { PushService, type PreparedPushChange } from "./push-service";
import { opaqueFileKey, validatePublicId } from "../core/identity-key";
import { isValidSyncPath } from "../core/sync-path";
import type { SpaceMapping } from "./sync-coordinator";

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
export interface ConflictResolution {
  choice: "local" | "remote" | "manual";
  manualValue?: string;
}
export interface PullPreview {
  scanEpoch: number;
  revision: string;
  actions: PullAction[];
  remotePages: SyncPage[];
  conflicts: StructuredConflict[];
  conflictResolutions: Record<string, ConflictResolution>;
  initialBindings: InitialBindingChoice[];
  expectedVaultHashes: Record<string, string | null>;
  conflictValuePaths: Record<
    string,
    { base: string; local: string; remote: string }
  >;
  localCandidates: Array<{ path: string; vaultByteHash: string }>;
  artifactRoots: string[];
}
export interface PushPreview {
  revision: string;
  changes: PreparedPushChange[];
  capabilities: SyncCapabilities;
  previewId: string;
}
interface RuntimeRemote extends PushRemotePort {
  snapshot(revision?: string): Promise<SnapshotResult>;
  getCapabilities?(): Promise<SyncCapabilities>;
}
interface SnapshotDownload {
  metadata: Omit<SnapshotResult, "items">;
  pages: SyncPage[];
  previewId?: string;
}
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
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some(
      (key) => !["schemaVersion", "entries"].includes(key),
    )
  )
    return false;
  const state = value as Partial<PendingIdentities>;
  if (
    state.schemaVersion !== 1 ||
    !state.entries ||
    typeof state.entries !== "object"
  )
    return false;
  const paths = new Set<string>();
  for (const [key, entry] of Object.entries(state.entries)) {
    if (
      !entry ||
      key !== entry.pageId ||
      !entry.pageId ||
      !/^[0-9a-f]{64}$/.test(entry.contentHash) ||
      !["create", "restore"].includes(entry.intent)
    )
      return false;
    try {
      validatePublicId(entry.pageId);
      const allowed =
        entry.intent === "create"
          ? ["intent", "pageId", "path", "contentHash"]
          : [
              "intent",
              "pageId",
              "path",
              "contentHash",
              "archivedBasePath",
              "archivedBaseTitle",
              "archivedBaseContentHash",
            ];
      if (Object.keys(entry).some((field) => !allowed.includes(field)))
        return false;
      const path = validatePortablePath(entry.path);
      if (paths.has(path.key)) return false;
      paths.add(path.key);
      if (
        entry.intent === "restore" &&
        (!entry.archivedBasePath ||
          !entry.archivedBaseTitle ||
          !/^[0-9a-f]{64}$/.test(entry.archivedBaseContentHash))
      )
        return false;
      if (entry.intent === "restore")
        validatePortablePath(entry.archivedBasePath);
    } catch {
      return false;
    }
  }
  return true;
};
interface MoveHintsState {
  schemaVersion: 1;
  hints: MoveHint[];
}
interface PullControlAfterState {
  schemaVersion: 1;
  transactionId: string;
  phase: "pending" | "applied";
  identities: PendingIdentities;
  moveHints: MoveHintsState;
}
const isPullControlAfterState = (
  value: unknown,
): value is PullControlAfterState =>
  !!value &&
  typeof value === "object" &&
  (value as Partial<PullControlAfterState>).schemaVersion === 1 &&
  typeof (value as Partial<PullControlAfterState>).transactionId === "string" &&
  ["pending", "applied"].includes(
    (value as Partial<PullControlAfterState>).phase ?? "",
  ) &&
  isPendingIdentities((value as Partial<PullControlAfterState>).identities) &&
  isMoveHints((value as Partial<PullControlAfterState>).moveHints);
const isMoveHints = (value: unknown): value is MoveHintsState =>
  !!value &&
  typeof value === "object" &&
  (value as Partial<MoveHintsState>).schemaVersion === 1 &&
  Array.isArray((value as Partial<MoveHintsState>).hints);
const DEFAULT_CAPABILITIES: SyncCapabilities = {
  maxPageBytes: 1048576,
  maxBatchBytes: 4194304,
  maxBatchItems: 100,
  maxChangeCount: 5000,
  maxConfirmationBytes: 4194304,
  maxClientSpacePages: 5000,
  maxClientManifestBytes: 4194304,
  maxClientTotalBodyBytes: 104857600,
  maxResponseBytes: 4194304,
  maxPageItems: 100,
  pushSessionTtlSeconds: 900,
};
const safeKey = (value: string) => value.replace(/[^A-Za-z0-9_-]/gu, "_");
const joinRoot = (root: string, relative: string) =>
  `${root}/${validatePortablePath(relative).path}`;
const localFileName = async (
  pageId: string,
  relativePath: string,
): Promise<string> => {
  if (relativePath && isValidSyncPath(relativePath)) return relativePath;
  return `p-${await opaqueFileKey(pageId)}.md`;
};
export class SyncRuntime {
  private pinnedBase: BaselineState | null = null;
  private scanEpoch = 0;
  private readonly root: string;
  private readonly baseline: BaselineRepository;
  private readonly identities: MutableControlRepository<PendingIdentities>;
  private readonly moveHints: MutableControlRepository<MoveHintsState>;
  private readonly pullControlAfter: MutableControlRepository<PullControlAfterState>;
  private renameQueue: Promise<void> = Promise.resolve();
  constructor(
    private readonly vault: VaultPort,
    private readonly control: ControlStorePort,
    private readonly remote: RuntimeRemote,
    private readonly mapping: SpaceMapping,
    private readonly fallbackCapabilities = DEFAULT_CAPABILITIES,
    deviceKey = "local",
    spaceKey = safeKey(mapping.spaceId),
    private readonly credentialId: string | null = null,
  ) {
    this.root = `.agentwiki/devices/d-${safeKey(deviceKey)}/spaces/s-${safeKey(spaceKey)}`;
    this.baseline = new BaselineRepository(
      control,
      this.root,
      mapping.spaceId,
      mapping.rootPath,
    );
    this.identities = new MutableControlRepository(
      control,
      `${this.root}/pending-identities.json`,
      isPendingIdentities,
    );
    this.moveHints = new MutableControlRepository(
      control,
      `${this.root}/move-hints.json`,
      isMoveHints,
    );
    this.pullControlAfter = new MutableControlRepository(
      control,
      `${this.root}/pull-control-after.json`,
      isPullControlAfterState,
    );
  }
  invalidate(): void {
    this.scanEpoch += 1;
  }
  get spaceId(): string {
    return this.mapping.spaceId;
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
    const prefix = `${this.mapping.rootPath}/`;
    if (!fromPath.startsWith(prefix) || !toPath.startsWith(prefix)) return;
    const base = await this.readBase();
    const page = Object.values(base.pages).find(
      (item) =>
        portablePathKey(item.relativePath) ===
        portablePathKey(fromPath.slice(prefix.length)),
    );
    const bytes = await this.vault.read(toPath);
    if (!page || !bytes) return;
    const current = await this.moveHints.read();
    const hints = (current?.payload.hints ?? []).filter(
      (item) => item.pageId !== page.pageId,
    );
    hints.push({
      pageId: page.pageId,
      fromPath: page.relativePath,
      toPath: toPath.slice(prefix.length),
      observedVaultByteHash: await sha256Hex(bytes),
    });
    await this.moveHints.write({ schemaVersion: 1, hints });
  }
  private async applyPullControlAfter(transactionId: string): Promise<void> {
    const after = await this.pullControlAfter.read();
    if (
      !after ||
      after.payload.transactionId !== transactionId ||
      after.payload.phase === "applied"
    )
      return;
    await this.identities.write(after.payload.identities);
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
  private async readBase(): Promise<BaselineState> {
    const base = await this.baseline.read();
    this.pinnedBase = base;
    return base;
  }
  private async baseBody(page: {
    pageId: string;
    body?: string;
    contentHash: string;
  }): Promise<string> {
    return (
      page.body ??
      this.baseline.readBody(
        page.pageId,
        this.pinnedBase?.generationId,
        page.contentHash,
      )
    );
  }
  private async stageAndCommit(
    revision: string,
    pages: SyncPage[],
    kind: "pull" | "push" | "initialize",
  ): Promise<void> {
    await this.baseline.prepare(revision, pages, kind);
    await this.baseline.commit();
  }
  private async stageDownloadedAndCommit(
    revision: string,
    pages: SyncPage[],
    kind: "pull" | "push" | "initialize",
  ): Promise<void> {
    await this.baseline.prepareStreaming(revision, pages, kind, (page) =>
      this.remoteBody(revision, page),
    );
    await this.baseline.commit();
  }
  private verifyPublishedSnapshot(
    result: FinalizeResult,
    metadata: SnapshotDownload["metadata"],
  ): void {
    if (
      result.revision !== metadata.revision ||
      result.pageCount !== metadata.pageCount ||
      result.revisionBodyBytes !== metadata.revisionBodyBytes ||
      result.revisionManifestByteLength !==
        metadata.revisionManifestByteLength ||
      result.revisionContentHash !== metadata.revisionContentHash
    )
      throw new Error("已发布的快照与最终结果不匹配");
  }
  private async capabilities(): Promise<SyncCapabilities> {
    return parseCapabilities(
      this.remote.getCapabilities
        ? await this.remote.getCapabilities()
        : this.fallbackCapabilities,
    );
  }
  private async validateSnapshotResult(
    value: SnapshotResult,
    revision: string,
  ): Promise<void> {
    const capabilities = await this.capabilities();
    decimalWithinLimit(value.pageCount, capabilities.maxClientSpacePages);
    decimalWithinLimit(
      value.revisionBodyBytes,
      capabilities.maxClientTotalBodyBytes,
    );
    decimalWithinLimit(
      value.revisionManifestByteLength,
      capabilities.maxClientManifestBytes,
    );
    const pageIds = new Set<string>();
    const pathKeys = new Set<string>();
    let bodyBytes = 0;
    for (const page of value.items) {
      const path = validatePortablePath(page.path);
      if (pageIds.has(page.pageId) || pathKeys.has(path.key))
        throw new Error("快照包含重复的页面身份或路径");
      pageIds.add(page.pageId);
      pathKeys.add(path.key);
      if ((await contentHash(page.body)) !== page.contentHash)
        throw new Error("快照页面内容哈希不匹配");
      bodyBytes += new TextEncoder().encode(page.body).byteLength;
    }
    const manifest = {
      protocolVersion: "1" as const,
      spaceId: this.mapping.spaceId,
      pages: value.items.map((page) => ({
        pageId: page.pageId,
        path: page.path,
        title: page.title,
        contentHash: page.contentHash,
      })),
    };
    const manifestBytes =
      value.items.length === 0 ? 0 : canonicalBytes(manifest).byteLength;
    const hash = await revisionContentHash(manifest);
    if (
      value.revision !== revision ||
      value.pageCount !== String(value.items.length) ||
      value.revisionBodyBytes !== String(bodyBytes) ||
      value.revisionManifestByteLength !== String(manifestBytes) ||
      value.revisionContentHash !== hash
    )
      throw new Error("快照完整性不匹配");
  }
  private async downloadSnapshot(
    revision: string,
    previewId = crypto.randomUUID(),
  ): Promise<SnapshotDownload> {
    if (!this.remote.snapshotPages) {
      const value = await this.remote.snapshot(revision);
      await this.validateSnapshotResult(value, revision);
      const { items: pages, ...metadata } = value;
      return { metadata, pages };
    }
    const capabilities = await this.capabilities();
    let metadata: Omit<SnapshotResult, "items"> | null = null;
    const pages: SyncPage[] = [];
    let bodyBytes = 0;
    const ids = new Set<string>();
    const keys = new Set<string>();
    for await (const page of this.remote.snapshotPages(revision)) {
      const current = {
        revision: page.metadata.revision,
        revisionContentHash: page.metadata.revisionContentHash,
        pageCount: page.metadata.pageCount,
        revisionManifestByteLength: page.metadata.revisionManifestByteLength,
        revisionBodyBytes: page.metadata.revisionBodyBytes,
      };
      if (metadata && JSON.stringify(metadata) !== JSON.stringify(current))
        throw new Error("快照分页元数据已变更");
      metadata ??= current;
      decimalWithinLimit(current.pageCount, capabilities.maxClientSpacePages);
      decimalWithinLimit(
        current.revisionBodyBytes,
        capabilities.maxClientTotalBodyBytes,
      );
      decimalWithinLimit(
        current.revisionManifestByteLength,
        capabilities.maxClientManifestBytes,
      );
      for (const item of page.items) {
        const path = validatePortablePath(item.path);
        if (
          ids.has(item.pageId) ||
          keys.has(path.key) ||
          (await contentHash(item.body)) !== item.contentHash
        )
          throw new Error("快照完整性不匹配");
        ids.add(item.pageId);
        keys.add(path.key);
        bodyBytes += new TextEncoder().encode(item.body).byteLength;
        const sidecar = `${this.root}/downloads/${safeKey(previewId)}/${await localFileName(item.pageId, item.path)}`;
        await this.control.write(sidecar, item.body);
        pages.push({ ...item, body: "", bodyPath: sidecar } as SyncPage);
      }
    }
    if (!metadata) throw new Error("快照未返回元数据");
    const manifest = {
      protocolVersion: "1" as const,
      spaceId: this.mapping.spaceId,
      pages: pages.map((page) => ({
        pageId: page.pageId,
        path: page.path,
        title: page.title,
        contentHash: page.contentHash,
      })),
    };
    if (
      metadata.revision !== revision ||
      metadata.pageCount !== String(pages.length) ||
      metadata.revisionBodyBytes !== String(bodyBytes) ||
      metadata.revisionManifestByteLength !==
        String(pages.length ? canonicalBytes(manifest).byteLength : 0) ||
      metadata.revisionContentHash !== (await revisionContentHash(manifest))
    )
      throw new Error("快照完整性不匹配");
    return { metadata, pages, previewId };
  }
  private async remoteBody(revision: string, page: SyncPage): Promise<string> {
    void revision;
    const bodyPath = (page as SyncPage & { bodyPath?: string }).bodyPath;
    if (bodyPath === undefined) return page.body;
    const body = await this.control.read(bodyPath);
    if (body === null || (await contentHash(body)) !== page.contentHash)
      throw new Error("下载的快照内容已损坏");
    return body;
  }
  private async resultAction(
    kind: "create" | "write",
    path: string,
    body: string,
  ): Promise<PullAction>;
  private async resultAction(
    kind: "rename",
    path: string,
    body: string,
    fromPath: string,
  ): Promise<PullAction>;
  private async resultAction(
    kind: "create" | "write" | "rename",
    path: string,
    body: string,
    fromPath?: string,
  ): Promise<PullAction> {
    const bodyPath = `${this.root}/pull-preview-results/${crypto.randomUUID()}.md`;
    await this.control.write(bodyPath, body);
    return kind === "rename"
      ? { kind, fromPath: fromPath!, path, bodyPath }
      : { kind, path, bodyPath };
  }
  private async stageConflictValues(
    conflicts: StructuredConflict[],
    refs: Record<string, { base: string; local: string; remote: string }>,
  ): Promise<void> {
    for (const conflict of conflicts) {
      const root = `${this.root}/pull-conflicts/${safeKey(conflict.conflictId)}`;
      refs[conflict.conflictId] = {
        base: `${root}/base.md`,
        local: `${root}/local.md`,
        remote: `${root}/remote.md`,
      };
      await this.control.write(refs[conflict.conflictId]!.base, conflict.base);
      await this.control.write(
        refs[conflict.conflictId]!.local,
        conflict.local,
      );
      await this.control.write(
        refs[conflict.conflictId]!.remote,
        conflict.remote,
      );
      conflict.base = "";
      conflict.local = "";
      conflict.remote = "";
    }
  }
  private async conflictValue(
    preview: PullPreview,
    conflict: StructuredConflict,
    resolution: ConflictResolution,
  ): Promise<string> {
    if (resolution.choice === "manual")
      return (
        resolution.manualValue ??
        (await this.control.read(
          preview.conflictValuePaths[conflict.conflictId]!.local,
        )) ??
        ""
      );
    return (
      (await this.control.read(
        preview.conflictValuePaths[conflict.conflictId]![resolution.choice],
      )) ?? ""
    );
  }
  async conflictSummary(
    preview: PullPreview,
    conflict: StructuredConflict,
  ): Promise<{ base: string; local: string; remote: string }> {
    const refs = preview.conflictValuePaths[conflict.conflictId];
    if (!refs)
      return {
        base: conflict.base,
        local: conflict.local,
        remote: conflict.remote,
      };
    return {
      base: (await this.control.read(refs.base))?.slice(0, 120) ?? "",
      local: (await this.control.read(refs.local))?.slice(0, 120) ?? "",
      remote: (await this.control.read(refs.remote))?.slice(0, 120) ?? "",
    };
  }
  private async scan(): Promise<ScanResult> {
    const epoch = this.scanEpoch;
    const status = await this.vault.rootStatus(this.mapping.rootPath);
    if (status === "file") throw new Error("映射根是文件");
    if (status === "missing" && this.mapping.status === "active")
      throw new Error("本地扫描不完整：映射根目录缺失");
    const capabilities = await this.capabilities();
    try {
      const result = await scanMapping(
        status === "missing"
          ? []
          : this.vault.listMarkdown(this.mapping.rootPath),
        {
          complete: true,
          scanEpoch: epoch,
          retainBodies: false,
          capabilities: {
            pages: capabilities.maxClientSpacePages,
            bodyBytes: capabilities.maxClientTotalBodyBytes,
            manifestBytes: capabilities.maxClientManifestBytes,
          },
        },
      );
      if (epoch !== this.scanEpoch) throw new Error("扫描纪元已变更");
      return result;
    } catch (error) {
      throw new Error(
        `本地扫描不完整：${error instanceof Error ? error.message : "读取失败"}`,
      );
    }
  }
  private async localBody(file: {
    relativePath: string;
    normalizedBody?: string;
  }): Promise<string> {
    if (file.normalizedBody !== undefined) return file.normalizedBody;
    const bytes = await this.vault.read(
      joinRoot(this.mapping.rootPath, file.relativePath),
    );
    if (!bytes) throw new Error("预览期间本地文件消失");
    return decodeVaultMarkdown(bytes).normalized;
  }
  async establishEmptyBase(): Promise<void> {
    const head = await this.remote.getHead(this.mapping.spaceId);
    await this.stageAndCommit(head.revision, [], "initialize");
  }
  async recover(): Promise<void> {
    await this.discardOrphanPreviews();
    const pullTx = new PullTransaction(
      this.vault,
      this.control,
      `${this.root}/pull`,
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
    await this.baseline.recover(committedTransactionId);
    if (committedTransactionId)
      await this.applyPullControlAfter(committedTransactionId);
    const pushService = new PushService(
      this.remote,
      this.control,
      `${this.root}/push`,
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
        const base = await this.readBase();
        if (base.revision !== result.revision) {
          const downloaded = await this.downloadSnapshot(result.revision);
          this.verifyPublishedSnapshot(result, downloaded.metadata);
          await this.stageDownloadedAndCommit(
            result.revision,
            downloaded.pages,
            "push",
          );
        }
        await this.identities.clear();
        await this.moveHints.clear();
        await pushService.markVerified();
      }
    }
  }
  async status(): Promise<{
    baseRevision: string;
    remoteRevision: string;
    local: LocalStatus;
  }> {
    const base = await this.readBase();
    const scan = await this.scan();
    const resolved = resolvePageIdentities(
      base.pages,
      scan.files,
      (await this.moveHints.read())?.payload.hints ?? [],
    );
    const head = await this.remote.getHead(this.mapping.spaceId);
    return {
      baseRevision: base.revision,
      remoteRevision: head.revision,
      local: computeStatus(base.pages, resolved, scan),
    };
  }
  async hasUnfinishedPush(): Promise<boolean> {
    const push = await new PushService(
      this.remote,
      this.control,
      `${this.root}/push`,
    ).inspect();
    return !!push && push.localCommitPhase !== "verified";
  }
  async previewPull(): Promise<PullPreview> {
    const base = await this.readBase();
    const head = await this.remote.getHead(this.mapping.spaceId);
    const downloaded = await this.downloadSnapshot(head.revision);
    const remote = downloaded.pages;
    const scan = await this.scan();
    const localByPath = new Map(
      scan.files.map((file) => [portablePathKey(file.relativePath), file]),
    );
    const moveHints = (await this.moveHints.read())?.payload.hints ?? [];
    const localByPageId = new Map(
      resolvePageIdentities(base.pages, scan.files, moveHints).flatMap(
        (file) => (file.pageId ? [[file.pageId, file] as const] : []),
      ),
    );
    const actions: PullAction[] = [];
    const conflicts: StructuredConflict[] = [];
    const conflictValuePaths: Record<
      string,
      { base: string; local: string; remote: string }
    > = {};
    const addConflicts = async (items: StructuredConflict[]) => {
      await this.stageConflictValues(items, conflictValuePaths);
      conflicts.push(...items);
    };
    const initialBindings: InitialBindingChoice[] = [];
    const finalKeys = new Set<string>();
    for (const page of remote) {
      const remotePath = validatePortablePath(page.path).path;
      if (finalKeys.has(portablePathKey(remotePath)))
        throw new Error("PATH_COLLISION");
      finalKeys.add(portablePathKey(remotePath));
      const basePage = base.pages[page.pageId];
      const local = basePage
        ? localByPageId.get(page.pageId)
        : localByPath.get(portablePathKey(remotePath));
      const localBody = local ? await this.localBody(local) : null;
      if (!basePage) {
        initialBindings.push({
          pageId: page.pageId,
          remotePath,
          remoteBody: "",
          remoteBodyPath: (page as SyncPage & { bodyPath?: string }).bodyPath,
          localPath: local?.relativePath ?? null,
          localBody: null,
          localVaultByteHash: local?.vaultByteHash ?? null,
          resolution: local ? null : "remote",
        });
        continue;
      }
      if (!local) {
        const remoteChanged =
          basePage.contentHash !== page.contentHash ||
          portablePathKey(basePage.relativePath) !==
            portablePathKey(remotePath) ||
          basePage.title !== page.title;
        if (remoteChanged)
          await addConflicts([
            {
              conflictId: `delete:${page.pageId}`,
              pageId: page.pageId,
              field: "delete",
              base: await this.baseBody(basePage),
              local: "",
              remote: await this.remoteBody(head.revision, page),
              wholeDocument: true,
            },
          ]);
        continue;
      }
      const pathMerge = mergeField(
        basePage.relativePath,
        local.relativePath,
        remotePath,
      );
      const bodyMerge = await mergeBody(
        await this.baseBody(basePage),
        localBody!,
        await this.remoteBody(head.revision, page),
        page.pageId,
      );
      const pageConflicts = [...bodyMerge.conflicts];
      if (pathMerge.conflict)
        pageConflicts.push({
          conflictId: `path:${page.pageId}`,
          pageId: page.pageId,
          field: "path",
          base: basePage.relativePath,
          local: local.relativePath,
          remote: remotePath,
          wholeDocument: true,
        });
      await addConflicts(pageConflicts);
      if (pageConflicts.length === 0) {
        if (
          pathMerge.value.normalize("NFC") !==
          local.relativePath.normalize("NFC")
        )
          actions.push(
            await this.resultAction(
              "rename",
              joinRoot(this.mapping.rootPath, pathMerge.value),
              bodyMerge.body,
              joinRoot(this.mapping.rootPath, local.relativePath),
            ),
          );
        else if (bodyMerge.body !== localBody)
          actions.push(
            await this.resultAction(
              "write",
              joinRoot(this.mapping.rootPath, local.relativePath),
              bodyMerge.body,
            ),
          );
      }
    }
    const remoteIds = new Set(remote.map((page) => page.pageId));
    for (const page of Object.values(base.pages))
      if (!remoteIds.has(page.pageId)) {
        const local = localByPageId.get(page.pageId);
        if (local && local.contentHash !== page.contentHash)
          await addConflicts([
            {
              conflictId: `archive:${page.pageId}`,
              pageId: page.pageId,
              field: "archive",
              base: await this.baseBody(page),
              local: await this.localBody(local),
              remote: "",
              wholeDocument: true,
            },
          ]);
        else if (local)
          actions.push({
            kind: "trash",
            path: joinRoot(this.mapping.rootPath, local.relativePath),
          });
      }
    const expectedVaultHashes: Record<string, string | null> = {};
    for (const file of scan.files)
      expectedVaultHashes[joinRoot(this.mapping.rootPath, file.relativePath)] =
        file.vaultByteHash;
    const localCandidates = scan.files.map((file) => ({
      path: file.relativePath,
      vaultByteHash: file.vaultByteHash,
    }));
    return {
      scanEpoch: scan.scanEpoch,
      revision: head.revision,
      actions,
      remotePages: remote,
      conflicts,
      conflictResolutions: {},
      initialBindings,
      expectedVaultHashes,
      conflictValuePaths,
      localCandidates,
      artifactRoots: [
        `${this.root}/downloads/${safeKey(downloaded.previewId ?? head.revision)}`,
        `${this.root}/pull-preview-results`,
        `${this.root}/pull-conflicts`,
      ],
    };
  }
  async bindInitialLocal(
    preview: PullPreview,
    pageId: string,
    localPath: string,
  ): Promise<void> {
    const scan = await this.scan();
    if (scan.scanEpoch !== preview.scanEpoch) throw new Error("扫描纪元已变更");
    const local = scan.files.find(
      (file) =>
        portablePathKey(file.relativePath) === portablePathKey(localPath),
    );
    const binding = preview.initialBindings.find(
      (item) => item.pageId === pageId,
    );
    if (!local || !binding) throw new Error("初始绑定候选项缺失");
    if (
      preview.initialBindings.some(
        (item) =>
          item !== binding &&
          item.localPath !== null &&
          portablePathKey(item.localPath) === portablePathKey(localPath),
      )
    )
      throw new Error("本地页面已绑定");
    binding.localPath = local.relativePath;
    binding.localBody = await this.localBody(local);
    binding.localVaultByteHash = local.vaultByteHash;
    binding.resolution = null;
  }
  async discardPullPreview(preview: PullPreview): Promise<void> {
    for (const root of preview.artifactRoots)
      await this.control.removeTree?.(root);
  }
  async discardPushPreview(preview: PushPreview): Promise<void> {
    await this.control.removeTree?.(
      `${this.root}/push-preview/${safeKey(preview.previewId)}`,
    );
  }
  private async discardOrphanPreviews(): Promise<void> {
    for (const dir of [
      "downloads",
      "pull-preview-results",
      "pull-conflicts",
      "push-preview",
    ]) {
      try {
        await this.control.removeTree?.(`${this.root}/${dir}`);
      } catch {
        // Best-effort: orphaned preview artifacts are inert.
      }
    }
  }
  async applyPull(preview: PullPreview): Promise<void> {
    if (
      preview.conflicts.some(
        (item) => !preview.conflictResolutions[item.conflictId],
      ) ||
      preview.initialBindings.some((item) => item.resolution === null)
    )
      throw new Error("拉取存在未解决的结构化冲突");
    const boundKeys = new Set<string>();
    for (const item of preview.initialBindings)
      if (item.localPath) {
        const key = portablePathKey(item.localPath);
        if (boundKeys.has(key)) throw new Error("本地页面被多次绑定");
        boundKeys.add(key);
      }
    const actions = [...preview.actions];
    const hints: MoveHint[] = [];
    const restoreEntries: PendingIdentities["entries"] = {};
    for (const choice of preview.initialBindings) {
      const currentBody = choice.localPath
        ? (choice.localBody ??
          (await this.localBody({ relativePath: choice.localPath })))
        : null;
      const body =
        choice.resolution === "manual"
          ? (choice.manualBody ?? currentBody ?? choice.remoteBody)
          : choice.resolution === "local"
            ? (currentBody ?? choice.remoteBody)
            : choice.remoteBody ||
              (await this.remoteBody(
                preview.revision,
                preview.remotePages.find(
                  (page) => page.pageId === choice.pageId,
                )!,
              ));
      if (choice.localPath) {
        if (body !== currentBody)
          actions.push(
            await this.resultAction(
              "write",
              joinRoot(this.mapping.rootPath, choice.localPath),
              body,
            ),
          );
        if (choice.localVaultByteHash)
          hints.push({
            pageId: choice.pageId,
            fromPath: choice.remotePath,
            toPath: choice.localPath,
            observedVaultByteHash: choice.localVaultByteHash,
          });
      } else
        actions.push(
          await this.resultAction(
            "create",
            joinRoot(this.mapping.rootPath, choice.remotePath),
            body,
          ),
        );
    }
    const base = await this.readBase();
    const scan = await this.scan();
    const moveHints = (await this.moveHints.read())?.payload.hints ?? [];
    const resolved = resolvePageIdentities(base.pages, scan.files, moveHints);
    const conflictsByPage = new Map<string, StructuredConflict[]>();
    for (const conflict of preview.conflicts) {
      const list = conflictsByPage.get(conflict.pageId) ?? [];
      list.push(conflict);
      conflictsByPage.set(conflict.pageId, list);
    }
    for (const [pageId, pageConflicts] of conflictsByPage) {
      const local = resolved.find((file) => file.pageId === pageId);
      const remote = preview.remotePages.find((page) => page.pageId === pageId);
      const basePage = base.pages[pageId];
      const archiveConflict = pageConflicts.find(
        (item) => item.field === "archive",
      );
      if (archiveConflict) {
        if (
          preview.conflictResolutions[archiveConflict.conflictId]!.choice !==
            "local" &&
          local
        )
          actions.push({
            kind: "trash",
            path: joinRoot(this.mapping.rootPath, local.relativePath),
          });
        else if (local) {
          restoreEntries[pageId] = {
            intent: "restore",
            pageId,
            path: local.relativePath,
            contentHash: local.contentHash,
            archivedBasePath: basePage?.relativePath ?? local.relativePath,
            archivedBaseTitle: basePage?.title ?? local.title,
            archivedBaseContentHash: basePage?.contentHash ?? local.contentHash,
          };
          hints.push({
            pageId,
            fromPath: basePage?.relativePath ?? local.relativePath,
            toPath: local.relativePath,
            observedVaultByteHash: local.vaultByteHash,
          });
        }
        continue;
      }
      const deleteConflict = pageConflicts.find(
        (item) => item.field === "delete",
      );
      if (deleteConflict) {
        if (
          preview.conflictResolutions[deleteConflict.conflictId]!.choice !==
            "local" &&
          remote
        )
          actions.push(
            await this.resultAction(
              "create",
              joinRoot(this.mapping.rootPath, remote.path),
              await this.conflictValue(
                preview,
                deleteConflict,
                preview.conflictResolutions[deleteConflict.conflictId]!,
              ),
            ),
          );
        continue;
      }
      if (!local || !remote || !basePage) throw new Error("拉取冲突页面消失");
      const currentBody = await this.localBody(local);
      const bodyMerge = await mergeBody(
        await this.baseBody(basePage),
        currentBody,
        await this.remoteBody(preview.revision, remote),
        pageId,
      );
      const pathMerge = mergeField(
        basePage.relativePath,
        local.relativePath,
        remote.path,
      );
      const bodyConflict = pageConflicts.find((item) => item.field === "body");
      const pathConflict = pageConflicts.find((item) => item.field === "path");
      const finalBody = bodyConflict
        ? await this.conflictValue(
            preview,
            bodyConflict,
            preview.conflictResolutions[bodyConflict.conflictId]!,
          )
        : bodyMerge.body;
      const finalRelativePath = pathConflict
        ? validatePortablePath(
            await this.conflictValue(
              preview,
              pathConflict,
              preview.conflictResolutions[pathConflict.conflictId]!,
            ),
          ).path
        : pathMerge.value;
      if (
        finalRelativePath.normalize("NFC") !==
        local.relativePath.normalize("NFC")
      )
        actions.push(
          await this.resultAction(
            "rename",
            joinRoot(this.mapping.rootPath, finalRelativePath),
            finalBody,
            joinRoot(this.mapping.rootPath, local.relativePath),
          ),
        );
      else if (finalBody !== currentBody)
        actions.push(
          await this.resultAction(
            "write",
            joinRoot(this.mapping.rootPath, local.relativePath),
            finalBody,
          ),
        );
    }
    const baselineTx = await this.baseline.prepareStreaming(
      preview.revision,
      preview.remotePages,
      "pull",
      (page) => this.remoteBody(preview.revision, page),
    );
    await this.pullControlAfter.write({
      schemaVersion: 1,
      transactionId: baselineTx.transactionId,
      phase: "pending",
      identities: { schemaVersion: 1, entries: restoreEntries },
      moveHints: { schemaVersion: 1, hints },
    });
    await this.baseline.setPhase("applying");
    const tx = new PullTransaction(
      this.vault,
      this.control,
      `${this.root}/pull`,
    );
    const actionPaths = new Set<string>();
    for (const action of actions) {
      actionPaths.add(action.path);
      if (action.kind === "rename") actionPaths.add(action.fromPath);
    }
    const expectedHashes = Object.fromEntries(
      [...actionPaths].map((path) => [
        path,
        Object.hasOwn(preview.expectedVaultHashes, path)
          ? preview.expectedVaultHashes[path]!
          : null,
      ]),
    );
    await tx.prepare(
      actions,
      preview.scanEpoch,
      baselineTx.transactionId,
      expectedHashes,
    );
    await tx.apply(this.scanEpoch);
    await this.baseline.commit();
    await this.applyPullControlAfter(baselineTx.transactionId);
    await this.discardPullPreview(preview);
    this.mapping.status = "active";
  }
  async previewPush(): Promise<PushPreview> {
    const capabilities = await this.capabilities();
    const base = await this.readBase();
    const head = await this.remote.getHead(this.mapping.spaceId);
    if (this.mapping.status === "pending") {
      const remoteHasPages =
        head.pageCount !== undefined
          ? head.pageCount !== "0"
          : (await this.downloadSnapshot(head.revision)).pages.length > 0;
      if (remoteHasPages) throw new Error("INITIAL_PULL_REQUIRED");
    }
    const baseRevision =
      this.mapping.status === "pending" && Object.keys(base.pages).length === 0
        ? head.revision
        : base.revision;
    if (head.revision !== baseRevision) throw new Error("BASE_STALE");
    const scan = await this.scan();
    const hints = (await this.moveHints.read())?.payload.hints ?? [];
    const resolved = resolvePageIdentities(base.pages, scan.files, hints);
    const local = computeStatus(base.pages, resolved, scan);
    if (
      local.ambiguous.length ||
      (local.added.length > 0 && local.deleted.length > 0)
    )
      throw new Error("IDENTITY_REQUIRED");
    const envelope = await this.identities.read();
    const identities: PendingIdentities = envelope?.payload ?? {
      schemaVersion: 1,
      entries: {},
    };
    const changes: PreparedPushChange[] = [];
    const previewId = crypto.randomUUID();
    const changed = new Map<string, (typeof local.added)[number]>();
    for (const file of [...local.added, ...local.modified, ...local.renamed])
      changed.set(
        file.pageId ?? `path:${portablePathKey(file.relativePath)}`,
        file,
      );
    for (const file of changed.values()) {
      let identity =
        Object.values(identities.entries).find(
          (item) => item.path === file.relativePath,
        ) ||
        Object.values(identities.entries).find(
          (item) => item.contentHash === file.contentHash,
        );
      const pageId = file.pageId ?? identity?.pageId ?? crypto.randomUUID();
      if (!file.pageId) {
        identity =
          identity?.intent === "restore"
            ? {
                ...identity,
                path: file.relativePath,
                contentHash: file.contentHash,
              }
            : {
                intent: "create",
                pageId,
                path: file.relativePath,
                contentHash: file.contentHash,
              };
        identities.entries[pageId] = identity;
      }
      const body = await this.localBody(file);
      const payloadPath = `${this.root}/push-preview/${safeKey(previewId)}/${await localFileName(pageId, file.relativePath)}`;
      await this.control.write(payloadPath, body);
      changes.push({
        operation: "upsert",
        pageId,
        path: file.relativePath,
        title:
          identity?.intent === "restore" &&
          titleFromPath(identity.archivedBasePath) === file.title
            ? identity.archivedBaseTitle
            : file.title,
        contentHash: file.contentHash,
        payloadPath,
        bodyBytes: new TextEncoder().encode(body).byteLength,
      });
    }
    await this.identities.write(identities);
    for (const page of local.deleted)
      changes.push({
        operation: "archive",
        pageId: page.pageId,
        previousPath: page.relativePath,
      });
    return { revision: baseRevision, changes, capabilities, previewId };
  }
  async applyPush(preview: PushPreview): Promise<void> {
    if (!preview.changes.length) return;
    const service = new PushService(
      this.remote,
      this.control,
      `${this.root}/push`,
    );
    const result = await service.publishPrepared({
      spaceId: this.mapping.spaceId,
      baseRevision: preview.revision,
      changes: preview.changes,
      capabilities: preview.capabilities,
      credentialId: this.credentialId,
    });
    const downloaded = await this.downloadSnapshot(result.revision);
    const pages = downloaded.pages;
    this.verifyPublishedSnapshot(result, downloaded.metadata);
    await this.stageDownloadedAndCommit(result.revision, pages, "push");
    await this.identities.clear();
    await this.moveHints.clear();
    await service.markVerified();
    await this.discardPushPreview(preview);
    this.mapping.status = "active";
  }
}
