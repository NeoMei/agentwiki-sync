import {
  partitionTreePushChangesV2,
  treeConfirmationHashV2,
  type TreePushChangeV2,
  type TreePushConfirmationManifestV2,
  type TreePushManifestChangeV2,
} from "@neomei/agentwiki-sync-protocol";

import {
  capabilitiesHash,
  canonicalBytes,
  contentHash,
} from "../agentwiki/protocol";
import { AgentWikiHttpError } from "../agentwiki/client";
import { opaqueFileKey } from "../core/identity-key";
import type { TreeFolder, TreePage, TreePushChange } from "../core/tree-model";
import type { ControlStorePort } from "../ports/control-store";
import type {
  TreeCreatePushSession,
  TreeFinalizeResult,
  TreePushSession,
  TreeRemotePort,
  TreeSyncLimits,
} from "../ports/tree-remote";
import { MutableControlRepository } from "../storage/envelope";
import {
  progressCheckpoint,
  reportProgress,
  SyncCancelledError,
  type SyncOperationOptions,
} from "./progress";

type PreparedTreePage = Omit<TreePage, "body"> & {
  payloadPath: string;
  bodyBytes: number;
};

export type PreparedTreePushChange =
  | { operation: "upsert_folder"; folder: TreeFolder }
  | { operation: "archive_folder"; folderId: string; previousPath: string }
  | { operation: "upsert_page"; page: PreparedTreePage }
  | { operation: "archive_page"; pageId: string; previousPath: string };

export interface TreePushPreview {
  spaceId: string;
  baseRevision: string;
  changes: PreparedTreePushChange[];
  capabilities: TreeSyncLimits;
  credentialId?: string | null;
}

interface TreePushJournal {
  schemaVersion: 2;
  spaceId: string;
  baseRevision: string;
  idempotencyKey: string;
  confirmationHash: string;
  capabilitiesHash: string;
  capabilities: TreeSyncLimits;
  changes: PreparedTreePushChange[];
  totalBodyBytes: number;
  sessionId: string | null;
  credentialIdAtCreation: string | null;
  remoteState:
    "not_created" | "uploading" | "finalizing" | "published" | "superseded";
  result: TreeFinalizeResult | null;
  localCommitPhase: "not_started" | "verified";
}

const encoder = new TextEncoder();

function isPreparedTreePage(value: unknown): value is PreparedTreePage {
  if (!value || typeof value !== "object") return false;
  const page = value as Partial<PreparedTreePage>;
  return (
    typeof page.pageId === "string" &&
    (page.folderId === null || typeof page.folderId === "string") &&
    typeof page.path === "string" &&
    typeof page.title === "string" &&
    typeof page.contentHash === "string" &&
    typeof page.updatedAt === "string" &&
    typeof page.payloadPath === "string" &&
    Number.isSafeInteger(page.bodyBytes) &&
    (page.bodyBytes ?? -1) >= 0
  );
}

function isTreeFolder(value: unknown): value is TreeFolder {
  if (!value || typeof value !== "object") return false;
  const folder = value as Partial<TreeFolder>;
  return (
    typeof folder.folderId === "string" &&
    (folder.parentFolderId === null ||
      typeof folder.parentFolderId === "string") &&
    typeof folder.name === "string" &&
    typeof folder.path === "string" &&
    typeof folder.sortOrder === "number" &&
    typeof folder.updatedAt === "string"
  );
}

function isPreparedTreePushChange(
  value: unknown,
): value is PreparedTreePushChange {
  if (!value || typeof value !== "object") return false;
  const change = value as Partial<PreparedTreePushChange>;
  switch (change.operation) {
    case "upsert_folder":
      return isTreeFolder(change.folder);
    case "archive_folder":
      return (
        typeof change.folderId === "string" &&
        typeof change.previousPath === "string"
      );
    case "upsert_page":
      return isPreparedTreePage(change.page);
    case "archive_page":
      return (
        typeof change.pageId === "string" &&
        typeof change.previousPath === "string"
      );
    default:
      return false;
  }
}

