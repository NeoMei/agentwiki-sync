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

  it("renders folder conflicts with local/server/manual resolutions and validates the manual path", async () => {
    const source = await readFile("src/obsidian/preview-modal.ts", "utf8");

    expect(source).toContain("folderConflicts");
    expect(source).toContain("folderConflictResolutions");
    expect(source).toContain("保留本地位置");
    expect(source).toContain("使用服务器位置");
    expect(source).toContain("手动输入最终路径");
    expect(source).toContain("folderConflictValidationError");
  });

  it("shows the protocol as read-only diagnostic text and never a selector", async () => {
    const source = await readFile("src/obsidian/sync-center-modal.ts", "utf8");

    expect(source).toContain("protocolLabel");
    expect(source).toContain("Sync v2");
    expect(source).toContain("Legacy v1");
    expect(source).not.toContain('setName("协议")');
  });

  it("sizes folder-conflict controls with relative units and wraps long paths", async () => {
    const styles = await readFile("styles.css", "utf8");

    expect(styles).toContain(".agentwiki-sync-folder-setting");
    expect(styles).toContain(
      "grid-template-columns: minmax(10rem, 1fr) minmax(16rem, 3fr);",
    );
    expect(styles).toContain(".agentwiki-sync-modal .setting-item-name");
  });
});
