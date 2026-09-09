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
import { V1TreeRemote } from "./agentwiki/v1-tree-remote";
import { V2TreeRemote } from "./agentwiki/v2-tree-remote";
import { V3TreeRemote } from "./agentwiki/v3-tree-remote";
import { AgentWikiPushRemote } from "./agentwiki/push-remote";
import { SyncRuntime } from "./application/sync-runtime";
import {
  ProtocolNegotiator,
  type SyncProtocolSelection,
} from "./application/protocol-negotiator";
import { ProtocolSelectionRepository } from "./storage/protocol-selection";
import {
  OperationLock,
  removeMapping,
  resolveMapping,
  validateMappings,
  type SpaceMapping,
} from "./application/sync-coordinator";
import { VaultIdentityService } from "./storage/vault-identity";
import { idFileKey } from "./core/identity-key";
import {
  SessionResponseSchema,
  type SyncCapabilities,
} from "./agentwiki/protocol";
import { userErrorMessage } from "./core/user-errors";
import type { SyncSpaceSummary } from "./agentwiki/protocol";
import type { TreeRemotePort } from "./ports/tree-remote";
import { MutableControlRepository } from "./storage/envelope";
import { DeviceStateRepository } from "./storage/device-state";
import { StorageMigration } from "./storage/migration";
import { TreeBaselineRepository } from "./storage/tree-baseline";
import {
  PushJournalRouter,
  readPushProtocolRequirement,
} from "./storage/push-journal-router";
import {
  ObsidianShortestImageIndex,
  ObsidianShortestImageResolver,
} from "./obsidian/shortest-image-resolver";
import {
  attachmentOperationLabel,
  preferLocalPull,
  protocolLabel,
} from "./obsidian/preview-logic";
import type { PullPreviewV3, PushPreviewV3 } from "./application/sync-runtime";
import type { SyncOperationOptions } from "./application/progress";
import type { ModalTransition } from "./obsidian/modal-handoff";
import {
  resolveAttachmentConflict,
  resolveFolderConflictV3,
  resolvePageConflictV3,
} from "./application/tree-diff";
import {
  LocalImageUpgradeEntry,
  type LocalImageUpgradeDraft,
  type LocalImageUpgradeTextSyncPreview,
} from "./application/local-image-upgrade-entry";
import {
  selectSpaceSyncRoute,
  type SpaceSyncRoute,
} from "./application/space-sync-route";
import type { TreeSpaceSummaryV3 } from "./ports/tree-remote";
import { inspectLocalImageUpgrade } from "./storage/local-image-upgrade";
import {
  BrowserAuthorizationController,
  type BrowserAuthorizationState,
} from "./application/browser-authorization";

const actionLabel = (kind: string): string => {
  const labels: Record<string, string> = {
    write: "写入",
    write_page: "写入",
    create: "创建",
    create_page: "创建",
    create_directory: "创建目录",
    rename: "重命名",
    move_page: "移动",
    move_directory: "移动目录",
    trash: "删除",
    trash_page: "删除",
    trash_directory: "删除目录",
    upsert: "更新",
    upsert_page: "更新",
    upsert_folder: "更新目录",
    archive: "归档",
    archive_page: "归档",
    archive_folder: "归档目录",
  };
  return labels[kind] || kind;
};

const roleLabel: Record<SyncSpaceSummary["role"], string> = {
  viewer: "只读",
  editor: "可编辑",
  admin: "管理员",
  owner: "所有者",
};

const localImageUpgradeControlRoot = async (
  deviceId: string,
  spaceId: string,
): Promise<string> => {
  const deviceKey = await idFileKey(deviceId);
  const spaceKey = await idFileKey(spaceId);
  return (
    ".agentwiki/devices/d-" +
    deviceKey.replace(/[^A-Za-z0-9_-]/gu, "_") +
    "/spaces/s-" +
    spaceKey.replace(/[^A-Za-z0-9_-]/gu, "_")
  );
};

