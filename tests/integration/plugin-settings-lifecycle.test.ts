import { describe, expect, it } from "vitest";
import AgentWikiSyncPlugin from "../../src/main";
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

const legacyWithMapping: AgentWikiSyncSettings = {
  schemaVersion: 1,
  serverUrl: "https://legacy.example.com",
  serverInstanceId: "legacy-instance-must-not-enter-data-json",
  mappings: [{ spaceId: "s1", rootPath: "AgentWiki", status: "active" }],
};

function memoryAdapter() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  return {
    files,
    exists: async (path: string) => files.has(path) || folders.has(path),
    read: async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    write: async (path: string, value: string) => {
      files.set(path, value);
    },
    remove: async (path: string) => {
      files.delete(path);
      folders.delete(path);
    },
    rename: async (from: string, to: string) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`missing ${from}`);
      files.set(to, value);
      files.delete(from);
    },
    mkdir: async (path: string) => {
      folders.add(path);
    },
    list: async () => ({ files: [], folders: [] }),
  };
}

async function makePlugin(input: {
  data: unknown;
  legacy?: AgentWikiSyncSettings | null;
  connection?: ConnectionState | null;
}) {
  const local = new Map<string, unknown>();
  const adapter = memoryAdapter();
  const app = {
    __pluginData: structuredClone(input.data),
    __savedData: [] as unknown[],
    loadLocalStorage: (key: string) => local.get(key) ?? null,
    saveLocalStorage: (key: string, value: unknown) => {
      if (value === null) local.delete(key);
      else local.set(key, value);
    },
    secretStorage: {
      getSecret: () => null,
      setSecret: () => undefined,
    },
    vault: {
      adapter,
      getName: () => "Test Vault",
      on: () => ({}),
    },
    workspace: {
      getActiveFile: () => null,
      on: () => ({}),
    },
    fileManager: {},
  };
  const localStore = new ObsidianLocalControlStore(app as never);
  if (input.legacy) {
    await new MutableControlRepository(
      localStore,
      "device-settings.json",
      (value): value is AgentWikiSyncSettings =>
        !!value &&
        typeof value === "object" &&
        (value as { schemaVersion?: unknown }).schemaVersion === 1,
    ).write(input.legacy);
  }
  if (input.connection) {
    await new MutableControlRepository(
      localStore,
      "connection-state.json",
      isConnectionState,
    ).write(input.connection);
  }
  const plugin = new AgentWikiSyncPlugin(app as never, {
    id: "agentwiki-sync",
    name: "AgentWiki Sync",
    version: "0.2.8",
    minAppVersion: "1.11.4",
    description: "",
    author: "NeoMei",
  });
  return { plugin, app, local, adapter };
}

describe("plugin settings lifecycle", () => {
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
});
