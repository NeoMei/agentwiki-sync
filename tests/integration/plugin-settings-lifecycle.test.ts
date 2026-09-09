import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_SETTINGS,
  type AgentWikiSyncSettings,
} from "../../src/application/settings";
import {
  isConnectionState,
  type ConnectionState,
} from "../../src/application/connection-service";
import { ObsidianLocalControlStore } from "../../src/obsidian/adapters";
import { MutableControlRepository } from "../../src/storage/envelope";
import { DeviceStateRepository } from "../../src/storage/device-state";
import { V3TreeRemote } from "../../src/agentwiki/v3-tree-remote";
import { PreviewModal } from "../../src/obsidian/preview-modal";
import type { PullPreviewV3 } from "../../src/application/sync-runtime";
import type { ModalTransition } from "../../src/obsidian/modal-handoff";
import { requestUrlState } from "../fakes/obsidian-mock";
import type { MockElement } from "../fakes/obsidian-mock";
import { makePlugin, modalButton } from "../fakes/plugin-harness";
import { V3_CAPABILITIES } from "../fakes/fake-tree-remote";
import { makeNormalizedRuntimeFixture } from "../fakes/normalized-push-fixture";
import { FakeHttp } from "../fakes/fake-http";
import { treeCapabilitiesHashV3 } from "@neomei/agentwiki-sync-protocol";
import { AgentWikiSyncSettingTab } from "../../src/obsidian/settings-tab";

const legacyWithMapping: AgentWikiSyncSettings = {
  schemaVersion: 1,
  serverUrl: "https://legacy.example.com",
  serverInstanceId: "legacy-instance-must-not-enter-data-json",
  mappings: [{ spaceId: "s1", rootPath: "AgentWiki", status: "active" }],
};

