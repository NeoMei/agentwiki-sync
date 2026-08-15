import {
  batchHash,
  canonicalBytes,
  capabilitiesHash,
  comparePushChanges,
  confirmationHash,
  contentHash,
  type PushBatch,
  type PushChange,
  type SyncCapabilities,
} from "../agentwiki/protocol";
import type { ControlStorePort } from "../ports/control-store";
import type { FinalizeResult, PushRemotePort } from "../ports/push-remote";
import { MutableControlRepository } from "../storage/envelope";
import { opaqueFileKey } from "../core/identity-key";
import { isValidSyncPath } from "../core/sync-path";

interface PushInput {
  spaceId: string;
  baseRevision: string;
  changes: PushChange[];
  capabilities: SyncCapabilities;
  credentialId?: string | null;
}
type JournalChange =
  | Exclude<PushChange, { operation: "upsert" }>
  | Omit<Extract<PushChange, { operation: "upsert" }>, "body">;
export type PreparedPushChange =
  | Exclude<PushChange, { operation: "upsert" }>
  | (Omit<Extract<PushChange, { operation: "upsert" }>, "body"> & {
      payloadPath: string;
      bodyBytes: number;
    });
interface PreparedPushInput {
  spaceId: string;
  baseRevision: string;
  changes: PreparedPushChange[];
  capabilities: SyncCapabilities;
  credentialId?: string | null;
}
interface PushJournal {
  schemaVersion: 1;
  spaceId: string;
  baseRevision: string;
  idempotencyKey: string;
  confirmationHash: string;
  capabilitiesHash: string;
  capabilities: SyncCapabilities;
  changes: JournalChange[];
  totalBodyBytes: number;
  sessionId: string | null;
  credentialIdAtCreation: string | null;
  remoteState:
    "not_created" | "uploading" | "finalizing" | "published" | "superseded";
  result: FinalizeResult | null;
  localCommitPhase: "not_started" | "verified";
}
function isPushJournal(value: unknown): value is PushJournal {
  const item = value as Partial<PushJournal>;
  return (
    !!value &&
    typeof value === "object" &&
    item.schemaVersion === 1 &&
    typeof item.spaceId === "string" &&
    Number.isSafeInteger(item.totalBodyBytes) &&
    (item.totalBodyBytes ?? -1) >= 0 &&
    (item.credentialIdAtCreation === undefined ||
      item.credentialIdAtCreation === null ||
      typeof item.credentialIdAtCreation === "string") &&
    [
      "not_created",
      "uploading",
      "finalizing",
      "published",
      "superseded",
    ].includes(item.remoteState ?? "") &&
    Array.isArray(item.changes)
  );
}

