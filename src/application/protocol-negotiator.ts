import { AgentWikiHttpError } from "../agentwiki/client";
import type { AgentWikiClient } from "../agentwiki/client";
import { capabilitiesHash } from "../agentwiki/protocol";
import {
  TreeCapabilitiesResponseV2Schema,
  type TreeSyncCapabilitiesV2,
} from "@neomei/agentwiki-sync-protocol";
import type { ProtocolSelectionRepository } from "../storage/protocol-selection";

export type SyncProtocolSelection =
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

function syncErrorCode(error: unknown): string | null {
  if (!(error instanceof AgentWikiHttpError)) return null;
  const body = error.body;
  if (typeof body !== "object" || body === null) return null;
  const code = (body as { error?: { code?: unknown } }).error?.code;
  return typeof code === "string" ? code : null;
}

export class ProtocolNegotiator {
  constructor(
    private readonly client: AgentWikiClient,
    private readonly repository: ProtocolSelectionRepository,
  ) {}

  async select(
    identity: ProtocolProbeIdentity,
  ): Promise<SyncProtocolSelection> {
    const cached = await this.repository.readFor(identity);
    if (cached) return cached;
    try {
      const parsed = TreeCapabilitiesResponseV2Schema.parse(
        (await this.client.raw("GET", "/api/sync/v2/capabilities")).json,
      );
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
      await this.repository.write(identity, selected);
      return selected;
    } catch (error) {
      const code = syncErrorCode(error);
      if (
        !(error instanceof AgentWikiHttpError) ||
        !(error.status === 404 || code === "PROTOCOL_UNSUPPORTED")
      )
        throw error;
      const selected = {
        version: "1" as const,
        reason:
          code === "PROTOCOL_UNSUPPORTED"
            ? ("protocol_unsupported" as const)
            : ("endpoint_missing" as const),
      };
      await this.repository.write(identity, selected);
      return selected;
    }
  }
}
