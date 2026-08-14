import type { AgentWikiClient } from "./client";
import {
  CreatePushSessionRequestSchema,
  CreatePushSessionResponseSchema,
  FinalizePushRequestSchema,
  FinalizeResultSchema,
  parseCapabilities,
  PushReceiptSchema,
  PushSessionStatusResponseSchema,
  UploadPushBatchRequestSchema,
  type PushBatch,
} from "./protocol";
import type {
  FinalizeResult,
  PushRemotePort,
  PushSessionInfo,
  PushSessionStatusInfo,
  SnapshotResult,
} from "../ports/push-remote";

export class AgentWikiPushRemote implements PushRemotePort {
  constructor(
    private readonly client: AgentWikiClient,
    private readonly spaceId: string,
  ) {}
  async getHead(): Promise<{ revision: string; pageCount?: string }> {
    return this.client.head(this.spaceId);
  }
  async getCapabilities() {
    return parseCapabilities(
      (await import("./protocol")).SessionResponseSchema.parse(
        (await this.client.raw("GET", "/api/integrations/obsidian/session"))
          .json,
      ).capabilities,
    );
  }
  async createSession(
    input: Parameters<PushRemotePort["createSession"]>[0],
  ): Promise<PushSessionInfo> {
    const body = CreatePushSessionRequestSchema.parse(input);
    const value = CreatePushSessionResponseSchema.parse(
      (
        await this.client.raw(
          "POST",
          `/api/sync/v1/spaces/${encodeURIComponent(this.spaceId)}/push-sessions`,
          body,
          true,
          true,
        )
      ).json,
    );
    return { ...value, capabilities: parseCapabilities(value.capabilities) };
  }
  async uploadBatch(
    sessionId: string,
    batch: PushBatch,
  ): Promise<{ receipt: string }> {
    const body = UploadPushBatchRequestSchema.parse(batch);
    return PushReceiptSchema.parse(
      (
        await this.client.raw(
          "PUT",
          `/api/sync/v1/spaces/${encodeURIComponent(this.spaceId)}/push-sessions/${encodeURIComponent(sessionId)}/batches/${batch.batchIndex}`,
          body,
          true,
          true,
        )
      ).json,
    );
  }
  async finalize(
    sessionId: string,
    confirmationHash: string,
  ): Promise<FinalizeResult> {
    const body = FinalizePushRequestSchema.parse({
      confirmationHash,
      userConfirmed: true,
    });
    return FinalizeResultSchema.parse(
      (
        await this.client.raw(
          "POST",
          `/api/sync/v1/spaces/${encodeURIComponent(this.spaceId)}/push-sessions/${encodeURIComponent(sessionId)}/finalize`,
          body,
        )
      ).json,
    );
  }
  async getSession(sessionId: string): Promise<PushSessionStatusInfo> {
    return PushSessionStatusResponseSchema.parse(
      (
        await this.client.raw(
          "GET",
          `/api/sync/v1/spaces/${encodeURIComponent(this.spaceId)}/push-sessions/${encodeURIComponent(sessionId)}`,
        )
      ).json,
    );
  }
  async snapshot(revision = "current"): Promise<SnapshotResult> {
    const value = await this.client.snapshot(this.spaceId, revision);
    return { ...value.metadata, items: value.items };
  }
  async *snapshotPages(revision = "current") {
    yield* this.client.snapshotPages(this.spaceId, revision);
  }
}
