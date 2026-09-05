import { AgentWikiHttpError } from "../agentwiki/client";
import type { AgentWikiClient } from "../agentwiki/client";
import { capabilitiesHash } from "../agentwiki/protocol";
import {
  TREE_SYNC_V2_LIMITS,
  TreeCapabilitiesResponseV3Schema,
  TreeCapabilitiesResponseV2Schema,
  treeCapabilitiesHashV3,
  type TreeSyncCapabilitiesV3,
  type TreeSyncCapabilitiesV2,
} from "@neomei/agentwiki-sync-protocol";
import type { ProtocolSelectionRepository } from "../storage/protocol-selection";

export type SyncProtocolSelection =
  | {
      version: "3";
      capabilities: TreeSyncCapabilitiesV3;
      capabilitiesHash: string;
    }
  | {
      version: "2";
      capabilities: TreeSyncCapabilitiesV2;
      capabilitiesHash: string;
    }
  | { version: "1"; reason: "endpoint_missing" | "protocol_unsupported" };

export interface ProtocolProbeIdentity {
  serverOrigin: string;
  serverInstanceId: string;
  pluginVersion: string;
}

export class SyncProtocolUpgradeRequiredError extends Error {
  readonly code = "SYNC_PROTOCOL_UPGRADE_REQUIRED" as const;
  constructor(readonly requiredVersion: "2" | "3") {
    super(`Sync protocol ${requiredVersion} is required by local state`);
  }
}

function syncErrorCode(error: unknown): string | null {
  if (!(error instanceof AgentWikiHttpError)) return null;
  const body = error.body;
  if (typeof body !== "object" || body === null) return null;
  const code = (body as { error?: { code?: unknown } }).error?.code;
  return typeof code === "string" ? code : null;
}

function assertDiscoveryResponseSize(value: unknown): void {
  const encoded = JSON.stringify(value);
  if (
    encoded === undefined ||
    new TextEncoder().encode(encoded).byteLength >
      TREE_SYNC_V2_LIMITS.capabilitiesDiscoveryBytes
  )
    throw new Error("Sync capabilities response exceeds discovery size limit");
}

function isExplicitlyUnsupported(error: unknown): boolean {
  if (!(error instanceof AgentWikiHttpError)) return false;
  assertDiscoveryResponseSize(error.body);
  return (
    error.status === 404 ||
    (error.status === 400 && syncErrorCode(error) === "PROTOCOL_UNSUPPORTED")
  );
}

function assertRequiredVersion(
  selection: SyncProtocolSelection,
  requiredVersion: "1" | "2" | "3",
): void {
  if (requiredVersion === "3" && selection.version !== "3")
    throw new SyncProtocolUpgradeRequiredError("3");
  if (requiredVersion === "2" && selection.version === "1")
    throw new SyncProtocolUpgradeRequiredError("2");
}

export class ProtocolNegotiator {
  constructor(
    private readonly client: AgentWikiClient,
    private readonly repository: ProtocolSelectionRepository,
  ) {}

  async select(
    identity: ProtocolProbeIdentity,
    requiredVersion: "1" | "2" | "3" = "1",
  ): Promise<SyncProtocolSelection> {
    const cached = await this.repository.readFor(identity);
    if (cached) {
      assertRequiredVersion(cached, requiredVersion);
      return cached;
    }
    try {
      const response = (
        await this.client.raw("GET", "/api/sync/v3/capabilities")
      ).json;
      assertDiscoveryResponseSize(response);
      const parsed = TreeCapabilitiesResponseV3Schema.parse(response);
      if (
        (await treeCapabilitiesHashV3(parsed.capabilities)) !==
        parsed.capabilitiesHash
      )
        throw new Error("Sync v3 capability hash mismatch");
      const selected = {
        version: "3" as const,
        capabilities: parsed.capabilities,
        capabilitiesHash: parsed.capabilitiesHash,
      };
      await this.repository.write(identity, selected);
      return selected;
    } catch (error) {
      if (!isExplicitlyUnsupported(error)) throw error;
    }
    try {
      const response = (
        await this.client.raw("GET", "/api/sync/v2/capabilities")
      ).json;
      assertDiscoveryResponseSize(response);
      const parsed = TreeCapabilitiesResponseV2Schema.parse(response);
      if (
        (await capabilitiesHash(parsed.capabilities)) !==
        parsed.capabilitiesHash
      )
        throw new Error("Sync v2 capability hash mismatch");
      const selected = {
        version: "2" as const,
        capabilities: parsed.capabilities,
        capabilitiesHash: parsed.capabilitiesHash,
      };
      assertRequiredVersion(selected, requiredVersion);
      await this.repository.write(identity, selected);
      return selected;
    } catch (error) {
      if (!isExplicitlyUnsupported(error)) throw error;
      const code = syncErrorCode(error);
      const selected = {
        version: "1" as const,
        reason:
          code === "PROTOCOL_UNSUPPORTED"
            ? ("protocol_unsupported" as const)
            : ("endpoint_missing" as const),
      };
      assertRequiredVersion(selected, requiredVersion);
      await this.repository.write(identity, selected);
      return selected;
    }
  }
}
