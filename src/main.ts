import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, parseSettings, type AgentWikiSyncSettings } from "./application/settings";
import { AgentWikiSyncSettingTab } from "./obsidian/settings-tab";
import { SyncModal, type SyncAction } from "./obsidian/sync-modal";
import { PreviewModal } from "./obsidian/preview-modal";
import { ConnectionService } from "./application/connection-service";
import { ObsidianControlStore, ObsidianLocalControlStore, ObsidianSecrets, ObsidianVaultPort, RequestUrlHttp } from "./obsidian/adapters";
import { AgentWikiClient } from "./agentwiki/client";
import { AgentWikiPushRemote } from "./agentwiki/push-remote";
import { SyncRuntime } from "./application/sync-runtime";
import { selectMappingForPath, validateMappings } from "./application/sync-coordinator";

export default class AgentWikiSyncPlugin extends Plugin {
  settings: AgentWikiSyncSettings = DEFAULT_SETTINGS;
  override async onload(): Promise<void> {
    this.settings = parseSettings(await this.loadData());
    this.addSettingTab(new AgentWikiSyncSettingTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "AgentWiki Sync", () => this.openSync("status"));
    for (const action of ["status", "pull", "push"] as const) this.addCommand({ id: action, name: action.charAt(0).toUpperCase() + action.slice(1), callback: () => this.openSync(action) });
  }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
  async connect(code: string): Promise<void> {
    if (!this.settings.serverUrl || !code) { new Notice("Enter the AgentWiki server and connection code."); return; }
    const local = new ObsidianLocalControlStore(this.app); let deviceId = await local.read("device-id"); let vaultId = await local.read("vault-id");
    if (!deviceId) { deviceId = crypto.randomUUID(); await local.write("device-id", deviceId); }
    if (!vaultId) { vaultId = crypto.randomUUID(); await local.write("vault-id", vaultId); }
    try {
      const result = await new ConnectionService(new RequestUrlHttp(), new ObsidianSecrets(this.app), local).connect({ serverUrl: this.settings.serverUrl, code, deviceId, deviceName: this.app.vault.getName(), vaultId, pluginVersion: this.manifest.version });
      this.settings.serverInstanceId = result.serverInstanceId; await local.write("credential-secret-id", result.credentialSecretId); await this.saveSettings(); new Notice("AgentWiki device connected.");
    } catch (error) { new Notice(`Connection failed: ${error instanceof Error ? error.message : "unknown error"}`); }
  }
  async addMapping(spaceId: string, rootPath: string): Promise<void> { const next = [...this.settings.mappings, { spaceId, rootPath, status: "pending" as const }]; validateMappings(next); this.settings.mappings = next; await this.saveSettings(); }
  private async runtime(): Promise<SyncRuntime | null> {
    const activePath = this.app.workspace.getActiveFile()?.path ?? ""; const mapping = selectMappingForPath(this.settings.mappings, activePath) ?? this.settings.mappings[0];
    if (!mapping) return null; const local = new ObsidianLocalControlStore(this.app); const secretId = await local.read("credential-secret-id"); if (!secretId) return null;
    const secrets = new ObsidianSecrets(this.app); const client = new AgentWikiClient(this.settings.serverUrl, new RequestUrlHttp(), () => secrets.get(secretId));
    return new SyncRuntime(new ObsidianVaultPort(this.app.vault, this.app.fileManager), new ObsidianControlStore(this.app.vault.adapter), new AgentWikiPushRemote(client, mapping.spaceId), mapping);
  }
  private openSync(action: SyncAction): void { new SyncModal(this.app, action, async () => {
    const runtime = await this.runtime(); if (!runtime) { new Notice("Connect AgentWiki and add a Space mapping first."); return; }
    try {
      if (action === "status") { const status = await runtime.status(); new Notice(`Local +${status.local.added.length} ~${status.local.modified.length} ↔${status.local.renamed.length} -${status.local.deleted.length}; remote ${status.remoteRevision === status.baseRevision ? "clean" : "ahead"}.`); return; }
      if (action === "pull") { const preview = await runtime.previewPull(); new PreviewModal(this.app, "Pull preview", preview.actions.map((item) => `${item.kind}: ${item.path}`), async () => { await runtime.applyPull(preview); await this.saveSettings(); new Notice("Pull complete."); }).open(); return; }
      const preview = await runtime.previewPush(); new PreviewModal(this.app, "Push preview", preview.changes.map((item) => `${item.operation}: ${item.operation === "upsert" ? item.path : item.previousPath}`), async () => { await runtime.applyPush(preview); await this.saveSettings(); new Notice("Push complete."); }).open();
    } catch (error) { new Notice(`${action} failed: ${error instanceof Error ? error.message : "unknown error"}`); }
  }).open(); }
}
