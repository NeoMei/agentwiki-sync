import { Notice, Plugin } from "obsidian";
import {
  DEFAULT_SETTINGS,
  migrateVaultSettings,
  parseSettings,
  toVaultSettings,
  type AgentWikiSyncSettings,
} from "./application/settings";
import { AgentWikiSyncSettingTab } from "./obsidian/settings-tab";
import {
  SyncCenterModal,
  type SyncDiff,
  type SyncStrategy,
} from "./obsidian/sync-center-modal";
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
import { AgentWikiClient, normalizeServerUrl } from "./agentwiki/client";
import { AgentWikiPushRemote } from "./agentwiki/push-remote";
import { SyncRuntime } from "./application/sync-runtime";
import {
  OperationLock,
  removeMapping,
  resolveMapping,
  validateMappings,
} from "./application/sync-coordinator";
import { VaultIdentityService } from "./storage/vault-identity";
import { idFileKey } from "./core/identity-key";
import { SessionResponseSchema } from "./agentwiki/protocol";
import { userErrorMessage } from "./core/user-errors";
import type { SyncSpaceSummary } from "./agentwiki/protocol";
import { MutableControlRepository } from "./storage/envelope";
import { DeviceStateRepository } from "./storage/device-state";
import { StorageMigration } from "./storage/migration";
import { preferLocalPull } from "./obsidian/preview-logic";
import type { SyncOperationOptions } from "./application/progress";

const actionLabel = (kind: string): string => {
  const labels: Record<string, string> = {
    write: "写入",
    create: "创建",
    rename: "重命名",
    trash: "删除",
    upsert: "更新",
    archive: "归档",
  };
  return labels[kind] || kind;
};