const DEFAULT_V1_CAPABILITIES: SyncCapabilities = {
  maxPageBytes: 1048576,
  maxBatchBytes: 4194304,
  maxBatchItems: 100,
  maxChangeCount: 5000,
  maxConfirmationBytes: 4194304,
  maxClientSpacePages: 5000,
  maxClientManifestBytes: 4194304,
  maxClientTotalBodyBytes: 104857600,
  maxResponseBytes: 4194304,
  maxPageItems: 100,
  pushSessionTtlSeconds: 900,
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
  private shortestImageIndex: ObsidianShortestImageIndex | null = null;
  settings: AgentWikiSyncSettings = DEFAULT_SETTINGS;
  private readonly locks = new OperationLock();
  private readonly liveRuntimes = new Map<string, SyncRuntime>();
  private readonly previewUnloadCleanups = new Set<() => void>();
  private readonly runtimeRoutes = new WeakMap<
    SyncRuntime,
    {
      route: SpaceSyncRoute;
      upgrade: LocalImageUpgradeEntry | null;
      space: TreeSpaceSummaryV3 | null;
    }
  >();
  private statusBarEl: HTMLElement | null = null;
  private browserAuthorization: BrowserAuthorizationController | null = null;
  private settingsRepo(): MutableControlRepository<AgentWikiSyncSettings> {
    return new MutableControlRepository(
      new ObsidianLocalControlStore(this.app),
      "device-settings.json",
      isDeviceSettings,
    );
  }
  override onunload(): void {
    this.browserAuthorization?.stop();
    for (const cleanup of [...this.previewUnloadCleanups]) cleanup();
    this.previewUnloadCleanups.clear();
    for (const runtime of this.liveRuntimes.values()) runtime.invalidate();
    this.liveRuntimes.clear();
    this.shortestImageIndex?.invalidate();
  }

  override async onload(): Promise<void> {
    const stored: unknown = await this.loadData();
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
        true,
      );
      this.settings.serverInstanceId = connection.payload.serverInstanceId;
      await new VaultIdentityService(
        new ObsidianControlStore(this.app.vault.adapter),
        localStore,
      ).bind(connection.payload.vaultId);
      await this.saveSettings();
    }
    this.browserAuthorization = new BrowserAuthorizationController({
      http: new RequestUrlHttp(),
      secrets: new ObsidianSecrets(this.app),
      store: localStore,
      connect: (code) => this.connect(code),
      allowLoopbackDevelopment: true,
    });
    if (!connection) await this.browserAuthorization.resume();
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
      this.shortestImageIndex?.invalidate();
      for (const runtime of this.liveRuntimes.values()) {
        runtime.invalidate();
        this.runtimeRoutes.get(runtime)?.upgrade?.invalidate();
      }
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
  browserAuthorizationState(): BrowserAuthorizationState {
    return this.browserAuthorization?.current() ?? { status: "idle" };
  }
  subscribeBrowserAuthorization(
    listener: (state: BrowserAuthorizationState) => void,
  ): () => void {
    return this.browserAuthorization?.subscribe(listener) ?? (() => {});
  }
  async startBrowserAuthorization(): Promise<BrowserAuthorizationState> {
    if (!this.browserAuthorization) throw new Error("插件尚未完成加载");
    if (!this.settings.serverUrl) {
      this.settings.serverUrl = DEFAULT_SETTINGS.serverUrl;
      await this.saveSettings();
    }
    const state = await this.browserAuthorization.start(
      this.settings.serverUrl,
      this.manifest.version,
    );
    if (
      state.status === "waiting" ||
      state.status === "connecting" ||
      state.status === "error"
    )
      this.openExternal(state.authorizationUrl);
    return state;
  }
  async resumeBrowserAuthorization(): Promise<BrowserAuthorizationState> {
    return (
      (await this.browserAuthorization?.resume()) ?? { status: "idle" as const }
    );
  }
  stopBrowserAuthorization(): void {
    this.browserAuthorization?.stop();
  }
  async cancelBrowserAuthorization(): Promise<void> {
    await this.browserAuthorization?.cancel();
  }
  retryBrowserAuthorization(): void {
    this.browserAuthorization?.retry();
  }
  connectionGuideUrl(): string {
    return `${normalizeServerUrl(this.settings.serverUrl, true)}/guide/obsidian#connect`;
  }
  openExternal(url: string): void {
    window.open(url, "_blank", "noopener,noreferrer");
  }
  async copyText(value: string): Promise<void> {
    await navigator.clipboard.writeText(value);
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
    const serverUrl = normalizeServerUrl(this.settings.serverUrl, true);
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
      allowLoopbackDevelopment: true,
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
    const selection = await this.negotiate(
      client,
      state!.payload.serverInstanceId,
    );
    if (selection.version === "3")
      return (await new V3TreeRemote(client, "", selection).spaces()).map(
        (space) => ({
          spaceId: space.spaceId,
          displayName: space.displayName,
          role: space.role,
          canRead: space.canRead,
          canPublish: space.canPublish,
          syncMode: space.syncMode,
          currentRevision: space.currentRevision,
          pageCount: space.pageCount,
          revisionManifestByteLength: space.revisionManifestByteLength,
          revisionBodyBytes: space.revisionBodyBytes,
        }),
      );
    const remote: TreeRemotePort =
      selection.version === "2"
        ? new V2TreeRemote(client, "", selection)
        : new V1TreeRemote(client, "", DEFAULT_V1_CAPABILITIES);
    return remote.spaces();
  }

  private async negotiate(
    client: AgentWikiClient,
    serverInstanceId: string,
    requiredVersion: "1" | "2" | "3" = "1",
  ): Promise<SyncProtocolSelection> {
    const local = new ObsidianLocalControlStore(this.app);
    return new ProtocolNegotiator(
      client,
      new ProtocolSelectionRepository(local),
    ).select(
      {
        serverOrigin: this.settings.serverUrl,
        serverInstanceId,
        pluginVersion: this.manifest.version,
      },
      requiredVersion,
    );
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
    await this.assertNoPendingLocalImageUpgrade(mapping);
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
        if (this.runtimeRoutes.get(runtime)?.route === "recover_upgrade")
          throw new Error(`Space ${spaceId} 有未完成的图片同步升级`);
        await runtime.recover();
        const status =
          runtime.protocolVersion === "3"
            ? await runtime.statusV3()
            : await runtime.status();
        const attachmentDirty =
          "attachmentsAdded" in status.local
            ? status.local.attachmentsAdded.length +
              status.local.attachmentsModified.length +
              status.local.attachmentsRenamed.length +
              status.local.attachmentsDetached.length +
              status.local.attachmentBlockers.length
            : 0;
        gate = {
          activeTransaction: false,
          localClean:
            status.local.added.length +
              status.local.modified.length +
              status.local.renamed.length +
              status.local.deleted.length +
              attachmentDirty >
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
      await this.assertNoPendingLocalImageUpgrade(mapping);
      let runtime: SyncRuntime | null = null;
      try {
        runtime = await this.runtime(mapping);
      } catch {
        // Offline or identity mismatch: local disconnect is the escape hatch.
        continue;
      }
      if (runtime) {
        if (this.runtimeRoutes.get(runtime)?.route === "recover_upgrade")
          throw new Error(`Space ${mapping.spaceId} 有未完成的图片同步升级`);
        if (await runtime.hasUnfinishedPush())
          throw new Error(`Space ${mapping.spaceId} 有未完成的推送`);
      }
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
  private async assertNoPendingLocalImageUpgrade(
    mapping: SpaceMapping,
  ): Promise<void> {
    const local = new ObsidianLocalControlStore(this.app);
    const state = (
      await new MutableControlRepository(
        local,
        "connection-state.json",
        isConnectionState,
      ).read()
    )?.payload;
    const deviceId = (await new DeviceStateRepository(local).read())?.deviceId;
    if (!state) return;
    const candidateDeviceIds = new Set([state.deviceId]);
    if (deviceId) candidateDeviceIds.add(deviceId);
    for (const candidateDeviceId of candidateDeviceIds) {
      const controlRoot = await localImageUpgradeControlRoot(
        candidateDeviceId,
        mapping.spaceId,
      );
      const control = new ObsidianControlStore(this.app.vault.adapter);
      const push = await readPushProtocolRequirement(control, controlRoot, {
        spaceId: mapping.spaceId,
        normalizedAuthority: {
          serverOrigin: state.serverUrl,
          serverInstanceId: state.serverInstanceId,
          deviceId: candidateDeviceId,
          credentialId: state.credentialId,
          vaultId: state.vaultId,
          mappingRootKey: mapping.rootPath,
        },
      });
      if (push) {
        const journal = (
          await new PushJournalRouter(control, controlRoot).read()
        )?.payload;
        if (
          journal &&
          (journal.schemaVersion === 4
            ? journal.phase !== "complete" && journal.phase !== "superseded"
            : journal.remoteState !== "superseded" &&
              journal.localCommitPhase !== "verified")
        )
          throw new Error(`Space ${mapping.spaceId} 有未完成的推送`);
      }
      const pending = await inspectLocalImageUpgrade(
        new ObsidianControlStore(this.app.vault.adapter),
        await localImageUpgradeControlRoot(candidateDeviceId, mapping.spaceId),
        {
          serverInstanceId: state.serverInstanceId,
          spaceId: mapping.spaceId,
          deviceId: candidateDeviceId,
          credentialId: state.credentialId,
          mappingRootKey: mapping.rootPath,
        },
      );
      if (
        pending &&
        pending.phase !== "complete" &&
        pending.phase !== "superseded"
      )
        throw new Error(`Space ${mapping.spaceId} 有未完成的图片同步升级`);
    }
  }
  private selectedMapping(requestedSpaceId?: string) {
    const activePath = this.app.workspace.getActiveFile()?.path ?? "";
    return resolveMapping(this.settings.mappings, activePath, requestedSpaceId);
  }
  private async runtime(
    mapping: NonNullable<ReturnType<AgentWikiSyncPlugin["selectedMapping"]>>,
  ): Promise<SyncRuntime | null> {
    const invalidateCached = () => {
      for (const [key, runtime] of this.liveRuntimes) {
        if (runtime.spaceId !== mapping.spaceId) continue;
        runtime.invalidate();
        this.runtimeRoutes.get(runtime)?.upgrade?.invalidate();
        this.liveRuntimes.delete(key);
      }
    };
    try {
      const local = new ObsidianLocalControlStore(this.app);
      const shared = new ObsidianControlStore(this.app.vault.adapter);
      await new VaultIdentityService(shared, local).assertBound();
      const connectionState = await new MutableControlRepository(
        local,
        "connection-state.json",
        isConnectionState,
      ).read();
      const secretId = connectionState?.payload.credentialSecretId ?? null;
      const deviceState = new DeviceStateRepository(local);
      const deviceId = (await deviceState.read())?.deviceId;
      if (!secretId || !deviceId) {
        invalidateCached();
        return null;
      }
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
      const deviceKey = await idFileKey(deviceId);
      const spaceKey = await idFileKey(mapping.spaceId);
      const controlRoot = await localImageUpgradeControlRoot(
        deviceId,
        mapping.spaceId,
      );
      const pushRequirement = await readPushProtocolRequirement(
        shared,
        controlRoot,
        {
          spaceId: mapping.spaceId,
          normalizedAuthority: {
            serverOrigin: this.settings.serverUrl,
            serverInstanceId: state.serverInstanceId,
            deviceId: state.deviceId,
            credentialId: state.credentialId,
            vaultId: state.vaultId,
            mappingRootKey: mapping.rootPath,
          },
        },
      );
      const parent = pushRequirement
        ? (await new PushJournalRouter(shared, controlRoot).read())?.payload
        : null;
      const normalizedPending =
        parent?.schemaVersion === 4 &&
        parent.phase !== "complete" &&
        parent.phase !== "superseded";
      const legacyPending =
        (parent?.schemaVersion === 1 || parent?.schemaVersion === 2) &&
        parent.remoteState !== "superseded" &&
        parent.localCommitPhase !== "verified";
      const baselineRequiredVersion = await new TreeBaselineRepository(
        shared,
        controlRoot,
        mapping.spaceId,
        mapping.rootPath,
      ).requiredProtocolVersion();
      const requiredVersion =
        pushRequirement?.minimumProtocolVersion === "3"
          ? "3"
          : baselineRequiredVersion;
      const protocols = new ProtocolNegotiator(
        client,
        new ProtocolSelectionRepository(local),
      );
      const vault = new ObsidianVaultPort(
        this.app.vault,
        this.app.fileManager,
        mapping.rootPath,
        new ObsidianShortestImageResolver(
          this.app.vault,
          this.app.metadataCache,
          mapping.rootPath,
          (this.shortestImageIndex ??= new ObsidianShortestImageIndex(
            this.app.vault,
          )),
        ),
      );
      const upgrade =
        normalizedPending || legacyPending
          ? null
          : await LocalImageUpgradeEntry.create({
              client,
              protocols,
              vault,
              control: shared,
              controlRoot,
              mapping,
              authority: {
                serverOrigin: this.settings.serverUrl,
                serverInstanceId: state.serverInstanceId,
                pluginVersion: this.manifest.version,
                deviceId: state.deviceId,
                credentialId: state.credentialId,
                vaultId: state.vaultId,
              },
            });
      if (
        upgrade?.pendingIntent?.phase === "complete" ||
        upgrade?.pendingIntent?.phase === "superseded"
      )
        await upgrade.recover();
      else if (upgrade?.pendingIntent) {
        const carrier = new SyncRuntime(
          vault,
          shared,
          new V1TreeRemote(client, mapping.spaceId, DEFAULT_V1_CAPABILITIES),
          mapping,
          deviceKey,
          spaceKey,
          state.credentialId,
          new AgentWikiPushRemote(client, mapping.spaceId),
        );
        this.runtimeRoutes.set(carrier, {
          route: "recover_upgrade",
          upgrade,
          space: null,
        });
        return carrier;
      }
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
      const selection = await protocols.selectFresh(requiredVersion);
      let space: TreeSpaceSummaryV3 | null = null;
      let v2CapabilitiesHash = "";
      let runtime: SyncRuntime;
      if (selection.version === "3") {
        space =
          (
            await new V3TreeRemote(client, mapping.spaceId, selection).spaces()
          ).find((item) => item.spaceId === mapping.spaceId) ?? null;
        if (!space) throw new Error("SPACE_FORBIDDEN");
        if (legacyPending && space.syncMode !== "legacy_v2")
          throw new Error("PUSH_RECOVERY_REQUIRED");
        if (space.syncMode === "legacy_v2" && !normalizedPending) {
          const v2 = await protocols.selectV2Fresh();
          v2CapabilitiesHash = v2.capabilitiesHash;
          runtime = new SyncRuntime(
            vault,
            shared,
            new V2TreeRemote(client, mapping.spaceId, v2),
            mapping,
            deviceKey,
            spaceKey,
            state.credentialId,
            new AgentWikiPushRemote(client, mapping.spaceId),
          );
        } else {
          runtime = SyncRuntime.v3(
            vault,
            shared,
            new V3TreeRemote(client, mapping.spaceId, selection),
            mapping,
            deviceKey,
            spaceKey,
            state.credentialId,
          );
        }
      } else {
        runtime = new SyncRuntime(
          vault,
          shared,
          selection.version === "2"
            ? new V2TreeRemote(client, mapping.spaceId, selection)
            : new V1TreeRemote(client, mapping.spaceId, session.capabilities),
          mapping,
          deviceKey,
          spaceKey,
          state.credentialId,
          new AgentWikiPushRemote(client, mapping.spaceId),
        );
        if (selection.version === "2")
          v2CapabilitiesHash = selection.capabilitiesHash;
      }
      const localImageCandidate =
        !legacyPending &&
        (selection.version !== "3" || space?.syncMode === "legacy_v2")
          ? await runtime.hasLocalImageCandidate()
          : false;
      const route = normalizedPending
        ? "native_v3"
        : legacyPending
          ? "legacy"
          : selectSpaceSyncRoute({
              serverVersion: selection.version,
              syncMode: space?.syncMode ?? null,
              requiredVersion,
              pendingUpgrade: false,
              localImageCandidate,
              remoteImageCandidate:
                space?.syncMode === "legacy_v2" &&
                Number(space.attachmentCount) > 0,
            });
      const protocolSuffix =
        selection.version === "3"
          ? `3\0${selection.capabilitiesHash}\0${v2CapabilitiesHash}`
          : selection.version === "2"
            ? `2\0${selection.capabilitiesHash}`
            : "1";
      const runtimeKey =
        this.settings.serverUrl +
        "\0" +
        (this.settings.serverInstanceId ?? "pending") +
        "\0" +
        mapping.spaceId +
        "\0" +
        mapping.rootPath +
        "\0" +
        state.credentialId +
        "\0" +
        state.deviceId +
        "\0" +
        state.vaultId +
        "\0" +
        route +
        "\0" +
        protocolSuffix;
      for (const [key, cached] of this.liveRuntimes) {
        if (cached.protocolVersion !== "3") continue;
        try {
          cached.configureNormalizedPush({
            serverOrigin: this.settings.serverUrl,
            serverInstanceId: session.serverInstanceId,
            deviceId: session.deviceId,
            credentialId: session.credentialId,
            vaultId: session.vaultId,
          });
        } catch {
          cached.invalidate();
          this.runtimeRoutes.get(cached)?.upgrade?.invalidate();
          this.liveRuntimes.delete(key);
        }
      }
      const existing = this.liveRuntimes.get(runtimeKey);
      if (existing) {
        if (existing.protocolVersion === "3")
          existing.configureNormalizedPush({
            serverOrigin: this.settings.serverUrl,
            serverInstanceId: session.serverInstanceId,
            deviceId: session.deviceId,
            credentialId: session.credentialId,
            vaultId: session.vaultId,
          });
        const boundUpgrade = this.runtimeRoutes.get(existing)?.upgrade ?? null;
        this.runtimeRoutes.set(existing, {
          route,
          upgrade: route === "upgrade" ? (boundUpgrade ?? upgrade) : null,
          space,
        });
        return existing;
      }
      if (runtime.protocolVersion === "3")
        runtime.configureNormalizedPush({
          serverOrigin: this.settings.serverUrl,
          serverInstanceId: session.serverInstanceId,
          deviceId: session.deviceId,
          credentialId: session.credentialId,
          vaultId: session.vaultId,
        });
      this.liveRuntimes.set(runtimeKey, runtime);
      this.runtimeRoutes.set(runtime, {
        route,
        upgrade: route === "upgrade" ? upgrade : null,
        space,
      });
      return runtime;
    } catch (error) {
      invalidateCached();
      throw error;
    }
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
    if (runtime.protocolVersion === "3") {
      const pending = await runtime.inspectNormalizedPush();
      if (
        pending &&
        pending.phase !== "complete" &&
        pending.phase !== "superseded"
      )
        return {
          canPublish: true,
          displayName:
            pending.mode === "local_only"
              ? "本地链接修正待处理，未发布云端版本"
              : pending.verifiedTarget
                ? "远端已发布，本地待处理"
                : "图片链接规范化推送待处理",
          rootPath: mapping.rootPath,
          roleLabel: "待恢复",
          remoteAhead: false,
          protocolLabel: "Sync v3",
          attachmentChanges: null,
          localFoldersAdded: [],
          localFoldersMoved: [],
          localFoldersDeleted: [],
          remoteFoldersUpdated: [],
          remoteFoldersArchived: [],
          folderCount: 0,
          pageCount: pending.localPlan.length,
          localAdded: [],
          localModified: pending.localPlan.map((action) => action.path),
          localRenamed: [],
          localDeleted: [],
          remoteUpdated: [],
          remoteArchived: [],
          remoteListed: false,
          remoteFirstBind: false,
          recoveryPending: true,
        };
    }
    const routed = this.runtimeRoutes.get(runtime);
    const legacyPending =
      runtime.protocolVersion !== "3" && (await runtime.hasUnfinishedPush());
    if (
      legacyPending ||
      (routed?.route === "recover_upgrade" && routed.upgrade)
    ) {
      return {
        canPublish: true,
        displayName: mapping.spaceId,
        rootPath: mapping.rootPath,
        roleLabel: "待恢复",
        remoteAhead: true,
        protocolLabel: legacyPending
          ? runtime.protocolVersion === "1"
            ? "Legacy v1"
            : "Sync v2"
          : "Sync v2 → Sync v3",
        attachmentChanges: null,
        localFoldersAdded: [],
        localFoldersMoved: [],
        localFoldersDeleted: [],
        remoteFoldersUpdated: [],
        remoteFoldersArchived: [],
        folderCount: 0,
        pageCount: 0,
        localAdded: [],
        localModified: [],
        localRenamed: [],
        localDeleted: [],
        remoteUpdated: [],
        remoteArchived: [],
        remoteListed: false,
        remoteFirstBind: false,
        recoveryPending: true,
      };
    }
    if (routed?.route === "upgrade" && routed.upgrade) {
      const prepared = await routed.upgrade.prepare(options);
      const attachments =
        prepared.kind === "upgrade_draft"
          ? prepared.merge.resolvedAttachments
          : prepared.fixed.rawLocal.attachments;
      const pages = prepared.fixed.rawLocal.pages.map((page) => page.path);
      const space = routed.space;
      if (!space) throw new Error("SPACE_MODE_INVALID");
      return {
        canPublish: space.canPublish,
        displayName: space.displayName,
        rootPath: mapping.rootPath,
        roleLabel: roleLabel[space.role],
        remoteAhead: prepared.fixed.remote.sourceRevision !== "0",
        protocolLabel: "Sync v2 → Sync v3",
        attachmentChanges: {
          uploads: attachments.length,
          downloads: 0,
          replacements: 0,
          renames: 0,
          detached: 0,
          uploadBytes: attachments.reduce(
            (total, attachment) => total + Number(attachment.sizeBytes),
            0,
          ),
          downloadBytes: 0,
          transferLimitBytes:
            prepared.fixed.v3Capabilities.maxTransferBlobBytes,
          items: attachments.map((attachment) => ({
            attachmentId: attachment.attachmentId,
            path: attachment.path,
            operation: "upsert_attachment",
            sizeBytes: Number(attachment.sizeBytes),
            affectedPageCount: prepared.fixed.rawLocal.pages.filter((page) =>
              page.referencedAttachmentIds.includes(attachment.attachmentId),
            ).length,
          })),
        },
        localFoldersAdded: prepared.fixed.rawLocal.folders.map(
          (folder) => folder.path,
        ),
        localFoldersMoved: [],
        localFoldersDeleted: [],
        remoteFoldersUpdated: [],
        remoteFoldersArchived: [],
        folderCount: prepared.fixed.rawLocal.folders.length,
        pageCount: pages.length,
        localAdded: pages,
        localModified: [],
        localRenamed: [],
        localDeleted: [],
        remoteUpdated: [],
        remoteArchived: [],
        remoteListed: true,
        remoteFirstBind: prepared.fixed.remote.sourceRevision === "0",
      };
    }
    if (routed?.route === "bootstrap" && routed.space) {
      const space = routed.space;
      return {
        canPublish: space.canPublish,
        displayName: space.displayName,
        rootPath: mapping.rootPath,
        roleLabel: roleLabel[space.role],
        remoteAhead: space.currentRevision !== "0",
        protocolLabel: "Sync v3",
        attachmentChanges: null,
        localFoldersAdded: [],
        localFoldersMoved: [],
        localFoldersDeleted: [],
        remoteFoldersUpdated: [],
        remoteFoldersArchived: [],
        folderCount: 0,
        pageCount: 0,
        localAdded: [],
        localModified: [],
        localRenamed: [],
        localDeleted: [],
        remoteUpdated: [],
        remoteArchived: [],
        remoteListed: false,
        remoteFirstBind: true,
      };
    }
    await runtime.recover();
    const [status, delta, spaces] = await Promise.all([
      runtime.protocolVersion === "3"
        ? runtime.statusV3(options)
        : runtime.status(options),
      runtime.protocolVersion === "3"
        ? runtime.remoteDeltaV3()
        : runtime.remoteDelta(),
      this.listAccessibleSpaces(),
    ]);
    const space = spaces.find((item) => item.spaceId === mapping.spaceId);
    if (!space) throw new Error("当前凭据无权访问该空间。");
    const localFoldersAdded = status.local.foldersAdded.map(
      (folder) => folder.path,
    );
    const localFoldersMoved = status.local.foldersMoved.map(
      (folder) => folder.path,
    );
    const localFoldersDeleted = status.local.foldersDeleted.map(
      (folder) => folder.path,
    );
    const localAdded = status.local.added.map((file) => file.path);
    const localModified = status.local.modified.map((file) => file.path);
    const localRenamed = status.local.renamed.map((file) => file.path);
    const localDeleted = status.local.deleted.map((page) => page.path);
    const remoteUpdated = delta.items
      .filter((item) => item.operation === "upsert_page")
      .map((item) => item.page.path);
    const remoteArchived = delta.items
      .filter((item) => item.operation === "archive_page")
      .map((item) => item.previousPath);
    const remoteFoldersUpdated = delta.items
      .filter((item) => item.operation === "upsert_folder")
      .map((item) => item.folder.path);
    const remoteFoldersArchived = delta.items
      .filter((item) => item.operation === "archive_folder")
      .map((item) => item.previousPath);
    const localAttachments =
      "attachmentsAdded" in status.local
        ? [
            ...status.local.attachmentsAdded.map((attachment) => ({
              attachment,
              operation: "upsert_attachment",
            })),
            ...status.local.attachmentsModified.map((attachment) => ({
              attachment,
              operation: "upsert_attachment",
            })),
            ...status.local.attachmentsRenamed.map((attachment) => ({
              attachment,
              operation: "upsert_attachment",
            })),
            ...status.local.attachmentsDetached.map((attachment) => ({
              attachment,
              operation: "detach_attachment",
            })),
          ]
        : [];
    const remoteAttachments: Array<{
      attachmentId: string;
      path: string;
      sizeBytes: number;
      operation: "upsert_attachment" | "detach_attachment";
    }> = [];
    const remoteAttachmentPageCounts = new Map<string, number>();
    if ("resultingPages" in delta)
      for (const page of delta.resultingPages)
        for (const attachmentId of page.referencedAttachmentIds)
          remoteAttachmentPageCounts.set(
            attachmentId,
            (remoteAttachmentPageCounts.get(attachmentId) ?? 0) + 1,
          );
    for (const item of delta.items) {
      if (item.operation === "upsert_attachment")
        remoteAttachments.push({
          attachmentId: item.attachment.attachmentId,
          path: item.attachment.path,
          sizeBytes: Number(item.attachment.sizeBytes),
          operation: item.operation,
        });
      else if (item.operation === "detach_attachment")
        remoteAttachments.push({
          attachmentId: item.attachmentId,
          path: item.previousPath,
          sizeBytes: 0,
          operation: item.operation,
        });
      else if (
        !("resultingPages" in delta) &&
        item.operation === "upsert_page" &&
        "referencedAttachmentIds" in item.page
      )
        for (const attachmentId of item.page.referencedAttachmentIds)
          remoteAttachmentPageCounts.set(
            attachmentId,
            (remoteAttachmentPageCounts.get(attachmentId) ?? 0) + 1,
          );
    }
    const attachmentChanges =
      status.protocolVersion === "3"
        ? {
            uploads:
              status.local.attachmentsAdded.length +
              status.local.attachmentsModified.length,
            downloads: remoteAttachments.filter(
              (item) => item.operation === "upsert_attachment",
            ).length,
            replacements: status.local.attachmentsModified.length,
            renames: status.local.attachmentsRenamed.length,
            detached:
              status.local.attachmentsDetached.length +
              remoteAttachments.filter(
                (item) => item.operation === "detach_attachment",
              ).length,
            uploadBytes: status.local.attachmentsAdded
              .concat(status.local.attachmentsModified)
              .reduce(
                (total, attachment) => total + Number(attachment.sizeBytes),
                0,
              ),
            downloadBytes: remoteAttachments.reduce(
              (total, item) => total + item.sizeBytes,
              0,
            ),
            transferLimitBytes: status.capabilities.maxTransferBlobBytes,
            items: [
              ...[
                ...new Map(
                  localAttachments.map((item) => [
                    item.attachment.attachmentId,
                    item,
                  ]),
                ).values(),
              ].map((item) => ({
                attachmentId: item.attachment.attachmentId,
                path: item.attachment.path,
                operation: item.operation,
                sizeBytes: Number(item.attachment.sizeBytes),
                affectedPageCount:
                  status.local.attachmentPageCounts[
                    item.attachment.attachmentId
                  ] ?? 0,
              })),
              ...remoteAttachments.map((item) => ({
                ...item,
                affectedPageCount:
                  remoteAttachmentPageCounts.get(item.attachmentId) ?? 0,
              })),
            ].sort((left, right) => left.path.localeCompare(right.path)),
          }
        : null;
    const folderCount =
      localFoldersAdded.length +
      localFoldersMoved.length +
      localFoldersDeleted.length +
      remoteFoldersUpdated.length +
      remoteFoldersArchived.length;
    const pageCount =
      localAdded.length +
      localModified.length +
      localRenamed.length +
      localDeleted.length +
      remoteUpdated.length +
      remoteArchived.length;
    return {
      canPublish: space.canPublish,
      displayName: space.displayName,
      rootPath: mapping.rootPath,
      roleLabel: roleLabel[space.role],
      remoteAhead: delta.ahead,
      protocolLabel: protocolLabel(status.protocolVersion),
      attachmentChanges,
      localFoldersAdded,
      localFoldersMoved,
      localFoldersDeleted,
      remoteFoldersUpdated,
      remoteFoldersArchived,
      folderCount,
      pageCount,
      localAdded,
      localModified,
      localRenamed,
      localDeleted,
      remoteUpdated,
      remoteArchived,
      remoteListed: delta.listed,
      remoteFirstBind: delta.ahead && delta.baseRevision === "0",
    };
  }

  private async runSyncStrategy(
    spaceId: string,
    strategy: SyncStrategy,
    options: SyncOperationOptions,
  ): Promise<ModalTransition | void> {
    const mapping = this.selectedMapping(spaceId);
    if (!mapping) throw new Error("请先连接并在设置中添加空间映射。");
    const flow = new SyncFlowLock(this.locks.acquire(mapping.spaceId));
    try {
      const runtime = await this.runtime(mapping);
      if (!runtime) throw new Error("请先连接并在设置中添加空间映射。");
      if (runtime.protocolVersion === "3") {
        const pending = await runtime.inspectNormalizedPush();
        if (
          pending &&
          pending.phase !== "complete" &&
          pending.phase !== "superseded"
        ) {
          const state =
            pending.mode === "local_only"
              ? "本地链接修正待处理，未发布云端版本"
              : pending.verifiedTarget
                ? "远端已发布，本地待处理"
                : "图片链接规范化推送待处理";
          let active = true;
          let notifyInvalidation: (() => void) | null = null;
          const unsubscribe = () => {
            active = false;
            notifyInvalidation = null;
            this.previewUnloadCleanups.delete(cleanup);
          };
          const cleanup = () => {
            active = false;
            notifyInvalidation?.();
            unsubscribe();
          };
          this.previewUnloadCleanups.add(cleanup);
          return () =>
            new PreviewModal(
              this.app,
              state,
              [state, `本地图片链接修正：${pending.localPlan.length} 个 Page`],
              async () => {
                if (!active) throw new Error("STALE_PUSH_PREVIEW");
                const currentMapping = this.settings.mappings.find(
                  (item) => item.spaceId === pending.binding.spaceId,
                );
                const current = currentMapping
                  ? await this.runtime(currentMapping)
                  : null;
                if (!active || current?.protocolVersion !== "3")
                  throw new Error("STALE_PUSH_PREVIEW");
                const owned = await current.inspectNormalizedPush();
                if (
                  !active ||
                  owned?.binding.operationId !== pending.binding.operationId ||
                  owned.authorizationHash !== pending.authorizationHash
                )
                  throw new Error("STALE_PUSH_PREVIEW");
                await current.recover();
                await this.saveSettings();
                new Notice("恢复完成。");
              },
              flow.phaseRelease(),
              [],
              null,
              {
                closeLabel: "关闭",
                confirmLabel: "重试",
                canConfirm: () => active,
                disabledReason: "恢复入口已关闭，请重新打开同步。",
                subscribeInvalidation: (listener) => {
                  notifyInvalidation = listener;
                  return unsubscribe;
                },
                files: pending.localPlan.map((action) => ({
                  path: action.path,
                  open: async () => {
                    await this.app.workspace.openLinkText(
                      `${pending.binding.mappingRootKey}/${action.path}`,
                      "",
                      false,
                    );
                  },
                })),
              },
            ).open();
        }
      }
      if (
        runtime.protocolVersion !== "3" &&
        (await runtime.hasUnfinishedPush())
      ) {
        await runtime.recover();
        await this.saveSettings();
        new Notice("已恢复先前确认的推送，请重新预览同步。");
        flow.finish();
        return;
      }
      const routed = this.runtimeRoutes.get(runtime);
      if (routed?.route === "recover_upgrade" && routed.upgrade) {
        await routed.upgrade.recover(options);
        new Notice("已恢复先前确认的图片同步升级。");
        flow.finish();
        return;
      }
      if (routed?.route === "upgrade" && routed.upgrade)
        return await this.openLocalImageUpgrade(
          runtime,
          routed.upgrade,
          routed.space?.canPublish ?? false,
          flow,
          options,
        );
      await runtime.recover();
      if (strategy === "server") {
        return await this.syncUseServer(runtime, flow, options);
      }
      if (strategy === "local") {
        return await this.syncUseLocal(runtime, flow, options);
      }
      return await this.syncAutoMerge(runtime, flow, options);
    } catch (error) {
      flow.finish();
      throw error;
    }
  }

  private upgradeLines(draft: LocalImageUpgradeDraft): string[] {
    const attachments = draft.merge.resolvedAttachments;
    const transferBytes = attachments.reduce(
      (total, attachment) => total + Number(attachment.sizeBytes),
      0,
    );
    return [
      "Sync v2 → Sync v3：确认后该 Space 不可自动降级，其他客户端需支持 Sync v3。",
      `图片：${attachments.length} 张 · 传输字节上界 ${transferBytes} B / ${draft.fixed.v3Capabilities.maxTransferBlobBytes} B`,
      ...attachments.map(
        (attachment) => `图片：${attachment.path} · ${attachment.sizeBytes} B`,
      ),
      ...draft.merge.actions.map(
        (action) =>
          `本地应用 ${actionLabel(action.kind)}: ${
            "attachment" in action
              ? action.attachment.path
              : "path" in action
                ? action.path
                : action.attachmentId
          }`,
      ),
      ...draft.merge.folderConflicts.map(
        (conflict) => `目录冲突待处理: ${conflict.folderId}`,
      ),
      ...draft.merge.pageConflicts.map(
        (conflict) => `页面冲突待处理: ${conflict.pageId} · ${conflict.field}`,
      ),
      ...draft.merge.attachmentConflicts.map(
        (conflict) => `图片冲突待处理: ${conflict.attachmentId}`,
      ),
    ];
  }

  private openUpgradeDraft(
    runtime: SyncRuntime,
    entry: LocalImageUpgradeEntry,
    draft: LocalImageUpgradeDraft,
    canPublish: boolean,
    flow: SyncFlowLock,
  ): ModalTransition {
    const releasePhase = flow.phaseRelease();
    return () =>
      new PreviewModal(
        this.app,
        "图片同步协议升级预览",
        () => this.upgradeLines(draft),
        async (applyOptions) => {
          const recomputed = await entry.recompute(draft);
          if (recomputed.kind === "text_preview_required") {
            const text = await entry.prepareTextSyncPreview(
              recomputed,
              applyOptions,
            );
            flow.advance();
            return this.openUpgradeTextPull(
              runtime,
              entry,
              text,
              flow,
              applyOptions,
            );
          }
          const preview = await entry.finalizePreview(recomputed, applyOptions);
          await entry.confirm(preview, preview.authorizationHash, applyOptions);
          await this.saveSettings();
          new Notice("图片同步升级完成。");
        },
        releasePhase,
        [],
        draft.merge,
        {
          confirmLabel: "确认升级并同步",
          canConfirm: () => canPublish && entry.isCurrent(draft),
          disabledReason: canPublish
            ? "预览已失效，请重新打开同步中心生成新预览。"
            : "当前空间为只读，无法确认升级。",
          subscribeInvalidation: (listener) => {
            const off = entry.onInvalidate(listener);
            const cleanup = () => {
              entry.invalidate();
              unsubscribe();
            };
            const unsubscribe = () => {
              if (!this.previewUnloadCleanups.delete(cleanup)) return;
              off();
            };
            this.previewUnloadCleanups.add(cleanup);
            return unsubscribe;
          },
        },
      ).open();
  }

  private async openLocalImageUpgrade(
    runtime: SyncRuntime,
    entry: LocalImageUpgradeEntry,
    canPublish: boolean,
    flow: SyncFlowLock,
    options: SyncOperationOptions,
  ): Promise<ModalTransition> {
    const prepared = await entry.prepare(options);
    if (prepared.kind === "upgrade_draft")
      return this.openUpgradeDraft(runtime, entry, prepared, canPublish, flow);
    const choices = prepared.requirements.map((requirement) => ({
      kind: requirement.kind,
      localId: requirement.localId,
      remoteId: requirement.remoteId,
    }));
    const releasePhase = flow.phaseRelease();
    return () =>
      new PreviewModal(
        this.app,
        "确认初始页面与目录身份",
        [
          "这些同路径对象使用不同身份。应用以下显式绑定后才会生成升级预览；此步骤不会写入 Vault 或服务器。",
          ...prepared.requirements.map(
            (item) =>
              `${item.kind === "folder" ? "目录" : "页面"}: ${item.path} · 本地 ${item.localId} → 远端 ${item.remoteId}`,
          ),
        ],
        async () => {
          const draft = await entry.resolveInitialBindings(prepared, choices);
          flow.advance();
          return this.openUpgradeDraft(runtime, entry, draft, canPublish, flow);
        },
        releasePhase,
        [],
        null,
        { confirmLabel: "应用身份绑定并继续" },
      ).open();
  }

  private openUpgradeTextPull(
    runtime: SyncRuntime,
    entry: LocalImageUpgradeEntry,
    preview: LocalImageUpgradeTextSyncPreview,
    flow: SyncFlowLock,
    options: SyncOperationOptions,
  ): ModalTransition {
    const releasePhase = flow.phaseRelease();
    return () =>
      new PreviewModal(
        this.app,
        "Sync v2 文字合并",
        preview.pull.actions.map(
          (action) => `${actionLabel(action.kind)}: ${action.path}`,
        ),
        async (applyOptions) => {
          await runtime.applyPull(structuredClone(preview.pull), applyOptions, {
            expectedPathStates: preview.expectedPathStates,
            revalidate: () =>
              entry.revalidateTextSyncPreview(preview, applyOptions),
          });
          await this.saveSettings();
          flow.advance();
          return await this.openPushPreview(
            runtime,
            flow,
            "Sync v2 推送预览",
            applyOptions ?? options,
          );
        },
        releasePhase,
        [],
        preview.pull,
        { confirmLabel: "确认文字合并" },
      ).open();
  }

  private async syncUseServer(
    runtime: SyncRuntime,
    flow: SyncFlowLock,
    options: SyncOperationOptions,
  ): Promise<ModalTransition | void> {
    if (runtime.protocolVersion === "3")
      return this.openV3PullFlow(
        runtime,
        flow,
        "以服务器内容为准",
        "remote",
        false,
        options,
      );
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
    for (const conflict of preview.folderConflicts)
      preview.folderConflictResolutions[conflict.conflictId] = {
        choice: "remote",
      };
    for (const binding of preview.initialBindings)
      if (binding.resolution === null) binding.resolution = "remote";
    return () =>
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
  ): Promise<ModalTransition | void> {
    if (runtime.protocolVersion === "3") {
      const delta = await runtime.remoteDeltaV3();
      if (!delta.ahead)
        return this.openPushPreview(
          runtime,
          flow,
          "推送预览（以本地内容为准）",
          options,
        );
      return this.openV3PullFlow(
        runtime,
        flow,
        "以本地内容为准 — 先合并服务器更新",
        "local",
        true,
        options,
      );
    }
    const delta = await runtime.remoteDelta();
    if (!delta.ahead) {
      return await this.openPushPreview(
        runtime,
        flow,
        "推送预览（以本地内容为准）",
        options,
      );
    }
    const preview = await runtime.previewPull(options);
    preferLocalPull(preview);
    const releasePhase = flow.phaseRelease();
    return () =>
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
          return await this.openPushPreview(
            runtime,
            flow,
            "推送预览（以本地内容为准）",
            applyOptions,
          );
        },
        () => {
          void runtime.discardPullPreview(preview).finally(releasePhase);
        },
        preview.initialBindings,
        preview,
      ).open();
  }

  private async syncAutoMerge(
    runtime: SyncRuntime,
    flow: SyncFlowLock,
    options: SyncOperationOptions,
  ): Promise<ModalTransition | void> {
    if (runtime.protocolVersion === "3") {
      const delta = await runtime.remoteDeltaV3();
      if (!delta.ahead)
        return this.openPushPreview(runtime, flow, "推送预览", options);
      return this.openV3PullFlow(
        runtime,
        flow,
        "自动合并 — 处理冲突与图片",
        null,
        true,
        options,
      );
    }
    const delta = await runtime.remoteDelta();
    if (!delta.ahead) {
      return await this.openPushPreview(runtime, flow, "推送预览", options);
    }
    const preview = await runtime.previewPull(options);
    const needsResolution =
      preview.conflicts.some(
        (item) => !preview.conflictResolutions[item.conflictId],
      ) ||
      preview.folderConflicts.some(
        (item) => !preview.folderConflictResolutions[item.conflictId],
      ) ||
      preview.initialBindings.some((item) => item.resolution === null);
    const releasePhase = flow.phaseRelease();
    return () =>
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
          ...preview.folderConflicts.map(
            (item) => `目录冲突待处理: ${item.folderId}`,
          ),
        ],
        async (applyOptions) => {
          await runtime.applyPull(preview, applyOptions);
          await this.saveSettings();
          flow.advance();
          return await this.openPushPreview(
            runtime,
            flow,
            "自动合并 — 推送本地变更",
            applyOptions,
          );
        },
        () => {
          void runtime.discardPullPreview(preview).finally(releasePhase);
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
  ): Promise<ModalTransition | void> {
    if (runtime.protocolVersion === "3")
      return this.openPushPreviewV3(runtime, flow, title, options);
    try {
      const preview = await runtime.previewPush(options);
      if (!preview.changes.length) {
        new Notice("本地没有待推送的变更。");
        flow.finish();
        return;
      }
      return () =>
        new PreviewModal(
          this.app,
          title,
          preview.changes.map((item) => {
            const path =
              item.operation === "upsert_page"
                ? item.page.path
                : item.operation === "upsert_folder"
                  ? item.folder.path
                  : item.previousPath;
            return actionLabel(item.operation) + ": " + path;
          }),
          async (applyOptions) => {
            await runtime.applyPush(preview, applyOptions);
            await this.saveSettings();
            new Notice("推送完成。");
          },
          () => {
            void runtime
              .discardPushPreview(preview)
              .finally(() => flow.finish());
          },
        ).open();
    } catch (error) {
      new Notice(userErrorMessage(error));
      flow.finish();
    }
  }

  private async resolveV3Preference(
    preview: PullPreviewV3,
    preference: "local" | "remote" | null,
  ): Promise<void> {
    if (!preference) return;
    for (const conflict of [...preview.attachmentConflicts])
      await resolveAttachmentConflict(preview, conflict.conflictId, {
        choice: preference,
      });
    for (const conflict of [...preview.pageConflicts])
      await resolvePageConflictV3(preview, conflict.conflictId, {
        choice: preference,
      });
    for (const conflict of [...preview.folderConflicts])
      await resolveFolderConflictV3(preview, conflict.conflictId, {
        choice: preference,
      });
  }

  private v3PullLines(preview: PullPreviewV3): string[] {
    const transferBytes = preview.actions
      .filter(
        (item) =>
          item.kind === "create_attachment" || item.kind === "write_attachment",
      )
      .reduce(
        (total, item) =>
          total +
          ("attachment" in item ? Number(item.attachment.sizeBytes) : 0),
        0,
      );
    return [
      `图片传输：${transferBytes} B · 单次上限 ${preview.capabilities.maxTransferBlobBytes} B`,
      ...preview.blockers.map(
        (blocker) => `阻塞：${userErrorMessage(new Error(blocker.code))}`,
      ),
      ...preview.actions.map((item) => {
        if (
          item.kind === "create_attachment" ||
          item.kind === "write_attachment"
        )
          return `${attachmentOperationLabel(item.kind)}: ${item.attachment.path}`;
        if (item.kind === "remove_attachment_path")
          return `${attachmentOperationLabel(item.kind)}: ${item.path}`;
        if (item.kind === "detach_attachment")
          return `${attachmentOperationLabel(item.kind)}: ${item.attachmentId}`;
        return `${actionLabel(item.kind)}: ${item.path}`;
      }),
      ...preview.attachmentConflicts.map(
        (item) => `图片冲突待处理: ${item.attachmentId}`,
      ),
    ];
  }

  private openPreparedV3Pull(
    runtime: SyncRuntime,
    flow: SyncFlowLock,
    title: string,
    preview: PullPreviewV3,
    pushAfterPull: boolean,
  ): ModalTransition {
    const releasePhase = flow.phaseRelease();
    return () =>
      new PreviewModal(
        this.app,
        title,
        this.v3PullLines(preview),
        async (applyOptions) => {
          await runtime.applyPullV3(preview, applyOptions);
          await this.saveSettings();
          if (!pushAfterPull) {
            new Notice("已按确认预览更新本地。");
            return;
          }
          flow.advance();
          return this.openPushPreview(
            runtime,
            flow,
            title.includes("本地")
              ? "推送预览（以本地内容为准）"
              : "自动合并 — 推送本地变更",
            applyOptions,
          );
        },
        () => {
          void runtime.discardPullPreviewV3(preview).finally(releasePhase);
        },
        [],
        preview,
      ).open();
  }

  private async openV3PullFlow(
    runtime: SyncRuntime,
    flow: SyncFlowLock,
    title: string,
    preference: "local" | "remote" | null,
    pushAfterPull: boolean,
    options: SyncOperationOptions,
  ): Promise<ModalTransition | void> {
    const delta = await runtime.remoteDeltaV3();
    const sameRevisionAttachmentRepair =
      !delta.ahead &&
      delta.baseRevision !== "0" &&
      preference === "remote" &&
      !pushAfterPull;
    if (!delta.ahead && !sameRevisionAttachmentRepair) {
      new Notice("服务器没有新的变更可应用。");
      flow.finish();
      return;
    }
    try {
      const preview = await runtime.previewPullV3(
        options,
        sameRevisionAttachmentRepair
          ? { repairSameRevisionMissingRemoteAttachments: true }
          : undefined,
      );
      if (sameRevisionAttachmentRepair) {
        const attachmentIds = new Set(
          preview.sameRevisionMissingAttachmentIds ?? [],
        );
        const missingOnly =
          attachmentIds.size > 0 &&
          preview.blockers.length === 0 &&
          preview.attachmentConflicts.length === 0 &&
          preview.folderConflicts.length === 0 &&
          preview.pageConflicts.length === 0 &&
          preview.actions.length === attachmentIds.size &&
          preview.actions.every(
            (action) =>
              action.kind === "create_attachment" &&
              action.source === "remote" &&
              attachmentIds.has(action.attachment.attachmentId),
          );
        if (!missingOnly) {
          await runtime.discardPullPreviewV3(preview);
          new Notice("服务器没有新的变更可应用。");
          flow.finish();
          return;
        }
      }
      await this.resolveV3Preference(preview, preference);
      return this.openPreparedV3Pull(
        runtime,
        flow,
        title,
        preview,
        pushAfterPull,
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "V3_BOOTSTRAP_CONFIRMATION_REQUIRED"
      )
        throw error;
    }
    const bootstrap = await runtime.previewBootstrapPullV3(options);
    return () =>
      new PreviewModal(
        this.app,
        "Sync v3 首次启用预览",
        [
          `当前基线：${bootstrap.baseRevision}`,
          `图片：${bootstrap.attachmentCount} 张`,
          `传输字节：${bootstrap.transferBytes}`,
          ...bootstrap.blockers.map(
            (blocker) =>
              `Page ${blocker.pageId}: ${userErrorMessage(new Error(blocker.code))}`,
          ),
        ],
        async (confirmOptions) => {
          const preview = await runtime.confirmBootstrapPullV3(
            bootstrap,
            confirmOptions,
          );
          await this.resolveV3Preference(preview, preference);
          flow.advance();
          return this.openPreparedV3Pull(
            runtime,
            flow,
            title,
            preview,
            pushAfterPull,
          );
        },
        flow.phaseRelease(),
        [],
        bootstrap,
      ).open();
  }

  private async openPushPreviewV3(
    runtime: SyncRuntime,
    flow: SyncFlowLock,
    title: string,
    options?: SyncOperationOptions,
  ): Promise<ModalTransition | void> {
    try {
      const preview = await runtime.previewPushV3(options);
      if (
        preview.publishable &&
        !preview.changes.length &&
        !preview.normalizedPush?.plan.localPlan.length
      ) {
        new Notice("本地没有待推送的变更。");
        flow.finish();
        return;
      }
      const releasePhase = flow.phaseRelease();
      return () =>
        new PreviewModal(
          this.app,
          title,
          this.v3PushLines(preview),
          async (applyOptions) => {
            try {
              const mapping = this.settings.mappings.find(
                (item) => item.spaceId === runtime.spaceId,
              );
              if (!mapping || (await this.runtime(mapping)) !== runtime) {
                runtime.invalidate();
                throw new Error("STALE_PUSH_PREVIEW");
              }
              if (
                preview.changes.length &&
                !this.runtimeRoutes.get(runtime)?.space?.canPublish
              )
                throw new Error("SPACE_READ_ONLY");
              await runtime.applyPushV3(preview, applyOptions);
            } catch (error) {
              if (
                !(error instanceof Error) ||
                error.message !== "PUSH_CONFIRMATION_REQUIRED"
              )
                throw error;
              await runtime.discardPushPreviewV3(preview);
              flow.advance();
              return this.openPushPreviewV3(runtime, flow, title, applyOptions);
            }
            await this.saveSettings();
            new Notice(
              preview.normalizedPush?.plan.mode === "local_only"
                ? "本地图片链接修正完成，未发布云端版本。"
                : "推送完成。",
            );
          },
          () => {
            void runtime
              .discardPushPreviewV3(preview)
              .catch(() => {
                // A confirmed pending owner retains its private payload for recovery.
              })
              .finally(releasePhase);
          },
          [],
          preview,
          {
            canConfirm: () => runtime.isPushPreviewCurrent(preview),
            subscribeInvalidation: (listener) => {
              const off = runtime.onInvalidate(listener);
              const cleanup = () => {
                runtime.invalidate();
                unsubscribe();
              };
              const unsubscribe = () => {
                if (!this.previewUnloadCleanups.delete(cleanup)) return;
                off();
              };
              this.previewUnloadCleanups.add(cleanup);
              return unsubscribe;
            },
            disabledReason: "预览已失效，请关闭后重新预览。",
          },
        ).open();
    } catch (error) {
      new Notice(userErrorMessage(error));
      flow.finish();
    }
  }

  private v3PushLines(preview: PushPreviewV3): string[] {
    const transferBytes = preview.changes
      .filter((item) => item.operation === "upsert_attachment")
      .reduce(
        (total, item) =>
          total +
          (item.operation === "upsert_attachment"
            ? Number(item.attachment.sizeBytes)
            : 0),
        0,
      );
    return [
      `图片上传：${transferBytes} B · 单次上限 ${preview.capabilities.maxTransferBlobBytes} B`,
      ...preview.blockers.map(
        (blocker) =>
          `阻塞：${blocker.pagePath ?? blocker.path ?? "Page"}: ${userErrorMessage(new Error(blocker.code))}`,
      ),
      ...preview.changes.map((item) => {
        if (item.operation === "upsert_attachment")
          return `${attachmentOperationLabel(item.operation)}: ${item.attachment.path} · ${item.attachment.sizeBytes} B`;
        if (item.operation === "detach_attachment")
          return `${attachmentOperationLabel(item.operation)}: ${item.previousPath}`;
        const path =
          item.operation === "upsert_page"
            ? item.page.path
            : item.operation === "upsert_folder"
              ? item.folder.path
              : item.previousPath;
        return `${actionLabel(item.operation)}: ${path}`;
      }),
    ];
  }
}

class SyncFlowLock {
  private release: (() => void) | null;
  private generation = 0;
  constructor(release: () => void) {
    this.release = release;
  }
  advance(): void {
    this.generation += 1;
  }
  phaseRelease(): () => void {
    const generation = this.generation;
    return () => {
      if (this.generation === generation) this.finish();
    };
  }
  finish(): void {
    if (this.release) {
      this.release();
      this.release = null;
    }
  }
}
