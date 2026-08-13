import { Notice, Plugin } from "obsidian";
import {
  DEFAULT_SETTINGS,
  parseSettings,
  type AgentWikiSyncSettings,
} from "./application/settings";
import { AgentWikiSyncSettingTab } from "./obsidian/settings-tab";
import { SyncModal, type SyncAction } from "./obsidian/sync-modal";
import { PreviewModal } from "./obsidian/preview-modal";
import {
  ConnectionService,
  isConnectionState,
} from "./application/connection-service";
import {
  ObsidianControlStore,
  ObsidianLocalControlStore,
  ObsidianSecrets,
  ObsidianVaultPort,
  RequestUrlHttp,
} from "./obsidian/adapters";
import { AgentWikiClient } from "./agentwiki/client";
import { AgentWikiPushRemote } from "./agentwiki/push-remote";
import { SyncRuntime } from "./application/sync-runtime";
import {
  removeMapping,
  selectMappingForPath,
  validateMappings,
} from "./application/sync-coordinator";
import { VaultIdentityService } from "./storage/vault-identity";
import { idFileKey } from "./core/identity-key";
import { OperationLock } from "./application/sync-coordinator";
import { SessionResponseSchema } from "./agentwiki/protocol";
import { MutableControlRepository } from "./storage/envelope";

const isDeviceSettings = (value: unknown): value is AgentWikiSyncSettings => {
  try {
    return (
      parseSettings(value).schemaVersion === 1 &&
      !!value &&
      typeof value === "object" &&
      (value as { schemaVersion?: unknown }).schemaVersion === 1
    );
  } catch {
    return false;
  }
};

