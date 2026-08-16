import { describe, expect, it } from "vitest";
import manifest from "../../manifest.json";

describe("release metadata", () => {
  it("is mobile compatible with the supported Obsidian floor", () => {
    expect(manifest.id).toBe("agentwiki-sync");
    expect(manifest.minAppVersion).toBe("1.11.5");
    expect(manifest.isDesktopOnly).toBe(false);
  });
});