const roleLabel: Record<SyncSpaceSummary["role"], string> = {
  viewer: "只读",
  editor: "可编辑",
  admin: "管理员",
  owner: "所有者",
};

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
  private statusBarEl: HTMLElement | null = null;
  private settingsRepo(): MutableControlRepository<AgentWikiSyncSettings> {
    return new MutableControlRepository(
      new ObsidianLocalControlStore(this.app),
      "device-settings.json",
      isDeviceSettings,
    );
  }
  override async onload(): Promise<void> {
    const stored = await this.loadData();
    const needsLegacy =
      stored === null ||
      stored === undefined ||
      (typeof stored === "object" &&
        (stored as { schemaVersion?: unknown }).schemaVersion === 1);
    const legacy = needsLegacy ? await this.settingsRepo().read() : null;
    const vaultSettings = migrateVaultSettings(stored, legacy?.payload ?? null);
    this.settings = {
      schemaVersion: 1,
      serverUrl: vaultSettings.serverUrl,
      serverInstanceId: null,
      mappings: vaultSettings.mappings,
    };
    await this.saveData(vaultSettings);

    // Run storage migration to convert hash filenames to readable paths
    await this.runStorageMigration();
    const localStore = new ObsidianLocalControlStore(this.app);
    const connection = await new MutableControlRepository(
      localStore,
      "connection-state.json",
      isConnectionState,
    ).read();
    if (connection) {
      // The connected state is authoritative. A settings URL that differs
      // only by normalization (host case, default port) must self-heal;
      // throwing here would brick onload before any settings UI exists.
      this.settings.serverUrl = normalizeServerUrl(
        connection.payload.serverUrl,
      );
      this.settings.serverInstanceId = connection.payload.serverInstanceId;
      await new VaultIdentityService(
        new ObsidianControlStore(this.app.vault.adapter),
        localStore,
      ).bind(connection.payload.vaultId);
      await this.saveSettings();
    }
    this.addSettingTab(new AgentWikiSyncSettingTab(this.app, this));
    this.initStatusBar();
    this.addRibbonIcon("refresh-cw", "AgentWiki Sync", () =>
      this.openSyncCenter(),
    );
    this.addCommand({
      id: "open-sync-center",
      name: "打开同步中心",
      callback: () => this.openSyncCenter(),
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
            .catch((error) => new Notice(userErrorMessage(error)));
      }),
    );
  }
  private async runStorageMigration(): Promise<void> {
    try {
      const controlStore = new ObsidianControlStore(this.app.vault.adapter);
      const migration = new StorageMigration(controlStore);

      // Scan for device directories
      const deviceRoot = ".agentwiki/devices";
      if (!(await this.app.vault.adapter.exists(deviceRoot))) return;

      const deviceFiles = await this.app.vault.adapter.list(deviceRoot);
      for (const deviceDir of deviceFiles.folders) {
        const spacesRoot = `${deviceDir}/spaces`;
        if (!(await this.app.vault.adapter.exists(spacesRoot))) continue;

        const spaceFiles = await this.app.vault.adapter.list(spacesRoot);
        for (const spaceDir of spaceFiles.folders) {
          // Migrate generations
          const generationsDir = `${spaceDir}/generations`;
          if (await this.app.vault.adapter.exists(generationsDir)) {
            const genFiles = await this.app.vault.adapter.list(generationsDir);
            for (const genDir of genFiles.folders) {
              const genId = genDir.split("/").pop();
              if (genId) {
                await migration.migrateGeneration(spaceDir, genId);
              }
            }
          }

          // Migrate push payloads
          const pushDir = `${spaceDir}/push`;
          if (await this.app.vault.adapter.exists(pushDir)) {
            await migration.migratePushPayloads(pushDir);
          }
        }
      }
    } catch {
      // Migration failure should not block plugin startup
    }
  }

  async saveSettings(): Promise<void> {
    validateMappings(this.settings.mappings);
    await this.saveData(toVaultSettings(this.settings));
  }
  async setServerUrl(value: string): Promise<void> {
    if (
      this.settings.serverInstanceId !== null &&
      value !== this.settings.serverUrl
    )
      throw new Error("请先断开连接再更改 AgentWiki 服务器");
    this.settings.serverUrl = value;
    await this.saveSettings();
  }
  async connect(code: string): Promise<void> {
    if (this.settings.serverInstanceId !== null) {
      new Notice("请先断开当前设备连接，再连接新的凭据。");
      return;
    }
    if (!this.settings.serverUrl || !code) {
      new Notice("请先在设置中填写服务器地址和连接码。");
      return;
    }
    const local = new ObsidianLocalControlStore(this.app);
    const shared = new ObsidianControlStore(this.app.vault.adapter);
    const deviceState = new DeviceStateRepository(local);
    const deviceId = await deviceState.getOrCreateDeviceId();
    const identity = new VaultIdentityService(shared, local);
    const vaultId = await identity.getOrCreate();
    const serverUrl = normalizeServerUrl(this.settings.serverUrl);
    const result = await new ConnectionService(
      new RequestUrlHttp(),
      new ObsidianSecrets(this.app),
      local,
    ).connect({
      serverUrl,
      code,
      deviceId,
      deviceName: this.app.vault.getName(),
      vaultId,
      pluginVersion: this.manifest.version,
    });
    this.settings.serverUrl = serverUrl;
    this.settings.serverInstanceId = result.serverInstanceId;
    await identity.bind(vaultId);
    await this.saveSettings();
  }
  async listAccessibleSpaces(): Promise<SyncSpaceSummary[]> {
    const local = new ObsidianLocalControlStore(this.app);
    const state = await new MutableControlRepository(
      local,
      "connection-state.json",
      isConnectionState,
    ).read();
    const secretId = state?.payload.credentialSecretId ?? null;
    if (!secretId) throw new Error("未连接");
    const secrets = new ObsidianSecrets(this.app);
    const client = new AgentWikiClient(
      this.settings.serverUrl,
      new RequestUrlHttp(),
      () => secrets.get(secretId),
    );
    const response = await client.spaces();
    return response.spaces;
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
        if (!runtime) throw new Error("请先连接 AgentWiki 再移除活跃映射");
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
      let runtime: SyncRuntime | null = null;
      try {
        runtime = await this.runtime(mapping);
      } catch {
        // Offline or identity mismatch: local disconnect is the escape hatch.
        continue;
      }
      if (runtime && (await runtime.hasUnfinishedPush()))
        throw new Error(`Space ${mapping.spaceId} 有未完成的推送`);
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
      "已在本地断开连接。如服务器不可达，请在 AgentWiki 网页中撤销该设备。",
    );
  }
  private selectedMapping(requestedSpaceId?: string) {
    const activePath = this.app.workspace.getActiveFile()?.path ?? "";
    return resolveMapping(this.settings.mappings, activePath, requestedSpaceId);
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
    const deviceState = new DeviceStateRepository(local);
    const deviceId = (await deviceState.read())?.deviceId;
    if (!secretId || !deviceId) return null;
    const secrets = new ObsidianSecrets(this.app);
    const client = new AgentWikiClient(
      this.settings.serverUrl,
      new RequestUrlHttp(),
      () => secrets.get(secretId),
    );
    const state = connectionState?.payload ?? null;
    const boundVaultId = await deviceState.getBoundVaultId();
    if (
      !state ||
      state.serverUrl !== this.settings.serverUrl ||
      state.serverInstanceId !== this.settings.serverInstanceId ||
      state.deviceId !== deviceId ||
      state.vaultId !== boundVaultId
    )
      throw new Error("连接身份不匹配");
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
      throw new Error("认证会话身份不匹配");
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
      state.credentialId,
    );
    this.liveRuntimes.set(runtimeKey, runtime);
    return runtime;
  }
  // Status bar indicator
  private initStatusBar(): void {
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("agentwiki-sync-status");
    this.statusBarEl.setText("AgentWiki");
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.updateStatusBarLocally()),
    );
    this.registerDomEvent(this.statusBarEl, "click", () =>
      this.openSyncCenter(),
    );
    this.updateStatusBarLocally();
  }

  private updateStatusBarLocally(): void {
    if (!this.statusBarEl) return;
    const mapping = this.selectedMapping();
    this.statusBarEl.setText(
      mapping ? `AgentWiki: ${mapping.rootPath}` : "AgentWiki",
    );
  }
  private openSyncCenter(): void {
    const initial = this.selectedMapping();
    if (!initial) {
      new Notice("请先连接并在设置中添加空间映射。");
      return;
    }
    new SyncCenterModal(this.app, {
      targets: this.settings.mappings.map((mapping) => ({
        spaceId: mapping.spaceId,
        label: `${mapping.spaceId} · ${mapping.rootPath}`,
      })),
      initialSpaceId: initial.spaceId,
      loadDiff: (spaceId, options) => this.collectSyncDiff(spaceId, options),
      runStrategy: (spaceId, strategy, options) =>
        this.runSyncStrategy(spaceId, strategy, options),
    }).open();
  }

  private async collectSyncDiff(
    spaceId: string,
    options: SyncOperationOptions,
  ): Promise<SyncDiff> {
    const mapping = this.selectedMapping(spaceId);
    if (!mapping) throw new Error("请先连接并在设置中添加空间映射。");
    const runtime = await this.runtime(mapping);
    if (!runtime) throw new Error("请先连接并在设置中添加空间映射。");
    await runtime.recover();
    const [status, delta, spaces] = await Promise.all([
      runtime.status(options),
      runtime.remoteDelta(),
      this.listAccessibleSpaces(),
    ]);
    const space = spaces.find((item) => item.spaceId === mapping.spaceId);
    if (!space) throw new Error("当前凭据无权访问该空间。");
    return {
      canPublish: space.canPublish,
      displayName: space.displayName,
      rootPath: mapping.rootPath,
      roleLabel: roleLabel[space.role],
      remoteAhead: delta.ahead,
      localAdded: status.local.added.map((file) => file.relativePath),
      localModified: status.local.modified.map((file) => file.relativePath),
      localRenamed: status.local.renamed.map((file) => file.relativePath),
      localDeleted: status.local.deleted.map((page) => page.relativePath),
      remoteUpdated: delta.items
        .filter((item) => item.operation === "upsert")
        .map((item) => item.page.path),
      remoteArchived: delta.items
        .filter((item) => item.operation === "archive")
        .map((item) => item.previousPath),
      remoteListed: delta.listed,
      remoteFirstBind: delta.ahead && delta.baseRevision === "0",
    };
  }

  private async runSyncStrategy(
    spaceId: string,
    strategy: SyncStrategy,
    options: SyncOperationOptions,
  ): Promise<void> {
    const mapping = this.selectedMapping(spaceId);
    if (!mapping) throw new Error("请先连接并在设置中添加空间映射。");
    const flow = new SyncFlowLock(this.locks.acquire(mapping.spaceId));
    try {
      const runtime = await this.runtime(mapping);
      if (!runtime) throw new Error("请先连接并在设置中添加空间映射。");
      await runtime.recover();
      if (strategy === "server") {
        await this.syncUseServer(runtime, flow, options);
        return;
      }
      if (strategy === "local") {
        await this.syncUseLocal(runtime, flow, options);
        return;
      }
      await this.syncAutoMerge(runtime, flow, options);
    } catch (error) {
      flow.finish();
      throw error;
    }
  }

  private async syncUseServer(
    runtime: SyncRuntime,
    flow: SyncFlowLock,
    options: SyncOperationOptions,
  ): Promise<void> {
    const delta = await runtime.remoteDelta();
    if (!delta.ahead) {
      new Notice("服务器没有新的变更可应用。");
      flow.finish();
      return;
    }
    const preview = await runtime.previewPull(options);
    for (const conflict of preview.conflicts)
      preview.conflictResolutions[conflict.conflictId] = {
        choice: "remote",
      };
    for (const binding of preview.initialBindings)
      if (binding.resolution === null) binding.resolution = "remote";
    new PreviewModal(
      this.app,
      "以服务器内容为准",
      [
        ...preview.actions.map(
          (item) => `${actionLabel(item.kind)}: ${item.path}`,
        ),
        ...preview.conflicts.map(
          (item) => `冲突以服务器为准: ${item.field} ${item.pageId}`,
        ),
        ...preview.initialBindings.map(
          (item) => `新页面写入服务器内容: ${item.remotePath}`,
        ),
      ],
      async (applyOptions) => {
        await runtime.applyPull(preview, applyOptions);
        await this.saveSettings();
        new Notice("已按服务器内容更新本地。");
      },
      () => {
        void runtime.discardPullPreview(preview).finally(() => flow.finish());
      },
    ).open();
  }

  private async syncUseLocal(
    runtime: SyncRuntime,
    flow: SyncFlowLock,
    options: SyncOperationOptions,
  ): Promise<void> {
    const delta = await runtime.remoteDelta();
    if (!delta.ahead) {
      await this.openPushPreview(
        runtime,
        flow,
        "推送预览（以本地内容为准）",
        options,
      );
      return;
    }
    const preview = await runtime.previewPull(options);
    preferLocalPull(preview);
    new PreviewModal(
      this.app,
      "以本地内容为准 — 先合并服务器更新",
      [
        ...preview.actions.map(
          (item) => `${actionLabel(item.kind)}: ${item.path}`,
        ),
        ...preview.conflicts.map(
          (item) => `冲突以本地为准: ${item.field} ${item.pageId}`,
        ),
        ...preview.initialBindings.map(
          (item) =>
            `${item.localPath ? "保留本地" : "写入远端"}: ${item.remotePath}`,
        ),
      ],
      async (applyOptions) => {
        await runtime.applyPull(preview, applyOptions);
        await this.saveSettings();
        flow.advance();
        await this.openPushPreview(
          runtime,
          flow,
          "推送预览（以本地内容为准）",
          applyOptions,
        );
      },
      () => {
        void runtime
          .discardPullPreview(preview)
          .finally(() => flow.phaseRelease()());
      },
      preview.initialBindings,
      preview,
    ).open();
  }

  private async syncAutoMerge(
    runtime: SyncRuntime,
    flow: SyncFlowLock,
    options: SyncOperationOptions,
  ): Promise<void> {
    const delta = await runtime.remoteDelta();
    if (!delta.ahead) {
      await this.openPushPreview(runtime, flow, "推送预览", options);
      return;
    }
    const preview = await runtime.previewPull(options);
    const needsResolution =
      preview.conflicts.some(
        (item) => !preview.conflictResolutions[item.conflictId],
      ) || preview.initialBindings.some((item) => item.resolution === null);
    new PreviewModal(
      this.app,
      needsResolution ? "自动合并 — 处理冲突与绑定" : "自动合并 — 拉取预览",
      [
        ...preview.actions.map(
          (item) => `${actionLabel(item.kind)}: ${item.path}`,
        ),
        ...preview.initialBindings
          .filter((item) => item.resolution === null)
          .map((item) => `远端新页面待绑定: ${item.remotePath}`),
        ...preview.conflicts.map(
          (item) => `冲突待处理: ${item.field} ${item.pageId}`,
        ),
      ],
      async (applyOptions) => {
        await runtime.applyPull(preview, applyOptions);
        await this.saveSettings();
        flow.advance();
        await this.openPushPreview(
          runtime,
          flow,
          "自动合并 — 推送本地变更",
          applyOptions,
        );
      },
      () => {
        void runtime
          .discardPullPreview(preview)
          .finally(() => flow.phaseRelease()());
      },
      preview.initialBindings,
      preview,
    ).open();
  }

  private async openPushPreview(
    runtime: SyncRuntime,
    flow: SyncFlowLock,
    title: string,
    options?: SyncOperationOptions,
  ): Promise<void> {
    try {
      const preview = await runtime.previewPush(options);
      if (!preview.changes.length) {
        new Notice("本地没有待推送的变更。");
        flow.finish();
        return;
      }
      new PreviewModal(
        this.app,
        title,
        preview.changes.map(
          (item) =>
            `${actionLabel(item.operation)}: ${item.operation === "upsert" ? item.path : item.previousPath}`,
        ),
        async (applyOptions) => {
          await runtime.applyPush(preview, applyOptions);
          await this.saveSettings();
          new Notice("推送完成。");
        },
        () => {
          void runtime.discardPushPreview(preview).finally(() => flow.finish());
        },
      ).open();
    } catch (error) {
      new Notice(userErrorMessage(error));
      flow.finish();
    }
  }
}

class SyncFlowLock {
  private release: (() => void) | null;
  private advanced = false;
  constructor(release: () => void) {
    this.release = release;
  }
  advance(): void {
    this.advanced = true;
  }
  phaseRelease(): () => void {
    return () => {
      if (!this.advanced) this.finish();
    };
  }
  finish(): void {
    if (this.release) {
      this.release();
      this.release = null;
    }
  }
}
