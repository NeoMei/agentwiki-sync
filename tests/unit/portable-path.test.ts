import { describe, expect, it } from "vitest";
import {
  portablePathKey,
  titleFromPath,
  validatePortablePath,
} from "../../src/core/portable-path";

describe("portable paths", () => {
  it("normalizes NFC and uses Unicode full case folding", () => {
    expect(portablePathKey("Straße/İ.MD")).toBe("strasse/i\u0307.md");
    expect(validatePortablePath("Notes/e\u0301.md").path).toBe("Notes/é.md");
  });

  it.each([
    "/a.md",
    "a//b.md",
    "../a.md",
    "CON.md",
    "COM¹.txt.md",
    "a.md ",
    "a.txt",
    "a\\b.md",
  ])("rejects %s", (path) => {
    expect(() => validatePortablePath(path)).toThrow();
  });

  it("derives titles from the final file stem", () => {
    expect(titleFromPath("Guides/Setup.MD")).toBe("Setup");
  });
});
