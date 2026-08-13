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
import { removeMapping, selectMappingForPath, validateMappings } from "./application/sync-coordinator";
import { VaultIdentityService } from "./storage/vault-identity";
import { idFileKey } from "./core/identity-key";
import { OperationLock } from "./application/sync-coordinator";

export default class AgentWikiSyncPlugin extends Plugin {
  settings: AgentWikiSyncSettings = DEFAULT_SETTINGS;
  private readonly locks = new OperationLock();
  private readonly liveRuntimes=new Set<SyncRuntime>();
  override async onload(): Promise<void> {
    this.settings = parseSettings(await this.loadData());
    this.addSettingTab(new AgentWikiSyncSettingTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "AgentWiki Sync", () => this.openSync("status"));
    for (const action of ["status", "pull", "push"] as const) this.addCommand({ id: action, name: action.charAt(0).toUpperCase() + action.slice(1), callback: () => this.openSync(action) });
    const invalidate=()=>{for(const runtime of this.liveRuntimes)runtime.invalidate();};this.registerEvent(this.app.vault.on("create",invalidate));this.registerEvent(this.app.vault.on("modify",invalidate));this.registerEvent(this.app.vault.on("delete",invalidate));this.registerEvent(this.app.vault.on("rename",(file,oldPath)=>{invalidate();for(const runtime of this.liveRuntimes)void runtime.recordRename(oldPath,file.path).catch(()=>undefined);}));
  }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
  async connect(code: string): Promise<void> {
    if (!this.settings.serverUrl || !code) { new Notice("Enter the AgentWiki server and connection code."); return; }
    const local = new ObsidianLocalControlStore(this.app); const shared = new ObsidianControlStore(this.app.vault.adapter); let deviceId = await local.read("device-id"); const identity = new VaultIdentityService(shared, local); const vaultId = await identity.getOrCreate();
    if (!deviceId) { deviceId = crypto.randomUUID(); await local.write("device-id", deviceId); }
    try {
      const result = await new ConnectionService(new RequestUrlHttp(), new ObsidianSecrets(this.app), local).connect({ serverUrl: this.settings.serverUrl, code, deviceId, deviceName: this.app.vault.getName(), vaultId, pluginVersion: this.manifest.version });
      this.settings.serverInstanceId = result.serverInstanceId; await local.write("credential-secret-id", result.credentialSecretId); await identity.bind(vaultId); await this.saveSettings(); new Notice("AgentWiki device connected.");
    } catch (error) { new Notice(`Connection failed: ${error instanceof Error ? error.message : "unknown error"}`); }
  }
  async addMapping(spaceId: string, rootPath: string): Promise<void> { const next = [...this.settings.mappings, { spaceId, rootPath, status: "pending" as const }]; validateMappings(next); this.settings.mappings = next; await this.saveSettings(); }
  async removeMapping(spaceId:string):Promise<void>{const mapping=this.settings.mappings.find(item=>item.spaceId===spaceId);if(!mapping)return;let gate={activeTransaction:false,localClean:true,remoteAtBase:true};if(mapping.status==="active"){const release=this.locks.acquire(spaceId);try{const runtime=await this.runtime(mapping);if(!runtime)throw new Error("Connect AgentWiki before removing an active mapping");await runtime.recover();const status=await runtime.status();gate={activeTransaction:false,localClean:status.local.added.length+status.local.modified.length+status.local.renamed.length+status.local.deleted.length>0?false:true,remoteAtBase:status.remoteRevision===status.baseRevision};}finally{release();}}this.settings.mappings=removeMapping(this.settings.mappings,spaceId,gate);await this.saveSettings();}
  async disconnect():Promise<void>{const local=new ObsidianLocalControlStore(this.app);const secretId=await local.read("credential-secret-id");if(secretId)new ObsidianSecrets(this.app).set(secretId,"");await local.remove("credential-secret-id");await local.remove("connection-state.json");this.settings.serverInstanceId=null;await this.saveSettings();new Notice("Device disconnected locally. Revoke it in AgentWiki Web if the server could not be reached.");}
  private selectedMapping() { const activePath=this.app.workspace.getActiveFile()?.path??"";return selectMappingForPath(this.settings.mappings,activePath)??this.settings.mappings[0]??null; }
  private async runtime(mapping: NonNullable<ReturnType<AgentWikiSyncPlugin["selectedMapping"]>>): Promise<SyncRuntime | null> {
    const local = new ObsidianLocalControlStore(this.app); await new VaultIdentityService(new ObsidianControlStore(this.app.vault.adapter), local).assertBound(); const secretId = await local.read("credential-secret-id"); const deviceId=await local.read("device-id"); if (!secretId||!deviceId) return null;
    const secrets = new ObsidianSecrets(this.app); const client = new AgentWikiClient(this.settings.serverUrl, new RequestUrlHttp(), () => secrets.get(secretId));
    const runtime=new SyncRuntime(new ObsidianVaultPort(this.app.vault, this.app.fileManager, mapping.rootPath), new ObsidianControlStore(this.app.vault.adapter), new AgentWikiPushRemote(client, mapping.spaceId), mapping,undefined,await idFileKey(deviceId),await idFileKey(mapping.spaceId));this.liveRuntimes.add(runtime);return runtime;
  }
  private openSync(action: SyncAction): void { new SyncModal(this.app, action, async () => {
    const mapping=this.selectedMapping();if(!mapping){new Notice("Connect AgentWiki and add a Space mapping first.");return;}let release:(()=>void)|null=null;try { release=this.locks.acquire(mapping.spaceId);const runtime = await this.runtime(mapping); if (!runtime) { new Notice("Connect AgentWiki and add a Space mapping first."); return; }await runtime.recover();
      if (action === "status") { const status = await runtime.status(); new Notice(`Local +${status.local.added.length} ~${status.local.modified.length} ↔${status.local.renamed.length} -${status.local.deleted.length}; remote ${status.remoteRevision === status.baseRevision ? "clean" : "ahead"}.`); return; }
      if (action === "pull") { const preview = await runtime.previewPull();const modalRelease=release;new PreviewModal(this.app, "Pull preview", [...preview.actions.map((item) => `${item.kind}: ${item.path}`),...preview.initialBindings.map(item=>`bind: ${item.localPath??"new file"} ↔ ${item.remotePath}`),...preview.conflicts.map(item=>`conflict: ${item.field} ${item.pageId}`)], async () => { await runtime.applyPull(preview); await this.saveSettings(); new Notice("Pull complete."); },()=>modalRelease?.(),preview.initialBindings,preview).open(); release=null;return; }
      const preview = await runtime.previewPush();const modalRelease=release;new PreviewModal(this.app, "Push preview", preview.changes.map((item) => `${item.operation}: ${item.operation === "upsert" ? item.path : item.previousPath}`), async () => { await runtime.applyPush(preview); await this.saveSettings(); new Notice("Push complete."); },()=>modalRelease?.()).open();release=null;
    } catch (error) { new Notice(`${action} failed: ${error instanceof Error ? error.message : "unknown error"}`); } finally { release?.(); }
  }).open(); }
}
