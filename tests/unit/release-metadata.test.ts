import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import manifest from "../../manifest.json";
import pkg from "../../package.json";
import lock from "../../package-lock.json";

describe("release metadata", () => {
  it("is mobile compatible with the supported Obsidian floor", () => {
    expect(manifest.id).toBe("agentwiki-sync");
    expect(manifest.minAppVersion).toBe("1.11.5");
    expect(manifest.isDesktopOnly).toBe(false);
  });

  it("keeps package, lockfile, manifest, and release versions aligned", () => {
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
  });

  it("uses Obsidian Setting headings in the settings tab", async () => {
    const source = await readFile("src/obsidian/settings-tab.ts", "utf8");
    expect(source).not.toMatch(/\.createEl\(["']h[1-6]["']/u);
  });
});
