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

interface PushInput {
  spaceId: string;
  baseRevision: string;
  changes: PushChange[];
  capabilities: SyncCapabilities;
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
  remoteState: "not_created" | "uploading" | "finalizing" | "published";
  result: FinalizeResult | null;
  localCommitPhase: "not_started" | "verified";
}
function isPushJournal(value: unknown): value is PushJournal {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Partial<PushJournal>).schemaVersion === 1 &&
    typeof (value as Partial<PushJournal>).spaceId === "string" &&
    Number.isSafeInteger((value as Partial<PushJournal>).totalBodyBytes) &&
    ((value as Partial<PushJournal>).totalBodyBytes ?? -1) >= 0 &&
    ["not_created", "uploading", "finalizing", "published"].includes(
      (value as Partial<PushJournal>).remoteState ?? "",
    ) &&
    Array.isArray((value as Partial<PushJournal>).changes)
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
    if (!value) throw new Error("Missing or corrupt push journal");
    return value.payload;
  }
  async inspect(): Promise<Pick<
    PushJournal,
    "remoteState" | "result" | "localCommitPhase"
  > | null> {
    const value = await this.journal.read();
    return value
      ? {
          remoteState: value.payload.remoteState,
          result: value.payload.result,
          localCommitPhase: value.payload.localCommitPhase,
        }
      : null;
  }
  private async payloadPath(pageId: string): Promise<string> {
    return `${this.root}/payload/${await opaqueFileKey(pageId)}.md`;
  }
  private async persistPayload(changes: PushChange[]): Promise<void> {
    for (const change of changes)
      if (change.operation === "upsert")
        await this.store.write(
          await this.payloadPath(change.pageId),
          change.body,
        );
  }
  private async hydrateChange(change: JournalChange): Promise<PushChange> {
    if (change.operation === "archive") return change;
    const body = await this.store.read(await this.payloadPath(change.pageId));
    if (body === null || (await contentHash(body)) !== change.contentHash)
      throw new Error("Push payload is corrupt");
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
          throw new Error("Push preview payload is corrupt");
        const bytes = new TextEncoder().encode(body).byteLength;
        if (bytes !== change.bodyBytes)
          throw new Error("Push preview payload length changed");
        totalBodyBytes += bytes;
        await this.store.write(await this.payloadPath(change.pageId), body);
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
        throw new Error("Push session is no longer recoverable");
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
      throw new Error("Push result is not published");
    journal.localCommitPhase = "verified";
    await this.save(journal);
  }
}
