import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/application/settings";
import { AgentWikiSyncSettingTab } from "../../src/obsidian/settings-tab";
import type { MockElement } from "../fakes/obsidian-mock";
import { makePlugin } from "../fakes/plugin-harness";

// Exercise addMapping through the real Vault adapter and persisted settings.
describe("mapping folder preparation", () => {
  it("creates a missing nested folder before persisting a usable mapping", async () => {
    const h = await makePlugin({ data: DEFAULT_SETTINGS });
    await h.plugin.onload();
    await h.plugin.addMapping("space", "知识库/项目");
    expect(h.adapter.folders.has("知识库")).toBe(true);
    expect(h.adapter.folders.has("知识库/项目")).toBe(true);
    expect(h.app.__pluginData).toMatchObject({
      mappings: [
        { spaceId: "space", rootPath: "知识库/项目", status: "pending" },
      ],
    });
  });

  it("reuses an existing folder without changing its notes", async () => {
    const h = await makePlugin({
      data: DEFAULT_SETTINGS,
      vaultFiles: { "Wiki/Note.md": "keep me" },
    });
    await h.plugin.onload();
    await h.plugin.addMapping("space", "Wiki");
    expect(h.businessWrites).toEqual([]);
    expect(h.adapter.files.get("Wiki/Note.md")).toBe("keep me");
    expect(h.app.__pluginData).toMatchObject({
      mappings: [{ rootPath: "Wiki" }],
    });
  });

  it.each(["Wiki", "Wiki/Subfolder"])(
    "rejects a file occupying %s without saving a mapping",
    async (root) => {
      const h = await makePlugin({
        data: DEFAULT_SETTINGS,
        vaultFiles: { Wiki: "keep me" },
      });
      await h.plugin.onload();
      await expect(h.plugin.addMapping("space", root)).rejects.toThrow(/文件/);
      expect(h.plugin.settings.mappings).toEqual([]);
      expect(h.app.__pluginData).toMatchObject({ mappings: [] });
      expect(h.businessWrites).toEqual([]);
      expect(h.adapter.files.get("Wiki")).toBe("keep me");
    },
  );

  it("does not save a mapping when folder creation fails", async () => {
    const h = await makePlugin({ data: DEFAULT_SETTINGS });
    await h.plugin.onload();
    vi.spyOn(h.app.vault, "createFolder").mockRejectedValue(
      new Error("Disk full"),
    );
    await expect(h.plugin.addMapping("space", "Wiki")).rejects.toThrow(
      "Disk full",
    );
    expect(h.plugin.settings.mappings).toEqual([]);
    expect(h.app.__pluginData).toMatchObject({ mappings: [] });
  });

  it("validates overlapping mappings before creating any folder", async () => {
    const h = await makePlugin({
      data: {
        ...DEFAULT_SETTINGS,
        mappings: [{ spaceId: "first", rootPath: "Wiki", status: "pending" }],
      },
    });
    await h.plugin.onload();
    await expect(
      h.plugin.addMapping("second", "Wiki/Subfolder"),
    ).rejects.toThrow(/重叠/);
    expect(h.businessWrites).toEqual([]);
    expect(h.plugin.settings.mappings).toHaveLength(1);
  });

  it("does not leave an in-memory mapping behind after settings persistence fails", async () => {
    const h = await makePlugin({ data: DEFAULT_SETTINGS });
    await h.plugin.onload();
    vi.spyOn(h.plugin, "saveData").mockRejectedValue(
      new Error("Cannot save settings"),
    );
    await expect(h.plugin.addMapping("space", "Wiki")).rejects.toThrow(
      "Cannot save settings",
    );
    expect(h.plugin.settings.mappings).toEqual([]);
    expect(h.app.__pluginData).toMatchObject({ mappings: [] });
  });
  it("prepares the folder through the settings Add action", async () => {
    const h = await makePlugin({ data: DEFAULT_SETTINGS });
    await h.plugin.onload();
    h.plugin.settings.serverInstanceId = "test-instance";
    vi.spyOn(h.plugin, "listAccessibleSpaces").mockResolvedValue([
      {
        spaceId: "space",
        displayName: "Test space",
        role: "owner",
        canPublish: true,
        canRead: true,
        currentRevision: "0",
        pageCount: "0",
        revisionManifestByteLength: "0",
        revisionBodyBytes: "0",
      },
    ]);
    const tab = new AgentWikiSyncSettingTab(h.app as never, h.plugin);
    tab.display();
    const ui = tab.containerEl as unknown as MockElement;
    await vi.waitFor(() =>
      expect(ui.queryAll((el) => el.tag === "select")).toHaveLength(1),
    );
    const select = ui.queryAll((el) => el.tag === "select")[0]!;
    select.value = "space";
    select.dispatchEvent({ type: "change" });
    const path = ui.queryAll(
      (el) => el.attributes.get("placeholder") === "Wiki",
    )[0]!;
    path.value = "New folder/Nested";
    path.dispatchEvent({ type: "change" });
    ui.queryAll(
      (el) => el.tag === "button" && el.text === "添加",
    )[0]!.dispatchEvent({ type: "click" });
    await vi.waitFor(() =>
      expect(h.plugin.settings.mappings).toEqual([
        { spaceId: "space", rootPath: "New folder/Nested", status: "pending" },
      ]),
    );
    expect(h.adapter.folders.has("New folder/Nested")).toBe(true);
    expect(ui.textContent).not.toContain("本地文件夹缺失");
  });
});
