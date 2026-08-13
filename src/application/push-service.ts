import { canonicalBytes, capabilitiesHash, confirmationHash, contentHash, partitionPushChanges, type PushChange, type SyncCapabilities } from "../agentwiki/protocol";
import type { ControlStorePort } from "../ports/control-store";
import type { FinalizeResult, PushRemotePort } from "../ports/push-remote";

interface PushInput { spaceId: string; baseRevision: string; changes: PushChange[]; capabilities: SyncCapabilities }
interface PushJournal {
  schemaVersion: 1; spaceId: string; baseRevision: string; idempotencyKey: string; confirmationHash: string;
  capabilitiesHash: string; changes: Array<Omit<PushChange, "body">>; sessionId: string | null; remoteState: "not_created" | "uploading" | "finalizing" | "published";
  result: FinalizeResult | null; localCommitPhase: "not_started" | "verified";
}

export class PushService {
  constructor(private readonly remote: PushRemotePort, private readonly store: ControlStorePort, private readonly root: string) {}
  private get path(): string { return `${this.root}/journal.json`; }
  private async save(journal: PushJournal): Promise<void> { await this.store.write(this.path, JSON.stringify(journal)); }
  private async load(): Promise<PushJournal> { const raw = await this.store.read(this.path); if (!raw) throw new Error("Missing push journal"); return JSON.parse(raw) as PushJournal; }
  private async persistPayload(changes: PushChange[]): Promise<void> { for (const change of changes) if (change.operation === "upsert") await this.store.write(`${this.root}/payload/${change.pageId}.md`, change.body); }

  async publish(input: PushInput): Promise<FinalizeResult> {
    if ((await this.remote.getHead(input.spaceId)).revision !== input.baseRevision) throw new Error("BASE_STALE");
    for (const change of input.changes) if (change.operation === "upsert" && await contentHash(change.body) !== change.contentHash) throw new Error("PAYLOAD_INVALID: content hash");
    const manifest = { protocolVersion: "1" as const, spaceId: input.spaceId, baseRevision: input.baseRevision, changes: input.changes.map((change) => change.operation === "upsert" ? ({ operation: change.operation, pageId: change.pageId, path: change.path, title: change.title, contentHash: change.contentHash }) : change) };
    const manifestHash = await confirmationHash(manifest);
    const journalChanges = input.changes.map((change) => change.operation === "upsert" ? ({ operation: change.operation, pageId: change.pageId, path: change.path, title: change.title, contentHash: change.contentHash }) : change);
    const journal: PushJournal = { schemaVersion: 1, spaceId: input.spaceId, baseRevision: input.baseRevision, idempotencyKey: crypto.randomUUID(), confirmationHash: manifestHash, capabilitiesHash: await capabilitiesHash(input.capabilities), changes: journalChanges, sessionId: null, remoteState: "not_created", result: null, localCommitPhase: "not_started" };
    await this.persistPayload(input.changes);
    await this.save(journal);
    const totalBodyBytes = input.changes.reduce((total, change) => total + (change.operation === "upsert" ? new TextEncoder().encode(change.body).byteLength : 0), 0);
    const session = await this.remote.createSession({ baseRevision: input.baseRevision, idempotencyKey: journal.idempotencyKey, capabilitiesHash: journal.capabilitiesHash, confirmationHash: manifestHash, confirmationByteLength: canonicalBytes(manifest).byteLength, changeCount: input.changes.length, totalBodyBytes });
    journal.sessionId = session.sessionId; journal.remoteState = "uploading"; await this.save(journal);
    const batches = await partitionPushChanges(input.changes, session.capabilities);
    for (const batch of batches) { const receipt = await this.remote.uploadBatch(session.sessionId, batch); await this.store.write(`${this.root}/receipts/${batch.batchIndex}.json`, JSON.stringify({ batchIndex: batch.batchIndex, batchHash: batch.batchHash, receipt: receipt.receipt })); }
    journal.remoteState = "finalizing"; await this.save(journal);
    const result = await this.remote.finalize(session.sessionId, manifestHash);
    return this.commitResult(journal, result);
  }

  async resume(): Promise<FinalizeResult | null> {
    const journal = await this.load();
    if (!journal.sessionId) return null;
    const session = await this.remote.getSession(journal.sessionId);
    if (session.status !== "published" || !session.result) return null;
    return this.commitResult(journal, session.result);
  }

  private async commitResult(journal: PushJournal, result: FinalizeResult): Promise<FinalizeResult> {
    journal.remoteState = "published"; journal.result = result; await this.save(journal);
    return result;
  }
  async markVerified(): Promise<void> { const journal=await this.load(); if(journal.remoteState!=="published"||!journal.result)throw new Error("Push result is not published"); journal.localCommitPhase="verified"; await this.save(journal); }
}
