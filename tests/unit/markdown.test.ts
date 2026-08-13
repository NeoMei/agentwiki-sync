import { describe, expect, it } from "vitest";
import {
  decodeVaultMarkdown,
  normalizeMarkdown,
} from "../../src/core/markdown";

describe("vault markdown", () => {
  it("strictly decodes UTF-8 and normalizes line endings", () => {
    expect(decodeVaultMarkdown(new TextEncoder().encode("a\r\nb\rc"))).toEqual({
      text: "a\r\nb\rc",
      normalized: "a\nb\nc",
    });
    expect(normalizeMarkdown("x\r\n")).toBe("x\n");
  });

  it("rejects BOM and invalid UTF-8", () => {
    expect(() =>
      decodeVaultMarkdown(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])),
    ).toThrow(/BOM/);
    expect(() => decodeVaultMarkdown(new Uint8Array([0xc3, 0x28]))).toThrow(
      /UTF-8/,
    );
  });
});
