import { describe, expect, it } from "vitest";
import {
  CreatePushSessionRequestSchema,
  DeltaQuerySchema,
  ExchangeObsidianCredentialRequestSchema,
  FinalizePushRequestSchema,
  PushBatchParamsSchema,
  SnapshotQuerySchema,
  SyncApiErrorResponseSchema,
} from "../../src/agentwiki/protocol";

describe("public route schemas", () => {
  it("rejects unknown request fields and non-canonical path/query numbers", () => {
    expect(() =>
      CreatePushSessionRequestSchema.parse({
        baseRevision: "r1",
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        capabilitiesHash: "a".repeat(64),
        confirmationHash: "b".repeat(64),
        confirmationByteLength: 1,
        changeCount: 0,
        totalBodyBytes: 0,
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      PushBatchParamsSchema.parse({
        spaceId: "s",
        sessionId: "11111111-1111-4111-8111-111111111111",
        batchIndex: "01",
      }),
    ).toThrow();
    expect(() =>
      SnapshotQuerySchema.parse({ revision: "current", limit: "0" }),
    ).toThrow();
    expect(() =>
      DeltaQuerySchema.parse({ from: "r1", limit: "201" }),
    ).toThrow();
  });
  it("validates secret-bearing and finalize requests strictly", () => {
    expect(() =>
      ExchangeObsidianCredentialRequestSchema.parse({
        code: "!",
        exchangeId: "bad",
      }),
    ).toThrow();
    expect(
      FinalizePushRequestSchema.parse({
        confirmationHash: "a".repeat(64),
        userConfirmed: true,
      }),
    ).toBeTruthy();
    expect(
      SyncApiErrorResponseSchema.parse({
        protocolVersion: "1",
        error: { code: "BASE_STALE", message: "stale", retryable: false },
      }).error.code,
    ).toBe("BASE_STALE");
  });
});