describe("plugin settings lifecycle", () => {
  it("renders browser authorization as the default connection action with a ten-minute manual fallback", async () => {
    const harness = await makePlugin({ data: DEFAULT_SETTINGS });
    await harness.plugin.onload();
    const tab = new AgentWikiSyncSettingTab(
      harness.app as never,
      harness.plugin,
    );

    tab.display();

    expect((tab.containerEl as unknown as MockElement).textContent).toContain(
      "连接 AgentWiki",
    );
    expect((tab.containerEl as unknown as MockElement).textContent).toContain(
      "打开浏览器授权",
    );
    expect((tab.containerEl as unknown as MockElement).textContent).toContain(
      "手动连接码（兼容后备）",
    );
    expect((tab.containerEl as unknown as MockElement).textContent).toContain(
      "有效期 10 分钟",
    );
    expect(
      (tab.containerEl as unknown as MockElement).textContent,
    ).not.toContain("人类凭据");
  });

  it("builds the manual guide URL only from an HTTPS or literal loopback server origin", async () => {
    const harness = await makePlugin({ data: DEFAULT_SETTINGS });
    await harness.plugin.onload();
    harness.plugin.settings.serverUrl = "http://127.0.0.1:5198";
    expect(harness.plugin.connectionGuideUrl()).toBe(
      "http://127.0.0.1:5198/guide/obsidian#connect",
    );
    harness.plugin.settings.serverUrl = "javascript:alert(1)";
    expect(() => harness.plugin.connectionGuideUrl()).toThrow(/Server URL/);
  });

  it("starts browser authorization, exposes only the user URL, and cancels polling on unload", async () => {
    vi.useFakeTimers();
    const harness = await makePlugin({
      data: {
        schemaVersion: 2,
        serverUrl: "http://127.0.0.1:5198",
        mappings: [],
      },
    });
    const opened = vi
      .spyOn(harness.plugin, "openExternal")
      .mockImplementation(() => {});
    requestUrlState.impl = async (request) => {
      const input = request as { url: string };
      if (new URL(input.url).pathname.endsWith("/device/start"))
        return {
          status: 200,
          json: {
            deviceCode: "awd_secret",
            userCode: "ABCD-EFGH",
            verificationUri: "http://127.0.0.1:5198/onboard/device",
            verificationUriComplete:
              "http://127.0.0.1:5198/onboard/device?user_code=ABCD-EFGH",
            expiresIn: 600,
            interval: 5,
          },
          headers: {},
        };
      throw new Error("poll must not run after unload");
    };
    await harness.plugin.onload();

    const state = await harness.plugin.startBrowserAuthorization();

    expect(state).toMatchObject({
      status: "waiting",
      authorizationUrl:
        "http://127.0.0.1:5198/onboard/device?user_code=ABCD-EFGH",
    });
    expect(JSON.stringify(state)).not.toContain("awd_secret");
    expect(opened).toHaveBeenCalledWith(
      "http://127.0.0.1:5198/onboard/device?user_code=ABCD-EFGH",
    );
    harness.plugin.unload();
    await vi.advanceTimersByTimeAsync(5_000);
    opened.mockRestore();
    vi.useRealTimers();
  });

  it("restores a pending browser authorization after plugin reload", async () => {
    vi.useFakeTimers();
    const sharedLocal = new Map<string, unknown>();
    const sharedSecrets = new Map<string, string>();
    const first = await makePlugin({
      data: {
        schemaVersion: 2,
        serverUrl: "https://wiki.example.com",
        mappings: [],
      },
      local: sharedLocal,
      secrets: sharedSecrets,
    });
    vi.spyOn(first.plugin, "openExternal").mockImplementation(() => {});
    requestUrlState.impl = async () => ({
      status: 200,
      json: {
        deviceCode: "awd_secret",
        userCode: "ABCD-EFGH",
        verificationUri: "https://wiki.example.com/onboard/device",
        verificationUriComplete:
          "https://wiki.example.com/onboard/device?user_code=ABCD-EFGH",
        expiresIn: 600,
        interval: 5,
      },
      headers: {},
    });
    await first.plugin.onload();
    await first.plugin.startBrowserAuthorization();
    first.plugin.unload();

    const second = await makePlugin({
      data: first.app.__pluginData,
      local: sharedLocal,
      secrets: sharedSecrets,
    });
    await second.plugin.onload();

    expect(second.plugin.browserAuthorizationState()).toMatchObject({
      status: "waiting",
      userCode: "ABCD-EFGH",
    });
    second.plugin.unload();
    vi.useRealTimers();
  });
  it("stops polling while settings are hidden and resumes the valid flow when reopened", async () => {
    const harness = await makePlugin({ data: DEFAULT_SETTINGS });
    await harness.plugin.onload();
    const tab = new AgentWikiSyncSettingTab(
      harness.app as never,
      harness.plugin,
    );
    const stop = vi.spyOn(harness.plugin, "stopBrowserAuthorization");
    const resume = vi
      .spyOn(harness.plugin, "resumeBrowserAuthorization")
      .mockResolvedValue({ status: "idle" });

    tab.display();
    tab.hide();
    tab.display();

    expect(stop).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
  });
  it("unsubscribes an open real-runtime preview on plugin unload and detaches Vault events", async () => {
    const h = await makePlugin({ data: DEFAULT_SETTINGS });
    await h.plugin.onload();
    const f = await makeNormalizedRuntimeFixture("local_only");
    const off = vi.fn();
    const subscribe = f.runtime.onInvalidate.bind(f.runtime);
    vi.spyOn(f.runtime, "onInvalidate").mockImplementation((listener) => {
      const unsubscribe = subscribe(listener);
      return () => {
        off();
        unsubscribe();
      };
    });
    const subject = h.plugin as unknown as {
      openPushPreviewV3: (
        runtime: typeof f.runtime,
        flow: unknown,
        title: string,
      ) => Promise<ModalTransition>;
    };
    const open = vi.spyOn(PreviewModal.prototype, "open");
    const transition = await subject.openPushPreviewV3(
      f.runtime,
      { phaseRelease: () => () => {}, finish: () => {} },
      "Sync",
    );
    transition();
    const modal = open.mock.instances.at(-1) as unknown as PreviewModal;
    expect(modalButton(modal, "确认修正本地链接").disabled).toBe(false);
    h.plugin.unload();
    expect(off).toHaveBeenCalledOnce();
    f.runtime.invalidate();
    expect(modalButton(modal, "确认修正本地链接").disabled).toBe(true);
    open.mockRestore();
  });
  it("imports 0.2.7 local mappings once and survives reload with local storage gone", async () => {
    const first = await makePlugin({
      data: DEFAULT_SETTINGS,
      legacy: legacyWithMapping,
    });
    await first.plugin.onload();
    expect(first.app.__pluginData).toEqual({
      schemaVersion: 2,
      serverUrl: legacyWithMapping.serverUrl,
      mappings: legacyWithMapping.mappings,
    });

    const second = await makePlugin({
      data: first.app.__pluginData,
      legacy: null,
    });
    await second.plugin.onload();
    expect(second.plugin.settings.mappings).toEqual(
      first.plugin.settings.mappings,
    );
    expect(second.app.__pluginData).toEqual(first.app.__pluginData);
  });

  it("keeps mappings through disable and enable without connection state", async () => {
    const first = await makePlugin({
      data: {
        schemaVersion: 2,
        serverUrl: "https://wiki.example.com",
        mappings: legacyWithMapping.mappings,
      },
    });
    await first.plugin.onload();
    expect(first.plugin.settings.serverInstanceId).toBeNull();

    const enabledAgain = await makePlugin({ data: first.app.__pluginData });
    await enabledAgain.plugin.onload();
    expect(enabledAgain.plugin.settings.mappings).toEqual(
      legacyWithMapping.mappings,
    );
    expect(enabledAgain.plugin.settings.serverInstanceId).toBeNull();
  });

  it("does not let a stale corrupt legacy envelope override valid schema-v2 data", async () => {
    const harness = await makePlugin({
      data: {
        schemaVersion: 2,
        serverUrl: "https://wiki.example.com",
        mappings: legacyWithMapping.mappings,
      },
    });
    harness.local.set("agentwiki-sync:device-settings.json", "{corrupt");

    await expect(harness.plugin.onload()).resolves.toBeUndefined();
    expect(harness.plugin.settings.mappings).toEqual(
      legacyWithMapping.mappings,
    );
  });

  it("uses normalized connection state only at runtime and omits its identity from data.json", async () => {
    const connection: ConnectionState = {
      schemaVersion: 1,
      serverUrl: "https://WIKI.EXAMPLE.com:443/",
      serverInstanceId: "server-instance-1",
      credentialId: "credential-1",
      credentialSecretId: "secret-1",
      deviceId: "11111111-1111-4111-8111-111111111111",
      vaultId: "22222222-2222-4222-8222-222222222222",
    };
    const harness = await makePlugin({
      data: {
        schemaVersion: 2,
        serverUrl: "https://old.example.com",
        mappings: legacyWithMapping.mappings,
      },
      connection,
    });

    await harness.plugin.onload();

    expect(harness.plugin.settings.serverUrl).toBe("https://wiki.example.com");
    expect(harness.plugin.settings.serverInstanceId).toBe("server-instance-1");
    expect(harness.app.__pluginData).toEqual({
      schemaVersion: 2,
      serverUrl: "https://wiki.example.com",
      mappings: legacyWithMapping.mappings,
    });
    expect(JSON.stringify(harness.app.__pluginData)).not.toMatch(
      /serverInstanceId|credentialId|credentialSecretId|deviceId|vaultId/,
    );
  });

  it("saveSettings persists mappings only in Vault data and leaves the legacy envelope read-only", async () => {
    const harness = await makePlugin({
      data: null,
      legacy: legacyWithMapping,
    });
    const before = new Map(harness.local);
    await harness.plugin.onload();
    harness.plugin.settings.mappings = [
      ...harness.plugin.settings.mappings,
      { spaceId: "s2", rootPath: "Second", status: "pending" },
    ];
    harness.plugin.settings.serverInstanceId = "runtime-only";

    await harness.plugin.saveSettings();

    expect(harness.app.__pluginData).toEqual({
      schemaVersion: 2,
      serverUrl: legacyWithMapping.serverUrl,
      mappings: harness.plugin.settings.mappings,
    });
    expect(harness.local).toEqual(before);
  });

  it("collects a read-only protocol label and folder-aware diff fields", async () => {
    const source = await readFile("src/main.ts", "utf8");

    expect(source).toContain("protocolLabel");
    expect(source).toContain("localFoldersAdded");
    expect(source).toContain("localFoldersMoved");
    expect(source).toContain("localFoldersDeleted");
    expect(source).toContain("remoteFoldersUpdated");
    expect(source).toContain("remoteFoldersArchived");
    expect(source).toContain("folderCount");
    expect(source).toContain("pageCount");
  });

  it("discovers Spaces through the negotiated strict v3 remote without touching v1/v2", async () => {
    const connection: ConnectionState = {
      schemaVersion: 1,
      serverUrl: "https://wiki.example.com",
      serverInstanceId: "server-1",
      credentialId: "credential-1",
      credentialSecretId: "secret-1",
      deviceId: "11111111-1111-4111-8111-111111111111",
      vaultId: "22222222-2222-4222-8222-222222222222",
    };
    const harness = await makePlugin({
      data: {
        schemaVersion: 2,
        serverUrl: connection.serverUrl,
        mappings: legacyWithMapping.mappings,
      },
      connection,
    });
    await harness.plugin.onload();
    const capabilityHash = await treeCapabilitiesHashV3(V3_CAPABILITIES);
    const paths: string[] = [];
    requestUrlState.impl = async (request) => {
      const url = new URL((request as { url: string }).url);
      paths.push(url.pathname);
      if (url.pathname === "/api/sync/v3/capabilities")
        return {
          status: 200,
          json: {
            protocolVersion: "3",
            capabilities: V3_CAPABILITIES,
            capabilitiesHash: capabilityHash,
          },
          headers: {},
        };
      if (url.pathname === "/api/sync/v3/spaces")
        return {
          status: 200,
          json: {
            protocolVersion: "3",
            spaces: [
              {
                spaceId: "s1",
                displayName: "Space One",
                role: "owner",
                canRead: true,
                canPublish: true,
                syncMode: "native_v3",
                currentRevision: "r1",
                folderCount: "0",
                pageCount: "0",
                attachmentCount: "0",
                revisionManifestByteLength: "0",
                revisionBodyBytes: "0",
                revisionAttachmentBytes: "0",
              },
            ],
          },
          headers: {},
        };
      throw new Error(`unexpected ${url.pathname}`);
    };

    await expect(harness.plugin.listAccessibleSpaces()).resolves.toMatchObject([
      { spaceId: "s1", displayName: "Space One" },
    ]);
    expect(paths).toEqual(["/api/sync/v3/capabilities", "/api/sync/v3/spaces"]);
    expect(V3TreeRemote).toBeTypeOf("function");
  });

  it("constructs the strict v3 runtime selected by negotiated capabilities", async () => {
    const connection: ConnectionState = {
      schemaVersion: 1,
      serverUrl: "https://wiki.example.com",
      serverInstanceId: "11111111-1111-4111-8111-111111111111",
      credentialId: "22222222-2222-4222-8222-222222222222",
      credentialSecretId: "secret-1",
      deviceId: "33333333-3333-4333-8333-333333333333",
      vaultId: "44444444-4444-4444-8444-444444444444",
    };
    const harness = await makePlugin({
      data: {
        schemaVersion: 2,
        serverUrl: connection.serverUrl,
        mappings: legacyWithMapping.mappings,
      },
      connection,
    });
    harness.adapter.files.set(
      ".agentwiki/vault.json",
      JSON.stringify({ schemaVersion: 1, vaultId: connection.vaultId }),
    );
    const localStore = new ObsidianLocalControlStore(harness.app as never);
    connection.deviceId = await new DeviceStateRepository(
      localStore,
    ).getOrCreateDeviceId();
    await new MutableControlRepository(
      localStore,
      "connection-state.json",
      isConnectionState,
    ).write(connection);
    await harness.plugin.onload();
    const capabilityHash = await treeCapabilitiesHashV3(V3_CAPABILITIES);
    const paths: string[] = [];
    requestUrlState.impl = async (request) => {
      const url = new URL((request as { url: string }).url);
      paths.push(url.pathname);
      if (url.pathname === "/api/integrations/obsidian/session")
        return {
          status: 200,
          json: {
            protocolVersion: "1",
            ...connection,
            deviceName: "Test device",
            createdAt: "2026-09-05T00:00:00.000Z",
            lastUsedAt: "2026-09-05T00:00:00.000Z",
            credentialStatus: "active",
            provisionalExpiresAt: null,
            user: { id: "u1", displayName: "User" },
            capabilities: FakeHttp.capabilities,
          },
          headers: {},
        };
      if (url.pathname === "/api/sync/v3/capabilities")
        return {
          status: 200,
          json: {
            protocolVersion: "3",
            capabilities: V3_CAPABILITIES,
            capabilitiesHash: capabilityHash,
          },
          headers: {},
        };
      if (url.pathname === "/api/sync/v3/spaces")
        return {
          status: 200,
          json: {
            protocolVersion: "3",
            spaces: [
              {
                spaceId: "s1",
                displayName: "Space One",
                role: "owner",
                canRead: true,
                canPublish: true,
                syncMode: "native_v3",
                currentRevision: "r1",
                folderCount: "0",
                pageCount: "0",
                attachmentCount: "0",
                revisionManifestByteLength: "0",
                revisionBodyBytes: "0",
                revisionAttachmentBytes: "0",
              },
            ],
          },
          headers: {},
        };
      throw new Error(`unexpected ${url.pathname}`);
    };
    const subject = harness.plugin as unknown as {
      runtime: (
        mapping: AgentWikiSyncSettings["mappings"][number],
      ) => Promise<{ protocolVersion: "1" | "2" | "3" }>;
    };

    const runtime = await subject.runtime(harness.plugin.settings.mappings[0]!);

    expect(runtime.protocolVersion).toBe("3");
    expect(paths).toEqual([
      "/api/integrations/obsidian/session",
      "/api/sync/v3/capabilities",
      "/api/sync/v3/spaces",
    ]);
  });

  it("collects attachment status and delta through strict v3 getters only", async () => {
    const harness = await makePlugin({
      data: {
        schemaVersion: 2,
        serverUrl: "https://wiki.example.com",
        mappings: legacyWithMapping.mappings,
      },
    });
    await harness.plugin.onload();
    const attachment = {
      attachmentId: "a1",
      path: "assets/local.png",
      mimeType: "image/png" as const,
      sizeBytes: "4096",
      width: 2,
      height: 3,
      contentHash: "a".repeat(64),
      updatedAt: "2026-09-05T00:00:00.000Z",
    };
    const calls: string[] = [];
    const local = {
      foldersAdded: [],
      foldersMoved: [],
      foldersDeleted: [],
      added: [],
      modified: [],
      renamed: [],
      deleted: [],
      ambiguous: [],
      attachmentsAdded: [attachment],
      attachmentsModified: [],
      attachmentsRenamed: [],
      attachmentsDetached: [],
      attachmentBlockers: [],
      attachmentPageCounts: { a1: 1 },
    };
    const runtime = {
      protocolVersion: "3" as const,
      inspectNormalizedPush: async () => null,
      recover: async () => calls.push("recover"),
      status: async () => {
        throw new Error("legacy status must not run");
      },
      remoteDelta: async () => {
        throw new Error("legacy delta must not run");
      },
      statusV3: async () => {
        calls.push("status-v3");
        return {
          protocolVersion: "3" as const,
          baseRevision: "r1",
          remoteRevision: "r2",
          local,
          capabilities: { maxTransferBlobBytes: 100 * 1024 * 1024 },
        };
      },
      remoteDeltaV3: async () => {
        calls.push("delta-v3");
        return {
          protocolVersion: "3" as const,
          baseRevision: "r1",
          remoteRevision: "r2",
          ahead: true,
          listed: true,
          items: [
            {
              operation: "upsert_attachment" as const,
              attachment: {
                ...attachment,
                attachmentId: "a2",
                path: "assets/remote.png",
              },
            },
          ],
          resultingPages: [
            {
              pageId: "remote-page",
              path: "pages/unchanged.md",
              referencedAttachmentIds: ["a2"],
            },
          ],
        };
      },
    };
    const subject = harness.plugin as unknown as {
      runtime: () => Promise<typeof runtime>;
      listAccessibleSpaces: () => Promise<
        Array<{
          spaceId: string;
          displayName: string;
          role: "owner";
          canRead: true;
          canPublish: true;
          currentRevision: string;
          pageCount: string;
          revisionManifestByteLength: string;
          revisionBodyBytes: string;
        }>
      >;
      collectSyncDiff: (
        spaceId: string,
        options: unknown,
      ) => Promise<{
        protocolLabel: string;
        attachmentChanges: {
          uploads: number;
          detached: number;
          uploadBytes: number;
          items: Array<{
            path: string;
            affectedPageCount: number;
          }>;
        };
      }>;
    };
    subject.runtime = async () => runtime;
    subject.listAccessibleSpaces = async () => [
      {
        spaceId: "s1",
        displayName: "Space One",
        role: "owner",
        canRead: true,
        canPublish: true,
        currentRevision: "r2",
        pageCount: "0",
        revisionManifestByteLength: "0",
        revisionBodyBytes: "0",
      },
    ];

    const diff = await subject.collectSyncDiff("s1", {});
    expect(diff.protocolLabel).toBe("Sync v3");
    expect(diff.attachmentChanges).toMatchObject({
      uploads: 1,
      downloads: 1,
      uploadBytes: 4096,
    });
    expect(diff.attachmentChanges.items).toEqual([
      expect.objectContaining({
        path: "assets/local.png",
        affectedPageCount: 1,
      }),
      expect.objectContaining({
        path: "assets/remote.png",
        affectedPageCount: 1,
      }),
    ]);
    expect(calls).toEqual(["recover", "status-v3", "delta-v3"]);
  });

  it("refuses to remove an active mapping with unpublished attachment changes", async () => {
    const harness = await makePlugin({
      data: {
        schemaVersion: 2,
        serverUrl: "https://wiki.example.com",
        mappings: legacyWithMapping.mappings,
      },
    });
    await harness.plugin.onload();
    const runtime = {
      protocolVersion: "3" as const,
      spaceId: "s1",
      recover: async () => undefined,
      statusV3: async () => ({
        protocolVersion: "3" as const,
        baseRevision: "r1",
        remoteRevision: "r1",
        capabilities: { maxTransferBlobBytes: 100 * 1024 * 1024 },
        local: {
          foldersAdded: [],
          foldersMoved: [],
          foldersDeleted: [],
          added: [],
          modified: [],
          renamed: [],
          deleted: [],
          ambiguous: [],
          attachmentsAdded: [{ attachmentId: "a1" }],
          attachmentsModified: [],
          attachmentsRenamed: [],
          attachmentsDetached: [],
          attachmentBlockers: [],
          attachmentPageCounts: { a1: 1 },
        },
      }),
    };
    const subject = harness.plugin as unknown as {
      runtime: () => Promise<typeof runtime>;
    };
    subject.runtime = async () => runtime;

    await expect(harness.plugin.removeMapping("s1")).rejects.toThrow(
      /干净.*远端同步/,
    );
    expect(harness.plugin.settings.mappings).toHaveLength(1);
  });

  it("hands a structured blocked Push preview to the rendered unified modal", async () => {
    const harness = await makePlugin({
      data: {
        schemaVersion: 2,
        serverUrl: "https://wiki.example.com",
        mappings: legacyWithMapping.mappings,
      },
    });
    await harness.plugin.onload();
    const blocked = {
      protocolVersion: "3" as const,
      publishable: false as const,
      spaceId: "s1",
      baseRevision: "r1",
      changes: [] as [],
      blockers: [
        {
          code: "ATTACHMENT_MISSING" as const,
          pagePath: "pages/Missing.md",
          path: "assets/missing.png",
          detail: "not rendered",
        },
      ],
      capabilities: V3_CAPABILITIES,
      capabilitiesHash: "capabilities",
    };
    const runtime = {
      protocolVersion: "3" as const,
      inspectNormalizedPush: async () => null,
      isPushPreviewCurrent: () => false,
      onInvalidate: () => () => {},
      recover: async () => undefined,
      remoteDeltaV3: async () => ({
        protocolVersion: "3" as const,
        baseRevision: "r1",
        remoteRevision: "r1",
        ahead: false,
        listed: false,
        items: [],
        resultingPages: [],
      }),
      previewPushV3: async () => blocked,
      applyPushV3: vi.fn(),
      discardPushPreviewV3: async () => undefined,
    };
    const subject = harness.plugin as unknown as {
      runtime: () => Promise<typeof runtime>;
      runSyncStrategy: (
        spaceId: string,
        strategy: "local",
        options: unknown,
      ) => Promise<ModalTransition | void>;
    };
    subject.runtime = async () => runtime;
    let opened: PreviewModal | null = null;
    const open = vi
      .spyOn(PreviewModal.prototype, "open")
      .mockImplementation(function (this: PreviewModal) {
        this.onOpen();
      });

    const transition = await subject.runSyncStrategy("s1", "local", {});
    transition?.();
    opened = open.mock.instances.at(-1) ?? null;

    const content = (opened as unknown as { contentEl: MockElement }).contentEl;
    expect(content.textContent).toContain("pages/Missing.md");
    const confirm = content.queryAll(
      (item) => item.tag === "button" && item.text === "确认执行",
    )[0]!;
    expect(confirm.disabled).toBe(true);
    confirm.dispatchEvent({ type: "click" });
    expect(runtime.applyPushV3).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("drives the real auto strategy from v3 Pull preview confirmation to a fresh Push preview", async () => {
    const harness = await makePlugin({
      data: {
        schemaVersion: 2,
        serverUrl: "https://wiki.example.com",
        mappings: legacyWithMapping.mappings,
      },
    });
    await harness.plugin.onload();
    const pullPreview = {
      capabilities: V3_CAPABILITIES,
      local: { normalizations: [] },
      blockers: [],
      attachmentConflicts: [],
      attachmentConflictResolutions: {},
      folderConflicts: [],
      folderConflictResolutions: {},
      pageConflicts: [],
      pageConflictResolutions: {},
      actions: [],
    } as unknown as PullPreviewV3;
    const pushPreview = {
      protocolVersion: "3" as const,
      publishable: true as const,
      spaceId: "s1",
      baseRevision: "r1",
      changes: [
        {
          operation: "detach_attachment" as const,
          attachmentId: "a1",
          previousPath: "assets/old.png",
        },
      ],
      capabilities: V3_CAPABILITIES,
      capabilitiesHash: "cap",
      confirmationHash: "confirm",
      blockers: [] as [],
    } as never;
    const calls: string[] = [];
    const runtime = {
      spaceId: "s1",
      protocolVersion: "3" as const,
      inspectNormalizedPush: async () => null,
      isPushPreviewCurrent: () => true,
      onInvalidate: () => () => {},
      recover: async () => calls.push("recover"),
      remoteDeltaV3: async () => {
        calls.push("delta-v3");
        return {
          protocolVersion: "3" as const,
          baseRevision: "r1",
          remoteRevision: "r2",
          ahead: true,
          listed: true,
          items: [],
        };
      },
      previewPullV3: async (_options: unknown, behavior: unknown) => {
        expect(behavior).toBeUndefined();
        calls.push("preview-pull-v3");
        return pullPreview;
      },
      applyPullV3: async (preview: PullPreviewV3) => {
        expect(preview).toBe(pullPreview);
        calls.push("apply-pull-v3");
      },
      discardPullPreviewV3: async () => undefined,
      previewPushV3: async () => {
        calls.push("preview-push-v3");
        return pushPreview;
      },
      applyPushV3: async (preview: unknown) => {
        expect(preview).toBe(pushPreview);
        calls.push("apply-push-v3");
      },
      discardPushPreviewV3: async () => undefined,
    };
    const subject = harness.plugin as unknown as {
      runtime: () => Promise<typeof runtime>;
      runtimeRoutes: WeakMap<
        object,
        { route: "native_v3"; upgrade: null; space: { canPublish: boolean } }
      >;
      runSyncStrategy: (
        spaceId: string,
        strategy: "auto",
        options: unknown,
      ) => Promise<ModalTransition | void>;
    };
    subject.runtime = async () => runtime;
    subject.runtimeRoutes.set(runtime, {
      route: "native_v3",
      upgrade: null,
      space: { canPublish: true },
    });
    let opened: PreviewModal | null = null;
    const open = vi
      .spyOn(PreviewModal.prototype, "open")
      .mockImplementation(function (this: PreviewModal) {
        this.onOpen();
      });

    const pullTransition = await subject.runSyncStrategy("s1", "auto", {});
    expect(pullTransition).toBeTypeOf("function");
    pullTransition?.();
    opened = open.mock.instances.at(-1) ?? null;
    expect((opened as unknown as { preview: unknown } | null)?.preview).toBe(
      pullPreview,
    );
    modalButton(opened!, "确认执行").dispatchEvent({ type: "click" });
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    opened = open.mock.instances.at(-1) ?? null;
    expect((opened as unknown as { preview: unknown } | null)?.preview).toBe(
      pushPreview,
    );
    await expect(subject.runSyncStrategy("s1", "auto", {})).rejects.toThrow(
      /\u6d3b\u8dc3\u64cd\u4f5c/u,
    );
    modalButton(opened!, "确认执行").dispatchEvent({ type: "click" });
    await vi.waitFor(() => expect(calls).toContain("apply-push-v3"));

    expect(calls).toEqual([
      "recover",
      "delta-v3",
      "delta-v3",
      "preview-pull-v3",
      "apply-pull-v3",
      "preview-push-v3",
      "apply-push-v3",
    ]);
    open.mockRestore();
  });

  it("requires separate bootstrap and Pull confirmations before applying v3", async () => {
    const harness = await makePlugin({
      data: {
        schemaVersion: 2,
        serverUrl: "https://wiki.example.com",
        mappings: legacyWithMapping.mappings,
      },
    });
    await harness.plugin.onload();
    const pullPreview = {
      capabilities: V3_CAPABILITIES,
      blockers: [],
      local: { normalizations: [] },
      attachmentConflicts: [],
      attachmentConflictResolutions: {},
      folderConflicts: [],
      folderConflictResolutions: {},
      pageConflicts: [],
      pageConflictResolutions: {},
      actions: [],
    } as unknown as PullPreviewV3;
    const bootstrap = {
      protocolVersion: "3" as const,
      mode: "bootstrap_required" as const,
      baseRevision: "r1",
      candidateHash: "candidate",
      attachmentCount: "1",
      transferBytes: "4096",
      blockers: [],
    };
    const calls: string[] = [];
    const runtime = {
      protocolVersion: "3" as const,
      inspectNormalizedPush: async () => null,
      recover: async () => calls.push("recover"),
      remoteDeltaV3: async () => ({
        protocolVersion: "3" as const,
        baseRevision: "0",
        remoteRevision: "r1",
        ahead: true,
        listed: false,
        items: [],
      }),
      previewPullV3: async () => {
        calls.push("preview-pull-v3");
        throw new Error("V3_BOOTSTRAP_CONFIRMATION_REQUIRED");
      },
      previewBootstrapPullV3: async () => {
        calls.push("preview-bootstrap-v3");
        return bootstrap;
      },
      confirmBootstrapPullV3: async (value: unknown) => {
        expect(value).toBe(bootstrap);
        calls.push("confirm-bootstrap-v3");
        return pullPreview;
      },
      applyPullV3: async (value: unknown) => {
        expect(value).toBe(pullPreview);
        calls.push("apply-pull-v3");
      },
      discardPullPreviewV3: async () => undefined,
    };
    const subject = harness.plugin as unknown as {
      runtime: () => Promise<typeof runtime>;
      runSyncStrategy: (
        spaceId: string,
        strategy: "server",
        options: unknown,
      ) => Promise<ModalTransition | void>;
    };
    subject.runtime = async () => runtime;
    let opened: PreviewModal | null = null;
    const open = vi
      .spyOn(PreviewModal.prototype, "open")
      .mockImplementation(function (this: PreviewModal) {
        this.onOpen();
      });

    const bootstrapTransition = await subject.runSyncStrategy(
      "s1",
      "server",
      {},
    );
    bootstrapTransition?.();
    opened = open.mock.instances.at(-1) ?? null;
    expect((opened as unknown as { preview: unknown } | null)?.preview).toBe(
      bootstrap,
    );
    expect(calls).not.toContain("apply-pull-v3");
    modalButton(opened!, "确认执行").dispatchEvent({ type: "click" });
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    opened = open.mock.instances.at(-1) ?? null;
    expect((opened as unknown as { preview: unknown } | null)?.preview).toBe(
      pullPreview,
    );
    expect(calls).not.toContain("apply-pull-v3");
    modalButton(opened!, "确认执行").dispatchEvent({ type: "click" });
    await vi.waitFor(() => expect(calls).toContain("apply-pull-v3"));
    expect(calls).toEqual([
      "recover",
      "preview-pull-v3",
      "preview-bootstrap-v3",
      "confirm-bootstrap-v3",
      "apply-pull-v3",
    ]);
    open.mockRestore();
  });

  it("routes an explicit same-revision server Pull through a missing-attachment preview and confirmation", async () => {
    const harness = await makePlugin({
      data: {
        schemaVersion: 2,
        serverUrl: "https://wiki.example.com",
        mappings: legacyWithMapping.mappings,
      },
    });
    await harness.plugin.onload();
    const pullPreview = {
      capabilities: V3_CAPABILITIES,
      blockers: [],
      local: { normalizations: [] },
      attachmentConflicts: [],
      attachmentConflictResolutions: {},
      folderConflicts: [],
      folderConflictResolutions: {},
      pageConflicts: [],
      pageConflictResolutions: {},
      actions: [
        {
          kind: "create_attachment" as const,
          source: "remote" as const,
          attachment: {
            attachmentId: "a1",
            path: "assets/image.png",
          },
        },
      ],
      sameRevisionMissingAttachmentIds: ["a1"],
    } as unknown as PullPreviewV3;
    const calls: string[] = [];
    const runtime = {
      protocolVersion: "3" as const,
      inspectNormalizedPush: async () => null,
      recover: async () => calls.push("recover"),
      remoteDeltaV3: async () => {
        calls.push("delta-v3");
        return {
          protocolVersion: "3" as const,
          baseRevision: "r1",
          remoteRevision: "r1",
          ahead: false,
          listed: false,
          items: [],
          resultingPages: [],
        };
      },
      previewPullV3: async (_options: unknown, behavior: unknown) => {
        expect(behavior).toEqual({
          repairSameRevisionMissingRemoteAttachments: true,
        });
        calls.push("preview-pull-v3");
        return pullPreview;
      },
      applyPullV3: async (value: unknown) => {
        expect(value).toBe(pullPreview);
        calls.push("apply-pull-v3");
      },
      discardPullPreviewV3: async () => calls.push("discard-pull-v3"),
    };
    const subject = harness.plugin as unknown as {
      runtime: () => Promise<typeof runtime>;
      runSyncStrategy: (
        spaceId: string,
        strategy: "server",
        options: unknown,
      ) => Promise<ModalTransition | void>;
    };
    subject.runtime = async () => runtime;
    let opened: PreviewModal | null = null;
    const open = vi
      .spyOn(PreviewModal.prototype, "open")
      .mockImplementation(function (this: PreviewModal) {
        this.onOpen();
      });

    const transition = await subject.runSyncStrategy("s1", "server", {});
    expect(transition).toBeTypeOf("function");
    transition?.();
    opened = open.mock.instances.at(-1) ?? null;
    expect((opened as unknown as { preview: unknown } | null)?.preview).toBe(
      pullPreview,
    );
    expect(calls).toEqual(["recover", "delta-v3", "preview-pull-v3"]);
    modalButton(opened!, "确认执行").dispatchEvent({ type: "click" });
    await vi.waitFor(() => expect(calls).toContain("apply-pull-v3"));
    expect(calls).not.toContain("discard-pull-v3");
    open.mockRestore();
  });

  it("keeps an intact explicit same-revision server Pull as a no-op", async () => {
    const harness = await makePlugin({
      data: {
        schemaVersion: 2,
        serverUrl: "https://wiki.example.com",
        mappings: legacyWithMapping.mappings,
      },
    });
    await harness.plugin.onload();
    const calls: string[] = [];
    const runtime = {
      protocolVersion: "3" as const,
      inspectNormalizedPush: async () => null,
      recover: async () => calls.push("recover"),
      remoteDeltaV3: async () => {
        calls.push("delta-v3");
        return {
          protocolVersion: "3" as const,
          baseRevision: "r1",
          remoteRevision: "r1",
          ahead: false,
          listed: false,
          items: [],
          resultingPages: [],
        };
      },
      previewPullV3: async (_options: unknown, behavior: unknown) => {
        expect(behavior).toEqual({
          repairSameRevisionMissingRemoteAttachments: true,
        });
        calls.push("preview-pull-v3");
        return {
          actions: [],
          blockers: [],
          attachmentConflicts: [],
          folderConflicts: [],
          pageConflicts: [],
          sameRevisionMissingAttachmentIds: [],
        } as unknown as PullPreviewV3;
      },
      applyPullV3: async () => calls.push("apply-pull-v3"),
      discardPullPreviewV3: async () => calls.push("discard-pull-v3"),
    };
    const subject = harness.plugin as unknown as {
      runtime: () => Promise<typeof runtime>;
      runSyncStrategy: (
        spaceId: string,
        strategy: "server",
        options: unknown,
      ) => Promise<ModalTransition | void>;
    };
    subject.runtime = async () => runtime;
    const open = vi.spyOn(PreviewModal.prototype, "open");

    await expect(
      subject.runSyncStrategy("s1", "server", {}),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([
      "recover",
      "delta-v3",
      "preview-pull-v3",
      "discard-pull-v3",
    ]);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
});
