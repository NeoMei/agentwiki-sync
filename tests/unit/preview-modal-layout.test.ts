import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("preview modal layout", () => {
  it("stacks item information above container-responsive resolution controls", async () => {
    const source = await readFile("src/obsidian/preview-modal.ts", "utf8");
    const styles = await readFile("styles.css", "utf8");

    expect(source).toContain('addClass("agentwiki-sync-preview-setting")');
    expect(source).toContain('addClass("agentwiki-sync-binding-setting")');
    expect(source).toContain('addClass("agentwiki-sync-conflict-setting")');
    expect(source).toContain('addClass("agentwiki-sync-resolution-controls")');
    expect(source).toContain('addClass("agentwiki-sync-preview-actions")');

    expect(styles).toContain(
      ".agentwiki-sync-preview-setting {\n  align-items: stretch;\n  flex-direction: column;",
    );
    expect(styles).toContain(
      ".agentwiki-sync-resolution-controls {\n  display: grid;",
    );
    expect(styles).toContain(
      ".agentwiki-sync-binding-setting textarea {\n  grid-column: 1 / -1;",
    );
    expect(styles).toContain("@container (max-width: 700px)");
    expect(styles).toContain(
      ".agentwiki-sync-preview-actions {\n  position: sticky;\n  top: 0;",
    );
  });

  it("keeps confirmation disabled until every conflict and binding is resolved", async () => {
    const source = await readFile("src/obsidian/preview-modal.ts", "utf8");

    expect(source).toContain("pendingPreviewDecisionCount(");
    expect(source).toContain(
      "setDisabled(this.running || pendingDecisionCount() > 0)",
    );
    expect(source).toContain("项待处理，完成选择后才能执行");
  });
});
