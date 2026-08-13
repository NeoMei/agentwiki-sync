import type { SpaceMapping } from "./sync-coordinator";

export interface AgentWikiSyncSettings {
  schemaVersion: 1;
  serverUrl: string;
  serverInstanceId: string | null;
  mappings: SpaceMapping[];
}

export const DEFAULT_SETTINGS: AgentWikiSyncSettings = { schemaVersion: 1, serverUrl: "", serverInstanceId: null, mappings: [] };

export function parseSettings(value: unknown): AgentWikiSyncSettings {
  if (typeof value !== "object" || value === null) return DEFAULT_SETTINGS;
  const input = value as Partial<AgentWikiSyncSettings>;
  if(typeof input.schemaVersion==="number"&&input.schemaVersion>1)throw new Error("This Vault uses a newer settings version; update AgentWiki Sync before continuing");
  if (input.schemaVersion !== 1 || typeof input.serverUrl !== "string" || !(typeof input.serverInstanceId === "string" || input.serverInstanceId === null) || !Array.isArray(input.mappings)) return DEFAULT_SETTINGS;
  return { schemaVersion: 1, serverUrl: input.serverUrl, serverInstanceId: input.serverInstanceId, mappings: input.mappings };
}