export default class AgentWikiSyncPlugin extends Plugin {
  settings: AgentWikiSyncSettings = DEFAULT_SETTINGS;
  private readonly locks = new OperationLock();
  private readonly liveRuntimes = new Map<string, SyncRuntime>();
  private settingsRepo(): MutableControlRepository<AgentWikiSyncSettings> {
    return new MutableControlRepository(
      new ObsidianLocalControlStore(this.app),
      "device-settings.json",
      isDeviceSettings,
    );
  }
  override async onload(): Promise<void> {
    const local = await this.settingsRepo().read();
    if (local) this.settings = local.payload;
    else {
      this.settings = parseSettings(await this.loadData());
      await this.settingsRepo().write(this.settings);
      await this.saveData(DEFAULT_SETTINGS);
    }
    const localStore = new ObsidianLocalControlStore(this.app);
    const connection = await new MutableControlRepository(
      localStore,
      "connection-state.json",
      isConnectionState,
    ).read();
    if (connection) {
      if (
        this.settings.serverUrl &&
        this.settings.serverUrl !== connection.payload.serverUrl
      )
        throw new Error("Connection and device settings server mismatch");
      this.settings.serverUrl = connection.payload.serverUrl;
      this.settings.serverInstanceId = connection.payload.serverInstanceId;
      await new VaultIdentityService(
        new ObsidianControlStore(this.app.vault.adapter),
        localStore,
      ).bind(connection.payload.vaultId);
      await this.saveSettings();
    }
    this.addSettingTab(new AgentWikiSyncSettingTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "AgentWiki Sync", () =>
      this.openSync("status"),
    );
    for (const action of ["status", "pull", "push"] as const)
      this.addCommand({
        id: action,
        name: action.charAt(0).toUpperCase() + action.slice(1),
        callback: () => this.openSync(action),
      });
    const invalidate = () => {
      for (const runtime of this.liveRuntimes.values()) runtime.invalidate();
    };
    this.registerEvent(this.app.vault.on("create", invalidate));
    this.registerEvent(this.app.vault.on("modify", invalidate));
    this.registerEvent(this.app.vault.on("delete", invalidate));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        invalidate();
        for (const runtime of this.liveRuntimes.values())
          void runtime
            .recordRename(oldPath, file.path)
            .catch(
              (error) =>
                new Notice(
                  `AgentWiki rename tracking failed: ${error instanceof Error ? error.message : "unknown error"}`,
                ),
            );
      }),
    );
  }
  async saveSettings(): Promise<void> {
    validateMappings(this.settings.mappings);
    await this.settingsRepo().write(this.settings);
  }
  async setServerUrl(value: string): Promise<void> {
    if (
      this.settings.serverInstanceId !== null &&
      value !== this.settings.serverUrl
    )
      throw new Error("Disconnect before changing the AgentWiki server");
    this.settings.serverUrl = value;
    await this.saveSettings();
  }
  async connect(code: string): Promise<void> {
    if (this.settings.serverInstanceId !== null) {
      new Notice(
        "Disconnect this device before connecting a different credential.",
      );
      return;
    }
    if (!this.settings.serverUrl || !code) {
      new Notice("Enter the AgentWiki server and connection code.");
      return;
    }
    const local = new ObsidianLocalControlStore(this.app);
    const shared = new ObsidianControlStore(this.app.vault.adapter);
    let deviceId = await local.read("device-id");
    const identity = new VaultIdentityService(shared, local);
    const vaultId = await identity.getOrCreate();
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      await local.write("device-id", deviceId);
    }
    try {
      const result = await new ConnectionService(
        new RequestUrlHttp(),
        new ObsidianSecrets(this.app),
        local,
      ).connect({
        serverUrl: this.settings.serverUrl,
        code,
        deviceId,
        deviceName: this.app.vault.getName(),
        vaultId,
        pluginVersion: this.manifest.version,
      });
      this.settings.serverInstanceId = result.serverInstanceId;
      await identity.bind(vaultId);
      await this.saveSettings();
      new Notice("AgentWiki device connected.");
    } catch (error) {
      new Notice(
        `Connection failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
  async addMapping(spaceId: string, rootPath: string): Promise<void> {
    const next = [
      ...this.settings.mappings,
      { spaceId, rootPath, status: "pending" as const },
    ];
    validateMappings(next);
    this.settings.mappings = next;
    await this.saveSettings();
  }
  async removeMapping(spaceId: string): Promise<void> {
    const mapping = this.settings.mappings.find(
      (item) => item.spaceId === spaceId,
    );
    if (!mapping) return;
    let gate = {
      activeTransaction: false,
      localClean: true,
      remoteAtBase: true,
    };
    if (mapping.status === "active") {
      const release = this.locks.acquire(spaceId);
      try {
        const runtime = await this.runtime(mapping);
        if (!runtime)
          throw new Error(
            "Connect AgentWiki before removing an active mapping",
          );
        await runtime.recover();
        const status = await runtime.status();
        gate = {
          activeTransaction: false,
          localClean:
            status.local.added.length +
              status.local.modified.length +
              status.local.renamed.length +
              status.local.deleted.length >
            0
              ? false
              : true,
          remoteAtBase: status.remoteRevision === status.baseRevision,
        };
      } finally {
        release();
      }
    }
    this.settings.mappings = removeMapping(
      this.settings.mappings,
      spaceId,
      gate,
    );
    for (const [key, runtime] of this.liveRuntimes)
      if (runtime.spaceId === spaceId) this.liveRuntimes.delete(key);
    await this.saveSettings();
  }
  async disconnect(): Promise<void> {
    for (const mapping of this.settings.mappings) {
      const runtime = await this.runtime(mapping);
      if (runtime && (await runtime.hasUnfinishedPush()))
        throw new Error(`Space ${mapping.spaceId} has an unfinished Push`);
    }
    const local = new ObsidianLocalControlStore(this.app);
    const state = await new MutableControlRepository(
      local,
      "connection-state.json",
      isConnectionState,
    ).read();
    const secretId = state?.payload.credentialSecretId ?? null;
    if (secretId) new ObsidianSecrets(this.app).set(secretId, "");
    await new MutableControlRepository(
      local,
      "connection-state.json",
      isConnectionState,
    ).clear();
    this.settings.serverInstanceId = null;
    this.liveRuntimes.clear();
    await this.saveSettings();
    new Notice(
      "Device disconnected locally. Revoke it in AgentWiki Web if the server could not be reached.",
    );
  }
  private selectedMapping() {
    const activePath = this.app.workspace.getActiveFile()?.path ?? "";
    return (
      selectMappingForPath(this.settings.mappings, activePath) ??
      this.settings.mappings[0] ??
      null
    );
  }
  private async runtime(
    mapping: NonNullable<ReturnType<AgentWikiSyncPlugin["selectedMapping"]>>,
  ): Promise<SyncRuntime | null> {
    const runtimeKey = `${this.settings.serverInstanceId ?? "pending"}\0${mapping.spaceId}\0${mapping.rootPath}`;
    const existing = this.liveRuntimes.get(runtimeKey);
    if (existing) return existing;
    const local = new ObsidianLocalControlStore(this.app);
    await new VaultIdentityService(
      new ObsidianControlStore(this.app.vault.adapter),
      local,
    ).assertBound();
    const connectionState = await new MutableControlRepository(
      local,
      "connection-state.json",
      isConnectionState,
    ).read();
    const secretId = connectionState?.payload.credentialSecretId ?? null;
    const deviceId = await local.read("device-id");
    if (!secretId || !deviceId) return null;
    const secrets = new ObsidianSecrets(this.app);
    const client = new AgentWikiClient(
      this.settings.serverUrl,
      new RequestUrlHttp(),
      () => secrets.get(secretId),
    );
    const state = connectionState?.payload ?? null;
    const boundVaultId = await local.read("bound-vault-id");
    if (
      !state ||
      state.serverUrl !== this.settings.serverUrl ||
      state.serverInstanceId !== this.settings.serverInstanceId ||
      state.deviceId !== deviceId ||
      state.vaultId !== boundVaultId
    )
      throw new Error("Connection identity mismatch");
    const session = SessionResponseSchema.parse(
      (await client.raw("GET", "/api/integrations/obsidian/session")).json,
    );
    if (
      session.serverInstanceId !== state.serverInstanceId ||
      session.credentialId !== state.credentialId ||
      session.deviceId !== state.deviceId ||
      session.vaultId !== state.vaultId ||
      session.credentialStatus !== "active"
    )
      throw new Error("Authenticated session identity mismatch");
    const runtime = new SyncRuntime(
      new ObsidianVaultPort(
        this.app.vault,
        this.app.fileManager,
        mapping.rootPath,
      ),
      new ObsidianControlStore(this.app.vault.adapter),
      new AgentWikiPushRemote(client, mapping.spaceId),
      mapping,
      undefined,
      await idFileKey(deviceId),
      await idFileKey(mapping.spaceId),
    );
    this.liveRuntimes.set(runtimeKey, runtime);
    return runtime;
  }
  private openSync(action: SyncAction): void {
    new SyncModal(this.app, action, async () => {
      const mapping = this.selectedMapping();
      if (!mapping) {
        new Notice("Connect AgentWiki and add a Space mapping first.");
        return;
      }
      let release: (() => void) | null = null;
      try {
        release = this.locks.acquire(mapping.spaceId);
        const runtime = await this.runtime(mapping);
        if (!runtime) {
          new Notice("Connect AgentWiki and add a Space mapping first.");
          return;
        }
        await runtime.recover();
        if (action === "status") {
          const status = await runtime.status();
          new Notice(
            `Local +${status.local.added.length} ~${status.local.modified.length} ↔${status.local.renamed.length} -${status.local.deleted.length}; remote ${status.remoteRevision === status.baseRevision ? "clean" : "ahead"}.`,
          );
          return;
        }
        if (action === "pull") {
          const preview = await runtime.previewPull();
          const modalRelease = release;
          new PreviewModal(
            this.app,
            "Pull preview",
            [
              ...preview.actions.map((item) => `${item.kind}: ${item.path}`),
              ...preview.initialBindings.map(
                (item) =>
                  `bind: ${item.localPath ?? "new file"} ↔ ${item.remotePath}`,
              ),
              ...preview.conflicts.map(
                (item) => `conflict: ${item.field} ${item.pageId}`,
              ),
            ],
            async () => {
              await runtime.applyPull(preview);
              await this.saveSettings();
              new Notice("Pull complete.");
            },
            () => {
              void runtime
                .discardPullPreview(preview)
                .finally(() => modalRelease?.());
            },
            preview.initialBindings,
            preview,
          ).open();
          release = null;
          return;
        }
        const preview = await runtime.previewPush();
        const modalRelease = release;
        new PreviewModal(
          this.app,
          "Push preview",
          preview.changes.map(
            (item) =>
              `${item.operation}: ${item.operation === "upsert" ? item.path : item.previousPath}`,
          ),
          async () => {
            await runtime.applyPush(preview);
            await this.saveSettings();
            new Notice("Push complete.");
          },
          () => {
            void runtime.discardPushPreview().finally(() => modalRelease?.());
          },
        ).open();
        release = null;
      } catch (error) {
        new Notice(
          `${action} failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      } finally {
        release?.();
      }
    }).open();
  }
}