function isTreePushJournal(value: unknown): value is TreePushJournal {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TreePushJournal>;
  return (
    item.schemaVersion === 2 &&
    typeof item.spaceId === "string" &&
    typeof item.baseRevision === "string" &&
    typeof item.idempotencyKey === "string" &&
    typeof item.confirmationHash === "string" &&
    typeof item.capabilitiesHash === "string" &&
    typeof item.capabilities === "object" &&
    item.capabilities !== null &&
    Array.isArray(item.changes) &&
    item.changes.every(isPreparedTreePushChange) &&
    Number.isSafeInteger(item.totalBodyBytes) &&
    (item.totalBodyBytes ?? -1) >= 0 &&
    (item.sessionId === null || typeof item.sessionId === "string") &&
    (item.credentialIdAtCreation === null ||
      typeof item.credentialIdAtCreation === "string") &&
    [
      "not_created",
      "uploading",
      "finalizing",
      "published",
      "superseded",
    ].includes(item.remoteState ?? "") &&
    (item.result === null || typeof item.result === "object") &&
    (item.localCommitPhase === "not_started" ||
      item.localCommitPhase === "verified")
  );
}

function toManifestChange(
  change: PreparedTreePushChange,
): TreePushManifestChangeV2 {
  switch (change.operation) {
    case "upsert_folder":
      return { operation: "upsert_folder", folder: change.folder };
    case "archive_folder":
      return {
        operation: "archive_folder",
        folderId: change.folderId,
        previousPath: change.previousPath,
      };
    case "upsert_page":
      return {
        operation: "upsert_page",
        page: {
          pageId: change.page.pageId,
          folderId: change.page.folderId,
          path: change.page.path,
          title: change.page.title,
          contentHash: change.page.contentHash,
          updatedAt: change.page.updatedAt,
        },
      };
    case "archive_page":
      return {
        operation: "archive_page",
        pageId: change.pageId,
        previousPath: change.previousPath,
      };
  }
}

function buildManifest(
  journal: TreePushJournal,
): TreePushConfirmationManifestV2 {
  return {
    protocolVersion: "2",
    spaceId: journal.spaceId,
    baseRevision: journal.baseRevision,
    changes: journal.changes.map(toManifestChange),
  };
}

export class TreePushService {
  private readonly journal: MutableControlRepository<TreePushJournal>;

  constructor(
    private readonly remote: TreeRemotePort,
    private readonly store: ControlStorePort,
    private readonly root: string,
  ) {
    this.journal = new MutableControlRepository(
      store,
      `${root}/journal.json`,
      isTreePushJournal,
    );
  }

  private async save(journal: TreePushJournal): Promise<void> {
    await this.journal.write(journal);
  }

  private async load(): Promise<TreePushJournal> {
    const raw = await this.store.read(`${this.root}/journal.json`);
    const version = readJournalSchemaVersion(raw);
    if (version !== null && version !== 2)
      throw new Error("不支持的推送日志版本");
    const value = await this.journal.read();
    if (!value) throw new Error("推送日志缺失或已损坏");
    return value.payload;
  }

  async inspect(): Promise<Pick<
    TreePushJournal,
    "remoteState" | "result" | "localCommitPhase" | "credentialIdAtCreation"
  > | null> {
    const value = await this.journal.read();
    return value
      ? {
          remoteState: value.payload.remoteState,
          result: value.payload.result,
          localCommitPhase: value.payload.localCommitPhase,
          credentialIdAtCreation: value.payload.credentialIdAtCreation ?? null,
        }
      : null;
  }

  private async payloadPath(pageId: string): Promise<string> {
    return `${this.root}/payload/${await opaqueFileKey(pageId)}.md`;
  }

  private async hydrateChange(
    change: PreparedTreePushChange,
  ): Promise<TreePushChange> {
    switch (change.operation) {
      case "upsert_folder":
        return { operation: "upsert_folder", folder: change.folder };
      case "archive_folder":
        return {
          operation: "archive_folder",
          folderId: change.folderId,
          previousPath: change.previousPath,
        };
      case "archive_page":
        return {
          operation: "archive_page",
          pageId: change.pageId,
          previousPath: change.previousPath,
        };
      case "upsert_page": {
        const body = await this.store.read(change.page.payloadPath);
        if (
          body === null ||
          (await contentHash(body)) !== change.page.contentHash
        )
          throw new Error("推送负载已损坏");
        return {
          operation: "upsert_page",
          page: {
            pageId: change.page.pageId,
            folderId: change.page.folderId,
            path: change.page.path,
            title: change.page.title,
            body,
            contentHash: change.page.contentHash,
            updatedAt: change.page.updatedAt,
          },
        };
      }
    }
  }

