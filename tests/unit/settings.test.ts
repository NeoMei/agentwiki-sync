import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_URL,
  DEFAULT_SETTINGS,
  migrateVaultSettings,
  parseSettings,
  parseVaultSettings,
  toVaultSettings,
} from "../../src/application/settings";

const legacySettings = {
  schemaVersion: 1 as const,
  serverUrl: "https://wiki.example.com",
  serverInstanceId: "server-secret-adjacent-id",
  mappings: [
    { spaceId: "s1", rootPath: "AgentWiki", status: "active" as const },
  ],
};

const v2Settings = {
  schemaVersion: 2 as const,
  serverUrl: "https://vault.example.com",
  mappings: [
    { spaceId: "s2", rootPath: "Knowledge", status: "pending" as const },
  ],
};

describe("settings defaults", () => {
  it("prefills the official server URL so mobile users do not type it", () => {
    expect(DEFAULT_SETTINGS.serverUrl).toBe(DEFAULT_SERVER_URL);
    expect(DEFAULT_SERVER_URL).toBe("https://agentwiki.quukk.com");
  });

  it("preserves an explicitly saved server URL, including empty self-host pending", () => {
    expect(
      parseSettings({
        schemaVersion: 1,
        serverUrl: "https://self.example.com",
        serverInstanceId: null,
        mappings: [],
      }).serverUrl,
    ).toBe("https://self.example.com");
  });

  it("persists only non-secret Vault settings", () => {
    expect(
      toVaultSettings({
        ...legacySettings,
        credential: "must-not-persist",
        session: { token: "must-not-persist" },
      } as typeof legacySettings & {
        credential: string;
        session: { token: string };
      }),
    ).toEqual({
      schemaVersion: 2,
      serverUrl: "https://wiki.example.com",
      mappings: legacySettings.mappings,
    });
  });

  it("migrates 0.2.7 local mappings when schema-v2 data is absent", () => {
    expect(migrateVaultSettings(null, legacySettings)).toMatchObject({
      schemaVersion: 2,
      mappings: legacySettings.mappings,
    });
  });

  it("migrates schema-v1 data.json before the local envelope", () => {
    expect(migrateVaultSettings(legacySettings, null)).toEqual({
      schemaVersion: 2,
      serverUrl: legacySettings.serverUrl,
      mappings: legacySettings.mappings,
    });
  });

  it("keeps schema-v2 mappings authoritative over an empty local envelope", () => {
    expect(
      migrateVaultSettings(v2Settings, {
        ...legacySettings,
        mappings: [],
      }).mappings,
    ).toEqual(v2Settings.mappings);
  });

  it("throws for invalid mappings instead of resetting them", () => {
    expect(() =>
      parseVaultSettings({
        ...v2Settings,
        mappings: [{ spaceId: "s2", rootPath: "../escape", status: "active" }],
      }),
    ).toThrow(/无效的空间映射/);
    expect(() =>
      migrateVaultSettings(
        { ...v2Settings, mappings: "not-an-array" },
        legacySettings,
      ),
    ).toThrow(/设置/);
  });

  it("freezes startup for future Vault schema versions", () => {
    expect(() =>
      migrateVaultSettings(
        { schemaVersion: 3, serverUrl: "", mappings: [] },
        legacySettings,
      ),
    ).toThrow(/更新的设置版本/);
  });

  it("does not silently turn malformed present data into empty mappings", () => {
    expect(() =>
      migrateVaultSettings(
        { schemaVersion: 1, serverUrl: "https://wiki.example.com" },
        legacySettings,
      ),
    ).toThrow(/设置/);
    expect(() =>
      migrateVaultSettings({ broken: true }, legacySettings),
    ).toThrow(/设置/);
  });

  it("clones mappings before normalization", () => {
    const stored = {
      ...v2Settings,
      mappings: [
        { spaceId: "s2", rootPath: "Cafe\u0301", status: "pending" as const },
      ],
    };
    const migrated = migrateVaultSettings(stored, null);
    expect(migrated.mappings[0]?.rootPath).toBe("Café");
    expect(stored.mappings[0]?.rootPath).toBe("Cafe\u0301");
  });
});
