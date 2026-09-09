import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import manifest from "../../manifest.json";
import pkg from "../../package.json";
import lock from "../../package-lock.json";
import versions from "../../versions.json";

describe("release metadata", () => {
  it("is mobile compatible with the supported Obsidian floor", () => {
    expect(manifest.id).toBe("agentwiki-sync");
    expect(manifest.minAppVersion).toBe("1.11.5");
    expect(manifest.isDesktopOnly).toBe(false);
  });

  it("keeps package, lockfile, manifest, and release versions aligned", () => {
    expect(pkg.version).toBe("0.5.0");
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
    expect(versions["0.5.0"]).toBe("1.11.5");
  });

  it("uses Obsidian Setting headings in the settings tab", async () => {
    const source = await readFile("src/obsidian/settings-tab.ts", "utf8");
    expect(source).not.toMatch(/\.createEl\(["']h[1-6]["']/u);
  });

  it("keeps sync strategy guidance above a container-responsive action row", async () => {
    const source = await readFile("src/obsidian/sync-center-modal.ts", "utf8");
    const styles = await readFile("styles.css", "utf8");

    expect(source).toContain('cls: "agentwiki-sync-strategy-description"');
    expect(source).toContain('addClass("agentwiki-sync-strategy-setting")');
    expect(styles).toContain(
      ".agentwiki-sync-modal {\n  container-type: inline-size;",
    );
    expect(styles).toContain("@container (max-width: 440px)");
    expect(styles).not.toContain(".is-phone .agentwiki-sync-actions");
  });
});
