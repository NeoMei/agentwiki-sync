import {
  canonicalBytes,
  contentHash,
  revisionContentHash,
  type PushBatch,
  type SyncCapabilities,
  type SyncPage,
} from "../../src/agentwiki/protocol";
import type {
  FinalizeResult,
  PushRemotePort,
  PushSessionInfo,
} from "../../src/ports/push-remote";

interface Session {
  info: PushSessionInfo;
  baseRevision: string;
  batches: Map<number, PushBatch>;
}
export class FakeAgentWiki implements PushRemotePort {
  readonly spaceId = "space";
  readonly capabilities: SyncCapabilities = {
    maxPageBytes: 1048576,
    maxBatchBytes: 4194304,
    maxBatchItems: 100,
    maxChangeCount: 5000,
    maxConfirmationBytes: 4194304,
    maxClientSpacePages: 5000,
    maxClientManifestBytes: 4194304,
    maxClientTotalBodyBytes: 104857600,
    maxResponseBytes: 4194304,
    maxPageItems: 200,
    pushSessionTtlSeconds: 900,
  };
  canPublish = true;
  truncateNextSnapshot = false;
  private revision = 0;
  private readonly pages = new Map<string, SyncPage>();
  private readonly sessions = new Map<string, Session>();
  async getHead(): Promise<{ revision: string; pageCount?: string }> {
    return {
      revision: String(this.revision),
      pageCount: String(this.pages.size),
    };
  }
  async getCapabilities(): Promise<SyncCapabilities> {
    return this.capabilities;
  }
  async createSession(input: {
    baseRevision: string;
  }): Promise<PushSessionInfo> {
    if (input.baseRevision !== String(this.revision))
      throw new Error("BASE_STALE");
    const sessionId = `session-${this.sessions.size + 1}`;
    const info: PushSessionInfo = {
      sessionId,
      status: "uploading",
      expiresAt: "2099-01-01T00:00:00.000Z",
      capabilities: this.capabilities,
      result: null,
    };
    this.sessions.set(sessionId, {
      info,
      baseRevision: input.baseRevision,
      batches: new Map(),
    });
    return info;
  }
  async uploadBatch(
    sessionId: string,
    batch: PushBatch,
  ): Promise<{ receipt: string }> {
    this.sessions.get(sessionId)!.batches.set(batch.batchIndex, batch);
    return { receipt: `r-${batch.batchIndex}` };
  }
  async finalize(sessionId: string): Promise<FinalizeResult> {
    if (!this.canPublish) throw new Error("SPACE_READ_ONLY");
    const session = this.sessions.get(sessionId)!;
    if (session.baseRevision !== String(this.revision))
      throw new Error("BASE_STALE");
    for (const batch of [...session.batches.values()].sort(
      (a, b) => a.batchIndex - b.batchIndex,
    ))
      for (const change of batch.changes) {
        if (change.operation === "archive") this.pages.delete(change.pageId);
        else
          this.pages.set(change.pageId, {
            pageId: change.pageId,
            path: change.path,
            title: change.title,
            body: change.body,
            contentHash: await contentHash(change.body),
            updatedAt: "2026-08-14T00:00:00.000Z",
          });
      }
    this.revision += 1;
    const manifest = {
      protocolVersion: "1" as const,
      spaceId: this.spaceId,
      pages: [...this.pages.values()].map((page) => ({
        pageId: page.pageId,
        path: page.path,
        title: page.title,
        contentHash: page.contentHash,
      })),
    };
    const result: FinalizeResult = {
      status: "published",
      revision: String(this.revision),
      sequence: this.revision,
      publishedAt: "2026-08-14T00:00:00.000Z",
      revisionContentHash: await revisionContentHash(manifest),
      pageCount: String(this.pages.size),
      revisionManifestByteLength: String(canonicalBytes(manifest).byteLength),
      revisionBodyBytes: String(
        [...this.pages.values()].reduce(
          (sum, page) => sum + new TextEncoder().encode(page.body).byteLength,
          0,
        ),
      ),
      changeSetId: `c-${this.revision}`,
    };
    session.info = { ...session.info, status: "published", result };
    return result;
  }
  async getSession(sessionId: string) {
    const info = this.sessions.get(sessionId)!.info;
    return {
      sessionId: info.sessionId,
      status: info.status,
      expiresAt: info.expiresAt,
      receivedBatchIndexes: [...this.sessions.get(sessionId)!.batches.keys()],
      result: info.result,
    };
  }
  async snapshot() {
    const all = [...this.pages.values()].map((page) => ({ ...page }));
    const manifest = {
      protocolVersion: "1" as const,
      spaceId: this.spaceId,
      pages: all.map((page) => ({
        pageId: page.pageId,
        path: page.path,
        title: page.title,
        contentHash: page.contentHash,
      })),
    };
    const items = this.truncateNextSnapshot ? all.slice(0, -1) : all;
    this.truncateNextSnapshot = false;
    return {
      revision: String(this.revision),
      revisionContentHash: await revisionContentHash(manifest),
      pageCount: String(all.length),
      revisionManifestByteLength: String(
        all.length === 0 ? 0 : canonicalBytes(manifest).byteLength,
      ),
      revisionBodyBytes: String(
        all.reduce(
          (sum, page) => sum + new TextEncoder().encode(page.body).byteLength,
          0,
        ),
      ),
      items,
    };
  }
  async seed(pages: SyncPage[]): Promise<void> {
    this.pages.clear();
    for (const page of pages) this.pages.set(page.pageId, { ...page });
    this.revision = pages.length > 0 ? 1 : 0;
  }
  async replace(pages: SyncPage[]): Promise<void> {
    this.pages.clear();
    for (const page of pages) this.pages.set(page.pageId, { ...page });
    this.revision += 1;
  }
  async advanceEmptyRevision(): Promise<void> {
    this.revision += 1;
  }
  sessionCount(): number {
    return this.sessions.size;
  }
}
