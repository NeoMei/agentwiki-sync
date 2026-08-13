import { PluginSettingTab, Setting, type App } from "obsidian";
import type AgentWikiSyncPlugin from "../main";

export class AgentWikiSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: AgentWikiSyncPlugin) { super(app, plugin); }
  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl).setName("AgentWiki server").setDesc("HTTPS AgentWiki origin. Connection stays inside this settings page.").addText((text) => text.setPlaceholder("https://wiki.example.com").setValue(this.plugin.settings.serverUrl).onChange(async (value) => { this.plugin.settings.serverUrl = value; await this.plugin.saveSettings(); }));
    new Setting(this.containerEl).setName("One-time connection code").setDesc("Create the code in AgentWiki, paste it here, then connect this human device.").addText((text) => text.setPlaceholder("Connection code")).addButton((button) => button.setButtonText("Connect").setCta().onClick(() => this.plugin.showConnectionNotice()));
    this.containerEl.createEl("h3", { text: "Space mappings" });
    if (this.plugin.settings.mappings.length === 0) this.containerEl.createEl("p", { text: "Connect first, then add a Space and a non-overlapping Vault folder." });
    for (const mapping of this.plugin.settings.mappings) new Setting(this.containerEl).setName(mapping.spaceId).setDesc(`${mapping.rootPath} · ${mapping.status}`);
  }
}