  private async hydrate(
    changes: PreparedTreePushChange[],
  ): Promise<TreePushChangeV2[]> {
    return Promise.all(changes.map((change) => this.hydrateChange(change)));
  }

  private createInput(journal: TreePushJournal): TreeCreatePushSession {
    const manifest = buildManifest(journal);
    return {
      baseRevision: journal.baseRevision,
      idempotencyKey: journal.idempotencyKey,
      capabilitiesHash: journal.capabilitiesHash,
      confirmationHash: journal.confirmationHash,
      confirmationByteLength: canonicalBytes(manifest).byteLength,
      changeCount: journal.changes.length,
      totalBodyBytes: journal.totalBodyBytes,
    };
  }

  private async createWithRebuild(
    journal: TreePushJournal,
  ): Promise<TreePushSession> {
    return this.createSession(journal, true);
  }

  private async createSession(
    journal: TreePushJournal,
    allowRebuild: boolean,
  ): Promise<TreePushSession> {
    try {
      return await this.remote.createPushSession(this.createInput(journal));
    } catch (error) {
      if (!allowRebuild || syncErrorCode(error) !== "CAPABILITIES_CHANGED")
        throw error;
      journal.capabilities = await this.remote.refreshCapabilities();
      journal.capabilitiesHash = await capabilitiesHash(journal.capabilities);
      journal.sessionId = null;
      journal.remoteState = "not_created";
      await this.save(journal);
      try {
        return await this.remote.createPushSession(this.createInput(journal));
      } catch (retryError) {
        if (syncErrorCode(retryError) === "CAPABILITIES_CHANGED")
          throw new Error("CAPABILITIES_CHANGED");
        throw retryError;
      }
    }
  }

  private async uploadBatches(
    journal: TreePushJournal,
    received: Set<number>,
    options?: SyncOperationOptions,
  ): Promise<void> {
    const hydrated = await this.hydrate(journal.changes);
    const batches = await partitionTreePushChangesV2(
      hydrated,
      journal.capabilities,
    );
    let completed = 0;
    for (const batch of batches) {
      if (!received.has(batch.batchIndex)) {
        const receipt = await this.remote.uploadBatch(
          journal.sessionId!,
          batch,
        );
        await this.store.write(
          `${this.root}/receipts/${batch.batchIndex}.json`,
          JSON.stringify({
            batchIndex: batch.batchIndex,
            batchHash: batch.batchHash,
            receipt: receipt.receipt,
          }),
        );
      }
      completed += 1;
      await progressCheckpoint(options, {
        phase: "upload",
        completed,
        total: batches.length,
        cancellable: true,
      });
    }
  }