export class PushService {
  private readonly journal: MutableControlRepository<PushJournal>;
  constructor(
    private readonly remote: PushRemotePort,
    private readonly store: ControlStorePort,
    private readonly root: string,
  ) {
    this.journal = new MutableControlRepository(
      store,
      `${root}/journal.json`,
      isPushJournal,
    );
  }
  private async save(journal: PushJournal): Promise<void> {
    await this.journal.write(journal);
  }
  private async load(): Promise<PushJournal> {
    const value = await this.journal.read();
    if (!value) throw new Error("推送日志缺失或已损坏");
    return value.payload;
  }
  async inspect(): Promise<Pick<
    PushJournal,
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
  /**
   * 生成可读的 payload 文件名
   * 优先使用 syncPath（如果合法），否则回退到哈希文件名
   */
  private async payloadFileName(
    pageId: string,
    path?: string,
  ): Promise<string> {
    if (path && isValidSyncPath(path)) return path;
    return `p-${await opaqueFileKey(pageId)}.md`;
  }
  private async payloadPath(pageId: string, path?: string): Promise<string> {
    return `${this.root}/payload/${await this.payloadFileName(pageId, path)}`;
  }
  private async persistPayload(changes: PushChange[]): Promise<void> {
    for (const change of changes)
      if (change.operation === "upsert")
        await this.store.write(
          await this.payloadPath(change.pageId, change.path),
          change.body,
        );
  }
  private async hydrateChange(change: JournalChange): Promise<PushChange> {
    if (change.operation === "archive") return change;
    // 尝试可读路径，如果不存在则回退到哈希路径
    let body = await this.store.read(
      await this.payloadPath(change.pageId, change.path),
    );
    if (body === null) {
      body = await this.store.read(await this.payloadPath(change.pageId));
    }
    if (body === null || (await contentHash(body)) !== change.contentHash)
      throw new Error("推送负载已损坏");
    return { ...change, body };
  }
  private async create(journal: PushJournal) {
    const manifest = {
      protocolVersion: "1" as const,
      spaceId: journal.spaceId,
      baseRevision: journal.baseRevision,
      changes: journal.changes,
    };
    return this.remote.createSession({
      baseRevision: journal.baseRevision,
      idempotencyKey: journal.idempotencyKey,
      capabilitiesHash: journal.capabilitiesHash,
      confirmationHash: journal.confirmationHash,
      confirmationByteLength: canonicalBytes(manifest).byteLength,
      changeCount: journal.changes.length,
      totalBodyBytes: journal.totalBodyBytes,
    });
  }
  private async validateSessionCapabilities(
    journal: PushJournal,
    capabilities: SyncCapabilities,
  ): Promise<void> {
    if ((await capabilitiesHash(capabilities)) !== journal.capabilitiesHash)
      throw new Error("CAPABILITIES_CHANGED");
  }
  private async makeBatch(
    index: number,
    changes: PushChange[],
  ): Promise<PushBatch> {
    const value = { protocolVersion: "1" as const, batchIndex: index, changes };
    return { ...value, batchHash: await batchHash(value) };
  }
  private async uploadBatches(
    journal: PushJournal,
    capabilities: SyncCapabilities,
    received: Set<number>,
  ): Promise<void> {
    const sorted = [...journal.changes].sort(comparePushChanges);
    let batchIndex = 0;
    let current: PushChange[] = [];
    const flush = async () => {
      if (current.length === 0) return;
      const batch = await this.makeBatch(batchIndex, current);
      if (!received.has(batchIndex)) {
        const receipt = await this.remote.uploadBatch(
          journal.sessionId!,
          batch,
        );
        await this.store.write(
          `${this.root}/receipts/${batchIndex}.json`,
          JSON.stringify({
            batchIndex,
            batchHash: batch.batchHash,
            receipt: receipt.receipt,
          }),
        );
      }
      batchIndex += 1;
      current = [];
    };
    for (const metadata of sorted) {
      const change = await this.hydrateChange(metadata);
      if (
        change.operation === "upsert" &&
        new TextEncoder().encode(change.body).byteLength >
          capabilities.maxPageBytes
      )
        throw new RangeError("PAGE_TOO_LARGE");
      const proposed = [...current, change];
      const candidate = await this.makeBatch(batchIndex, proposed);
      if (
        proposed.length > capabilities.maxBatchItems ||
        canonicalBytes(candidate).byteLength > capabilities.maxBatchBytes
      ) {
        if (current.length === 0) throw new RangeError("BATCH_TOO_LARGE");
        await flush();
        const single = await this.makeBatch(batchIndex, [change]);
        if (canonicalBytes(single).byteLength > capabilities.maxBatchBytes)
          throw new RangeError("BATCH_TOO_LARGE");
        current = [change];
      } else current = proposed;
    }
    await flush();
  }

  async publish(input: PushInput): Promise<FinalizeResult> {
    if (
      (await this.remote.getHead(input.spaceId)).revision !== input.baseRevision
    )
      throw new Error("BASE_STALE");
    for (const change of input.changes)
      if (
        change.operation === "upsert" &&
        (await contentHash(change.body)) !== change.contentHash
      )
        throw new Error("PAYLOAD_INVALID: content hash");
    const sorted = [...input.changes].sort(comparePushChanges);
    const manifest = {
      protocolVersion: "1" as const,
      spaceId: input.spaceId,
      baseRevision: input.baseRevision,
      changes: sorted.map((change) =>
        change.operation === "upsert"
          ? {
              operation: change.operation,
              pageId: change.pageId,
              path: change.path,
              title: change.title,
              contentHash: change.contentHash,
            }
          : change,
      ),
    };
    const manifestHash = await confirmationHash(manifest);
    const journalChanges = manifest.changes;
    const totalBodyBytes = input.changes.reduce(
      (total, change) =>
        total +
        (change.operation === "upsert"
          ? new TextEncoder().encode(change.body).byteLength
          : 0),
      0,
    );
    const journal: PushJournal = {
      schemaVersion: 1,
      spaceId: input.spaceId,
      baseRevision: input.baseRevision,
      idempotencyKey: crypto.randomUUID(),
      confirmationHash: manifestHash,
      capabilitiesHash: await capabilitiesHash(input.capabilities),
      capabilities: input.capabilities,
      changes: journalChanges,
      totalBodyBytes,
      sessionId: null,
      credentialIdAtCreation: input.credentialId ?? null,
      remoteState: "not_created",
      result: null,
      localCommitPhase: "not_started",
    };
    await this.persistPayload(input.changes);
    await this.save(journal);
    const session = await this.create(journal);
    await this.validateSessionCapabilities(journal, session.capabilities);
    journal.sessionId = session.sessionId;
    journal.remoteState = "uploading";
    await this.save(journal);
    await this.uploadBatches(journal, session.capabilities, new Set());
    journal.remoteState = "finalizing";
    await this.save(journal);
    const result = await this.remote.finalize(session.sessionId, manifestHash);
    return this.commitResult(journal, result);
  }

