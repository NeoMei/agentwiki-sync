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
});
