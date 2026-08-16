import type { PushBatch, SyncCapabilities } from "../../src/agentwiki/protocol";
import type {
  FinalizeResult,
  PushRemotePort,
  PushSessionInfo,
  PushSessionStatusInfo,
} from "../../src/ports/push-remote";

export class FakePushRemote implements PushRemotePort {
  readonly batches: PushBatch[] = [];
  finalizeCalls = 0;
  loseFinalizeResponseOnce = false;
  loseFirstUploadOnce = false;
  private session: PushSessionInfo | null = null;
  private result: FinalizeResult | null = null;
  constructor(
    readonly capabilities: SyncCapabilities,
    private revision: string,
  ) {}
  async getHead(): Promise<{ revision: string; pageCount?: string }> {
    return { revision: this.revision };
  }
  async createSession(): Promise<PushSessionInfo> {
    this.session ??= {
      sessionId: "session-1",
      status: "uploading",
      expiresAt: "2099-01-01T00:00:00.000Z",
      capabilities: this.capabilities,
      result: null,
    };
    return this.session;
  }
  async uploadBatch(
    _sessionId: string,
    batch: PushBatch,
  ): Promise<{ receipt: string }> {
    if (this.loseFirstUploadOnce) {
      this.loseFirstUploadOnce = false;
      throw new Error("upload interrupted");
    }
    this.batches.push(batch);
    return { receipt: `receipt-${batch.batchIndex}` };
  }
  async finalize(): Promise<FinalizeResult> {
    this.finalizeCalls += 1;
    this.revision = "r2";
    this.result = {
      status: "published",
      revision: "r2",
      sequence: 2,
      revisionContentHash: "hash-r2",
      pageCount: "1",
      revisionManifestByteLength: "100",
      revisionBodyBytes: "5",
      publishedAt: "2026-08-14T00:00:00.000Z",
      changeSetId: "c1",
    };
    if (this.session)
      this.session = {
        ...this.session,
        status: "published",
        result: this.result,
      };
    if (this.loseFinalizeResponseOnce) {
      this.loseFinalizeResponseOnce = false;
      throw new Error("finalize response lost");
    }
    return this.result;
  }
  async getSession(): Promise<PushSessionStatusInfo> {
    if (!this.session) throw new Error("missing session");
    return {
      sessionId: this.session.sessionId,
      status: this.session.status,
      expiresAt: this.session.expiresAt,
      receivedBatchIndexes: this.batches.map((batch) => batch.batchIndex),
      result: this.session.result,
    };
  }
}
