import { describe, expect, it } from "vitest";
import {
  assertBlobLimits,
  BlobLimitError,
  RecoveryDiagnosticError,
  recoveryDiagnostic,
  exportDiagnostic,
} from "../../src/core/sync-diagnostics";
import { userErrorMessage } from "../../src/core/user-errors";
const caps = {
  maxAttachmentBytes: 100,
  maxBlobChunks: 10,
  blobChunkBytes: 10,
  maxImageDimension: 100,
  maxDecodedPixels: 5000,
  maxRevisionAttachments: 2,
  maxTransferBlobBytes: 150,
};
const blob = { sizeBytes: "50", width: 10, height: 10 };
describe("safe sync diagnostics", () => {
  it.each([
    [{ ...blob, sizeBytes: "101" }, "attachmentBytes", 101, 100],
    [{ ...blob, width: 101 }, "imageDimension", 101, 100],
    [{ ...blob, width: 80, height: 80 }, "decodedPixels", 6400, 5000],
  ])("identifies a limit and real path", (value, kind, actual, limit) => {
    try {
      assertBlobLimits(value, caps, "assets/a.png");
      throw new Error("expected limit");
    } catch (error) {
      expect(error).toBeInstanceOf(BlobLimitError);
      expect(error).toMatchObject({
        message: "BLOB_LIMIT_EXCEEDED",
        detail: { kind, actual, limit, path: "assets/a.png" },
      });
      expect(userErrorMessage(error)).toContain("assets/a.png");
      expect(userErrorMessage(error)).toContain(String(actual));
    }
  });
  it("checks chunk limit without changing byte limit", () => {
    expect(() => assertBlobLimits(blob, { ...caps, maxBlobChunks: 4 })).toThrow(
      BlobLimitError,
    );
    expect(() => assertBlobLimits(blob, caps)).not.toThrow();
  });
  it("maps the bare code without inventing details", () => {
    expect(userErrorMessage(new Error("BLOB_LIMIT_EXCEEDED"))).toContain(
      "未提供",
    );
  });
  it("exports a whitelist even when callers provide secrets", async () => {
    const error = new RecoveryDiagnosticError("推送会话无法恢复", {
      spaceId: "s1",
      sessionId: "ss1",
      remoteStatus: "expired",
      localPhase: "not_started",
      token: "SECRET",
      body: "PRIVATE",
    } as never);
    const diagnostic = recoveryDiagnostic(error, "s1");
    const writes: string[] = [];
    await exportDiagnostic(diagnostic, async (json) => {
      writes.push(json);
    });
    expect(writes[0]).toContain("ss1");
    expect(writes[0]).not.toMatch(/SECRET|PRIVATE|token|body/);
    expect(diagnostic.remoteCommit).toContain("未确认");
  });
  it("does not infer publication from a locally recorded phase", () => {
    const diagnostic = recoveryDiagnostic(new Error("timeout"), "s1");
    expect(diagnostic.remoteCommit).toContain("未确认");
    expect(diagnostic.localPhase).toBe("unknown");
  });
  it("does not mutate diagnostic or suppress export failures", async () => {
    const diagnostic = recoveryDiagnostic(new Error("identity mismatch"), "s1");
    const before = JSON.stringify(diagnostic);
    await expect(
      exportDiagnostic(diagnostic, async () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    expect(JSON.stringify(diagnostic)).toBe(before);
  });
});

it("shows proven publication with the retained local completion boundary", () => {
  const diagnostic = recoveryDiagnostic(
    new RecoveryDiagnosticError("local write failed", {
      publishedRevision: "rev-2",
      localPhase: "not_started",
      sessionId: "s",
    }),
    "space",
  );
  expect(diagnostic.remoteCommit).toBe("已确认远端发布");
  expect(diagnostic.publishedRevision).toBe("rev-2");
  expect(diagnostic.localPhase).toBe("not_started");
});
it("retains the friendly HTTP error classification through recovery context", async () => {
  const { AgentWikiHttpError } = await import("../../src/agentwiki/client");
  const original = new AgentWikiHttpError(403, {
    error: { code: "SPACE_FORBIDDEN" },
  });
  expect(
    userErrorMessage(
      new RecoveryDiagnosticError(original.message, {}, original),
    ),
  ).toBe(userErrorMessage(original));
});

it("labels known recovery states in Chinese and hides unknown state text", async () => {
  const { recoveryStateLabel } =
    await import("../../src/core/sync-diagnostics");
  expect(recoveryStateLabel("expired")).toBe("已过期");
  expect(recoveryStateLabel("not_started")).toBe("尚未确认完成");
  expect(recoveryStateLabel("published")).toBe("已发布");
  expect(recoveryStateLabel("untrusted arbitrary server text")).toBe("未知");
});
