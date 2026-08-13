import { canonicalBytes, capabilitiesHash, confirmationHash, contentHash, partitionPushChanges, type PushChange, type SyncCapabilities } from "../agentwiki/protocol";
import type { ControlStorePort } from "../ports/control-store";
import type { FinalizeResult, PushRemotePort } from "../ports/push-remote";
import { MutableControlRepository } from "../storage/envelope";

interface PushInput { spaceId: string; baseRevision: string; changes: PushChange[]; capabilities: SyncCapabilities }
type JournalChange=Exclude<PushChange,{operation:"upsert"}>|Omit<Extract<PushChange,{operation:"upsert"}>,"body">;
interface PushJournal {
  schemaVersion: 1; spaceId: string; baseRevision: string; idempotencyKey: string; confirmationHash: string;
  capabilitiesHash: string; capabilities:SyncCapabilities; changes: JournalChange[]; sessionId: string | null; remoteState: "not_created" | "uploading" | "finalizing" | "published";
  result: FinalizeResult | null; localCommitPhase: "not_started" | "verified";
}
function isPushJournal(value:unknown):value is PushJournal{return !!value&&typeof value==="object"&&(value as Partial<PushJournal>).schemaVersion===1&&typeof (value as Partial<PushJournal>).spaceId==="string"&&["not_created","uploading","finalizing","published"].includes((value as Partial<PushJournal>).remoteState??"")&&Array.isArray((value as Partial<PushJournal>).changes);}

export class PushService {
  private readonly journal:MutableControlRepository<PushJournal>;
  constructor(private readonly remote: PushRemotePort, private readonly store: ControlStorePort, private readonly root: string) {this.journal=new MutableControlRepository(store,`${root}/journal.json`,isPushJournal);}
  private async save(journal: PushJournal): Promise<void> { await this.journal.write(journal); }
  private async load(): Promise<PushJournal> { const value=await this.journal.read();if(!value)throw new Error("Missing or corrupt push journal");return value.payload; }
  async inspect():Promise<Pick<PushJournal,"remoteState"|"result"|"localCommitPhase">|null>{const value=await this.journal.read();return value?{remoteState:value.payload.remoteState,result:value.payload.result,localCommitPhase:value.payload.localCommitPhase}:null;}
  private async persistPayload(changes: PushChange[]): Promise<void> { for (const change of changes) if (change.operation === "upsert") await this.store.write(`${this.root}/payload/${change.pageId}.md`, change.body); }
  private async hydrate(journal:PushJournal):Promise<PushChange[]>{const changes:PushChange[]=[];for(const change of journal.changes){if(change.operation==="archive")changes.push(change);else{const body=await this.store.read(`${this.root}/payload/${change.pageId}.md`);if(body===null||await contentHash(body)!==change.contentHash)throw new Error("Push payload is corrupt");changes.push({...change,body});}}return changes;}
  private async create(journal:PushJournal,changes:PushChange[]){const manifest={protocolVersion:"1" as const,spaceId:journal.spaceId,baseRevision:journal.baseRevision,changes:journal.changes};const totalBodyBytes=changes.reduce((total,change)=>total+(change.operation==="upsert"?new TextEncoder().encode(change.body).byteLength:0),0);return this.remote.createSession({baseRevision:journal.baseRevision,idempotencyKey:journal.idempotencyKey,capabilitiesHash:journal.capabilitiesHash,confirmationHash:journal.confirmationHash,confirmationByteLength:canonicalBytes(manifest).byteLength,changeCount:changes.length,totalBodyBytes});}

  async publish(input: PushInput): Promise<FinalizeResult> {
    if ((await this.remote.getHead(input.spaceId)).revision !== input.baseRevision) throw new Error("BASE_STALE");
    for (const change of input.changes) if (change.operation === "upsert" && await contentHash(change.body) !== change.contentHash) throw new Error("PAYLOAD_INVALID: content hash");
    const manifest = { protocolVersion: "1" as const, spaceId: input.spaceId, baseRevision: input.baseRevision, changes: input.changes.map((change) => change.operation === "upsert" ? ({ operation: change.operation, pageId: change.pageId, path: change.path, title: change.title, contentHash: change.contentHash }) : change) };
    const manifestHash = await confirmationHash(manifest);
    const journalChanges = input.changes.map((change) => change.operation === "upsert" ? ({ operation: change.operation, pageId: change.pageId, path: change.path, title: change.title, contentHash: change.contentHash }) : change);
    const journal: PushJournal = { schemaVersion: 1, spaceId: input.spaceId, baseRevision: input.baseRevision, idempotencyKey: crypto.randomUUID(), confirmationHash: manifestHash, capabilitiesHash: await capabilitiesHash(input.capabilities), capabilities:input.capabilities, changes: journalChanges, sessionId: null, remoteState: "not_created", result: null, localCommitPhase: "not_started" };
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
    const changes=await this.hydrate(journal);let capabilities=journal.capabilities;let received=new Set<number>();
    if(!journal.sessionId){const created=await this.create(journal,changes);journal.sessionId=created.sessionId;journal.remoteState="uploading";capabilities=created.capabilities;await this.save(journal);}else{const session=await this.remote.getSession(journal.sessionId);if(session.status==="published"&&session.result)return this.commitResult(journal,session.result);if(session.status==="aborted"||session.status==="expired")throw new Error("Push session is no longer recoverable");received=new Set(session.receivedBatchIndexes);}
    const batches=await partitionPushChanges(changes,capabilities);for(const batch of batches)if(!received.has(batch.batchIndex)){const receipt=await this.remote.uploadBatch(journal.sessionId!,batch);await this.store.write(`${this.root}/receipts/${batch.batchIndex}.json`,JSON.stringify({batchIndex:batch.batchIndex,batchHash:batch.batchHash,receipt:receipt.receipt}));}journal.remoteState="finalizing";await this.save(journal);return this.commitResult(journal,await this.remote.finalize(journal.sessionId!,journal.confirmationHash));
  }

  private async commitResult(journal: PushJournal, result: FinalizeResult): Promise<FinalizeResult> {
    journal.remoteState = "published"; journal.result = result; await this.save(journal);
    return result;
  }
  async markVerified(): Promise<void> { const journal=await this.load(); if(journal.remoteState!=="published"||!journal.result)throw new Error("Push result is not published"); journal.localCommitPhase="verified"; await this.save(journal); }
}
