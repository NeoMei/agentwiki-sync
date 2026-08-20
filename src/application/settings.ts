import { validateMappings, type SpaceMapping } from "./sync-coordinator";

export const DEFAULT_SERVER_URL = "https://agentwiki.quukk.com";

export interface AgentWikiSyncSettings {
  schemaVersion: 1;
  serverUrl: string;
  serverInstanceId: string | null;
  mappings: SpaceMapping[];
}

export interface VaultSyncSettings {
  schemaVersion: 2;
  serverUrl: string;
  mappings: SpaceMapping[];
}

export const DEFAULT_SETTINGS: AgentWikiSyncSettings = {
  schemaVersion: 1,
  serverUrl: DEFAULT_SERVER_URL,
  serverInstanceId: null,
  mappings: [],
};

export const DEFAULT_VAULT_SETTINGS: VaultSyncSettings = {
  schemaVersion: 2,
  serverUrl: DEFAULT_SERVER_URL,
  mappings: [],
};

const futureSchemaError = (): Error =>
  new Error("此库使用更新的设置版本；请先更新 AgentWiki Sync");

function cloneMappings(value: unknown): SpaceMapping[] {
  if (!Array.isArray(value)) throw new Error("设置数据无效");
  const mappings = value.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null)
      throw new Error("设置包含无效的空间映射");
    const mapping = candidate as Partial<SpaceMapping>;
    if (
      typeof mapping.spaceId !== "string" ||
      typeof mapping.rootPath !== "string" ||
      (mapping.status !== "pending" && mapping.status !== "active")
    )
      throw new Error("设置包含无效的空间映射");
    return {
      spaceId: mapping.spaceId,
      rootPath: mapping.rootPath,
      status: mapping.status,
    };
  });
  try {
    validateMappings(mappings);
  } catch {
    throw new Error("设置包含无效的空间映射");
  }
  return mappings;
}

function parseLegacySettings(value: unknown): AgentWikiSyncSettings {
  if (typeof value !== "object" || value === null)
    throw new Error("设置数据无效");
  const input = value as Partial<AgentWikiSyncSettings>;
  if (typeof input.schemaVersion === "number" && input.schemaVersion > 1)
    throw futureSchemaError();
  if (
    input.schemaVersion !== 1 ||
    typeof input.serverUrl !== "string" ||
    !(
      typeof input.serverInstanceId === "string" ||
      input.serverInstanceId === null
    )
  )
    throw new Error("设置数据无效");
  return {
    schemaVersion: 1,
    serverUrl: input.serverUrl,
    serverInstanceId: input.serverInstanceId,
    mappings: cloneMappings(input.mappings),
  };
}

export function parseSettings(value: unknown): AgentWikiSyncSettings {
  if (typeof value !== "object" || value === null) return DEFAULT_SETTINGS;
  try {
    return parseLegacySettings(value);
  } catch (error) {
    if (
      typeof (value as { schemaVersion?: unknown }).schemaVersion ===
        "number" ||
      "mappings" in value
    )
      throw error;
    return DEFAULT_SETTINGS;
  }
}

export function parseVaultSettings(value: unknown): VaultSyncSettings {
  if (typeof value !== "object" || value === null)
    throw new Error("设置数据无效");
  const input = value as Partial<VaultSyncSettings>;
  if (typeof input.schemaVersion === "number" && input.schemaVersion > 2)
    throw futureSchemaError();
  if (input.schemaVersion !== 2 || typeof input.serverUrl !== "string")
    throw new Error("设置数据无效");
  return {
    schemaVersion: 2,
    serverUrl: input.serverUrl,
    mappings: cloneMappings(input.mappings),
  };
}

export function toVaultSettings(
  settings: AgentWikiSyncSettings,
): VaultSyncSettings {
  const parsed = parseLegacySettings(settings);
  return {
    schemaVersion: 2,
    serverUrl: parsed.serverUrl,
    mappings: cloneMappings(parsed.mappings),
  };
}

export function migrateVaultSettings(
  stored: unknown,
  legacy: AgentWikiSyncSettings | null,
): VaultSyncSettings {
  if (stored !== null && stored !== undefined) {
    if (typeof stored !== "object") throw new Error("设置数据无效");
    const schemaVersion = (stored as { schemaVersion?: unknown }).schemaVersion;
    if (schemaVersion === 2) return parseVaultSettings(stored);
    if (schemaVersion === 1) {
      const dataJsonSettings = parseLegacySettings(stored);
      return legacy !== null
        ? toVaultSettings(parseLegacySettings(legacy))
        : toVaultSettings(dataJsonSettings);
    }
    if (typeof schemaVersion === "number" && schemaVersion > 2)
      throw futureSchemaError();
    throw new Error("设置数据无效");
  }
  if (legacy !== null) return toVaultSettings(parseLegacySettings(legacy));
  return {
    ...DEFAULT_VAULT_SETTINGS,
    mappings: [],
  };
}
