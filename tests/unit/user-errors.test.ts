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
});