  async publishPrepared(input: PreparedPushInput): Promise<FinalizeResult> {
    if (
      (await this.remote.getHead(input.spaceId)).revision !== input.baseRevision
    )
      throw new Error("BASE_STALE");
    const sorted = [...input.changes].sort(comparePushChanges);
    let totalBodyBytes = 0;
    for (const change of sorted)
      if (change.operation === "upsert") {
        const body = await this.store.read(change.payloadPath);
        if (body === null || (await contentHash(body)) !== change.contentHash)
          throw new Error("推送预览数据损坏");
        const bytes = new TextEncoder().encode(body).byteLength;
        if (bytes !== change.bodyBytes) throw new Error("推送预览数据长度变化");
        totalBodyBytes += bytes;
        await this.store.write(
          await this.payloadPath(change.pageId, change.path),
          body,
        );
      }
    const journalChanges: JournalChange[] = sorted.map((change) =>
      change.operation === "archive"
        ? change
        : {
            operation: "upsert",
            pageId: change.pageId,
            path: change.path,
            title: change.title,
            contentHash: change.contentHash,
          },
    );
    const manifest = {
      protocolVersion: "1" as const,
      spaceId: input.spaceId,
      baseRevision: input.baseRevision,
      changes: journalChanges,
    };
    const journal: PushJournal = {
      schemaVersion: 1,
      spaceId: input.spaceId,
      baseRevision: input.baseRevision,
      idempotencyKey: crypto.randomUUID(),
      confirmationHash: await confirmationHash(manifest),
      capabilitiesHash: await capabilitiesHash(input.capabilities),
      capabilities: input.capabilities,
      changes: journalChanges,
      totalBodyBytes,
      sessionId: null,
      credentialIdAtCreation: input.credentialId ?? null,
      remoteState: "not_created",
      result: null,
      localCommitPhase: "not_started",
    };
    await this.save(journal);
    const session = await this.create(journal);
    await this.validateSessionCapabilities(journal, session.capabilities);
    journal.sessionId = session.sessionId;
    journal.remoteState = "uploading";
    await this.save(journal);
    await this.uploadBatches(journal, session.capabilities, new Set());
    journal.remoteState = "finalizing";
    await this.save(journal);
    return this.commitResult(
      journal,
      await this.remote.finalize(session.sessionId, journal.confirmationHash),
    );
  }

  async resume(): Promise<FinalizeResult | null> {
    const journal = await this.load();
    let capabilities = journal.capabilities;
    let received = new Set<number>();
    if (!journal.sessionId) {
      const created = await this.create(journal);
      await this.validateSessionCapabilities(journal, created.capabilities);
      journal.sessionId = created.sessionId;
      journal.remoteState = "uploading";
      capabilities = created.capabilities;
      await this.save(journal);
    } else {
      const session = await this.remote.getSession(journal.sessionId);
      if (session.status === "published" && session.result)
        return this.commitResult(journal, session.result);
      if (session.status === "aborted" || session.status === "expired")
        throw new Error("推送会话无法恢复");
      received = new Set(session.receivedBatchIndexes);
    }
    await this.uploadBatches(journal, capabilities, received);
    journal.remoteState = "finalizing";
    await this.save(journal);
    return this.commitResult(
      journal,
      await this.remote.finalize(journal.sessionId!, journal.confirmationHash),
    );
  }

  private async commitResult(
    journal: PushJournal,
    result: FinalizeResult,
  ): Promise<FinalizeResult> {
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
        // Best-effort: a verified push no longer needs staged payloads.
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
