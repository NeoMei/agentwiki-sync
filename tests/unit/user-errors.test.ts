import { describe, expect, it } from "vitest";
import { AgentWikiHttpError } from "../../src/agentwiki/client";
import { userErrorMessage } from "../../src/core/user-errors";

describe("userErrorMessage", () => {
  it("maps structured protocol errors to friendly Chinese", () => {
    const error = new AgentWikiHttpError(400, {
      error: { code: "INSTALLATION_CODE_EXPIRED", message: "raw" },
    });
    expect(userErrorMessage(error)).toContain("已过期");
    expect(userErrorMessage(error)).toContain("重新生成");
  });

  it("maps HTTP status codes when no protocol code exists", () => {
    const error = new AgentWikiHttpError(429, {});
    expect(userErrorMessage(error)).toContain("频繁");
  });

  it("maps local validation errors", () => {
    expect(
      userErrorMessage(
        new TypeError("Path contains an empty or relative segment"),
      ),
    ).toContain("路径");
    expect(userErrorMessage(new TypeError("映射根路径重叠"))).toContain("重叠");
  });

  it("does not expose browser authorization validation internals", () => {
    expect(
      userErrorMessage(new TypeError("Untrusted browser authorization URL")),
    ).toMatch(/授权链接.*服务器/u);
    expect(
      userErrorMessage(new TypeError("Invalid browser authorization response")),
    ).toMatch(/授权.*更新/u);
  });

  it("falls back to raw message for unknown errors", () => {
    expect(userErrorMessage(new Error("custom"))).toBe("custom");
  });

  it("explains how to repair a missing or non-directory mapping root", () => {
    expect(userErrorMessage(new Error("MAPPING_ROOT_MISSING"))).toMatch(
      /重新创建.*文件夹|更改.*映射/,
    );
    expect(userErrorMessage(new Error("MAPPING_ROOT_NOT_DIRECTORY"))).toMatch(
      /文件夹|更改.*映射/,
    );
  });

  it("maps bare protocol codes without a colon to Chinese", () => {
    expect(userErrorMessage(new Error("PATH_COLLISION"))).toContain("占用");
    expect(userErrorMessage(new Error("PATH_COLLISION"))).not.toBe(
      "PATH_COLLISION",
    );
    expect(userErrorMessage(new Error("BASE_STALE"))).toContain("拉取");
    expect(userErrorMessage(new Error("BASE_STALE"))).not.toBe("BASE_STALE");
    expect(userErrorMessage(new Error("PAGE_TOO_LARGE"))).toContain("大小");
  });

  it("keeps colon-prefixed codes and unknown fallback unchanged", () => {
    expect(
      userErrorMessage(new TypeError("FOLDER_CYCLE: 目录层级存在循环")),
    ).toContain("循环");
    expect(userErrorMessage(new Error("UNKNOWN_CODE"))).toBe("UNKNOWN_CODE");
  });

  it.each([
    ["ATTACHMENT_REFERENCE_INVALID", "修复.*引用"],
    ["ATTACHMENT_MISSING", "恢复.*文件"],
    ["ATTACHMENT_CONTENT_INVALID", "图片"],
    ["ATTACHMENT_NAME_CONFLICT", "重命名"],
    ["ATTACHMENT_REFERENCED", "引用"],
    ["ATTACHMENT_BLOB_MISSING", "重新.*Pull"],
    ["ATTACHMENT_QUOTA_EXCEEDED", "压缩.*图片"],
    ["SYNC_PROTOCOL_UPGRADE_REQUIRED", "升级.*服务端.*插件"],
  ])("maps v3 code %s to an actionable safe message", (code, action) => {
    const message = userErrorMessage(new Error(code));
    expect(message).toMatch(new RegExp(action));
    expect(message).not.toMatch(/file:\/\/|https?:\/\/|\/Users\//u);
  });

  it("does not expose absolute paths or Blob URLs from structured error details", () => {
    const error = new AgentWikiHttpError(409, {
      protocolVersion: "3",
      error: {
        code: "ATTACHMENT_MISSING",
        retryable: false,
        details: {
          path: "/Users/name/Vault/assets/private.png",
          blobUrl: "https://signed.example/private-token",
        },
      },
    });
    const message = userErrorMessage(error);
    expect(message).toContain("恢复");
    expect(message).not.toContain("/Users/");
    expect(message).not.toContain("https://");
  });

  it("explains that a published upgrade must resume local application without re-uploading", () => {
    const message = userErrorMessage(
      new Error("UPGRADE_REMOTE_PUBLISHED_LOCAL_PENDING"),
    );

    expect(message).toMatch(/服务器升级已完成.*本地应用尚未完成/u);
    expect(message).toContain("恢复已确认升级");
    expect(message).toMatch(/不要重新发起上传/u);
  });
});