  async publishPrepared(
    input: TreePushPreview,
    options?: SyncOperationOptions,
  ): Promise<TreeFinalizeResult> {
    if ((await this.remote.head()).revision !== input.baseRevision)
      throw new Error("BASE_STALE");
    const capabilities = input.capabilities;
    const capabilitiesHashValue = await capabilitiesHash(capabilities);
    if (capabilitiesHashValue !== (await this.remote.capabilitiesHash))
      throw new Error("能力集与服务器不一致");

    const staged: PreparedTreePushChange[] = [];
    let totalBodyBytes = 0;
    try {
      for (const change of input.changes) {
        if (change.operation === "upsert_page") {
          const body = await this.store.read(change.page.payloadPath);
          if (
            body === null ||
            (await contentHash(body)) !== change.page.contentHash
          )
            throw new Error("推送预览数据损坏");
          const bytes = encoder.encode(body).byteLength;
          if (bytes !== change.page.bodyBytes)
            throw new Error("推送预览数据长度变化");
          const payloadPath = await this.payloadPath(change.page.pageId);
          await this.store.write(payloadPath, body);
          totalBodyBytes += bytes;
          staged.push({
            operation: "upsert_page",
            page: { ...change.page, payloadPath, bodyBytes: bytes },
          });
        } else {
          staged.push(change);
        }
      }
    } catch (error) {
      if (error instanceof SyncCancelledError)
        await this.store.removeTree?.(`${this.root}/payload`);
      throw error;
    }

    const journal: TreePushJournal = {
      schemaVersion: 2,
      spaceId: input.spaceId,
      baseRevision: input.baseRevision,
      idempotencyKey: crypto.randomUUID(),
      confirmationHash: await treeConfirmationHashV2({
        protocolVersion: "2",
        spaceId: input.spaceId,
        baseRevision: input.baseRevision,
        changes: staged.map(toManifestChange),
      }),
      capabilitiesHash: capabilitiesHashValue,
      capabilities,
      changes: staged,
      totalBodyBytes,
      sessionId: null,
      credentialIdAtCreation: input.credentialId ?? null,
      remoteState: "not_created",
      result: null,
      localCommitPhase: "not_started",
    };
    await this.save(journal);

    try {
      await progressCheckpoint(options, {
        phase: "upload",
        completed: 0,
        cancellable: true,
      });
      const session = await this.createWithRebuild(journal);
      journal.sessionId = session.sessionId;
      journal.remoteState = "uploading";
      await this.save(journal);
      await this.uploadBatches(journal, new Set(), options);
      journal.remoteState = "finalizing";
      await this.save(journal);
      reportProgress(options, {
        phase: "finalize",
        completed: 0,
        cancellable: false,
      });
      return this.commitResult(
        journal,
        await this.remote.finalize(session.sessionId, journal.confirmationHash),
      );
    } catch (error) {
      const isPreFinalize =
        journal.remoteState === "not_created" ||
        journal.remoteState === "uploading";
      const cancelledBeforeFinalize =
        isPreFinalize &&
        (error instanceof SyncCancelledError ||
          options?.signal?.aborted === true);
      if (cancelledBeforeFinalize) {
        journal.remoteState = "superseded";
        await this.save(journal);
        if (journal.sessionId && this.remote.abort)
          try {
            await this.remote.abort(journal.sessionId);
          } catch {
            // 服务端过期清理放弃的暂存；本地不再 finalize。
          }
        if (!(error instanceof SyncCancelledError))
          throw new SyncCancelledError();
      }
      throw error;
    }
  }

  async resume(): Promise<TreeFinalizeResult | null> {
    const journal = await this.load();
    if (journal.remoteState === "superseded")
      throw new Error("已取消的推送无法恢复");
    if (journal.remoteState === "published" && journal.result)
      return journal.result;
    let received = new Set<number>();
    if (!journal.sessionId) {
      const created = await this.createWithRebuild(journal);
      journal.sessionId = created.sessionId;
      journal.remoteState = "uploading";
      await this.save(journal);
    } else {
      const session = await this.remote.getSession(journal.sessionId);
      if (session.status === "published" && session.result)
        return this.commitResult(journal, session.result);
      if (session.status === "aborted" || session.status === "expired")
        throw new Error("推送会话无法恢复");
      received = new Set(session.receivedBatchIndexes);
    }
    await this.uploadBatches(journal, received);
    journal.remoteState = "finalizing";
    await this.save(journal);
    return this.commitResult(
      journal,
      await this.remote.finalize(journal.sessionId, journal.confirmationHash),
    );
  }

  private async commitResult(
    journal: TreePushJournal,
    result: TreeFinalizeResult,
  ): Promise<TreeFinalizeResult> {
    journal.remoteState = "published";
    journal.result = result;
    await this.save(journal);
    return result;
  }

  async markVerified(): Promise<void> {
    const journal = await this.load();
    if (journal.remoteState !== "published" || !journal.result)
      throw new Error("推送结果未发布");
    journal.localCommitPhase = "verified";
    await this.save(journal);
    for (const dir of ["payload", "receipts"]) {
      try {
        await this.store.removeTree?.(`${this.root}/${dir}`);
      } catch {
        // 已验证的推送不再需要暂存负载。
      }
    }
  }

  async supersede(): Promise<void> {
    const journal = await this.load();
    if (journal.remoteState === "published")
      throw new Error("已发布的推送无法被替代");
    journal.remoteState = "superseded";
    await this.save(journal);
  }
}

function readJournalSchemaVersion(raw: string | null): number | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { payload?: { schemaVersion?: unknown } };
    const version = parsed.payload?.schemaVersion;
    return typeof version === "number" ? version : null;
  } catch {
    return null;
  }
}

function syncErrorCode(error: unknown): string | null {
  if (!(error instanceof AgentWikiHttpError)) return null;
  const body = error.body;
  if (typeof body !== "object" || body === null) return null;
  const code = (body as { error?: { code?: unknown } }).error?.code;
  return typeof code === "string" ? code : null;
}
