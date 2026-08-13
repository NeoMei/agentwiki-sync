import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, parseSettings, type AgentWikiSyncSettings } from "./application/settings";
import { AgentWikiSyncSettingTab } from "./obsidian/settings-tab";
import { SyncModal, type SyncAction } from "./obsidian/sync-modal";

export default class AgentWikiSyncPlugin extends Plugin {
  settings: AgentWikiSyncSettings = DEFAULT_SETTINGS;
  override async onload(): Promise<void> {
    this.settings = parseSettings(await this.loadData());
    this.addSettingTab(new AgentWikiSyncSettingTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "AgentWiki Sync", () => this.openSync("status"));
    for (const action of ["status", "pull", "push"] as const) this.addCommand({ id: action, name: action.charAt(0).toUpperCase() + action.slice(1), callback: () => this.openSync(action) });
  }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
  showConnectionNotice(): void { new Notice("AgentWiki public sync API is not available on this server yet. Your code has not been sent."); }
  private openSync(action: SyncAction): void { new SyncModal(this.app, action, async () => { new Notice(`${action} requires an active AgentWiki mapping.`); }).open(); }
}
