import type { AgentWikiClient } from "./client";
import type { PushBatch, SyncPage } from "./protocol";
import type { FinalizeResult, PushRemotePort, PushSessionInfo } from "../ports/push-remote";

export class AgentWikiPushRemote implements PushRemotePort {
  constructor(private readonly client: AgentWikiClient, private readonly spaceId: string) {}
  async getHead(): Promise<{ revision: string }> { return this.client.head(this.spaceId); }
  async createSession(input: Parameters<PushRemotePort["createSession"]>[0]): Promise<PushSessionInfo> { return (await this.client.raw("POST", `/api/sync/v1/spaces/${encodeURIComponent(this.spaceId)}/push-sessions`, input)).json as PushSessionInfo; }
  async uploadBatch(sessionId: string, batch: PushBatch): Promise<{ receipt: string }> { return (await this.client.raw("PUT", `/api/sync/v1/spaces/${encodeURIComponent(this.spaceId)}/push-sessions/${encodeURIComponent(sessionId)}/batches/${batch.batchIndex}`, batch)).json as { receipt: string }; }
  async finalize(sessionId: string, confirmationHash: string): Promise<FinalizeResult> { return (await this.client.raw("POST", `/api/sync/v1/spaces/${encodeURIComponent(this.spaceId)}/push-sessions/${encodeURIComponent(sessionId)}/finalize`, { confirmationHash, userConfirmed: true })).json as FinalizeResult; }
  async getSession(sessionId: string): Promise<PushSessionInfo> { return (await this.client.raw("GET", `/api/sync/v1/spaces/${encodeURIComponent(this.spaceId)}/push-sessions/${encodeURIComponent(sessionId)}`)).json as PushSessionInfo; }
  async snapshot(): Promise<SyncPage[]> { return (await this.client.snapshot(this.spaceId)).items; }
}
