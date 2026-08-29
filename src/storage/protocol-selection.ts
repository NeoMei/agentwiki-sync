import { TreeSyncCapabilitiesV2Schema } from "@neomei/agentwiki-sync-protocol";
import type {
  ProtocolProbeIdentity,
  SyncProtocolSelection,
} from "../application/protocol-negotiator";
import type { ControlStorePort } from "../ports/control-store";
import { MutableControlRepository } from "./envelope";

const CONTROL_PATH = "protocol-selection.json";

interface ProtocolSelectionRecord {
  schemaVersion: number;
  serverOrigin: string;
  serverInstanceId: string;
  pluginVersion: string;
  selection: SyncProtocolSelection;
}

function isSyncProtocolSelection(
  value: unknown,
): value is SyncProtocolSelection {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (item.version === "2") {
    return (
      typeof item.capabilitiesHash === "string" &&
      TreeSyncCapabilitiesV2Schema.safeParse(item.capabilities).success
    );
  }
  if (item.version === "1") {
    return (
      item.reason === "endpoint_missing" ||
      item.reason === "protocol_unsupported"
    );
  }
  return false;
}

function isProtocolSelectionRecord(
  value: unknown,
): value is ProtocolSelectionRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.schemaVersion === "number" &&
    Number.isInteger(item.schemaVersion) &&
    item.schemaVersion >= 1 &&
    typeof item.serverOrigin === "string" &&
    typeof item.serverInstanceId === "string" &&
    typeof item.pluginVersion === "string" &&
    isSyncProtocolSelection(item.selection)
  );
}

export class ProtocolSelectionRepository {
  private readonly repository: MutableControlRepository<ProtocolSelectionRecord>;
  constructor(store: ControlStorePort) {
    this.repository = new MutableControlRepository(
      store,
      CONTROL_PATH,
      isProtocolSelectionRecord,
    );
  }

  async readFor(
    identity: ProtocolProbeIdentity,
  ): Promise<SyncProtocolSelection | null> {
    const envelope = await this.repository.read();
    const record = envelope?.payload ?? null;
    if (!record) return null;
    if (record.schemaVersion !== 1)
      throw new Error("不支持同步协议选择存储版本");
    if (
      record.serverOrigin !== identity.serverOrigin ||
      record.serverInstanceId !== identity.serverInstanceId ||
      record.pluginVersion !== identity.pluginVersion
    )
      return null;
    return record.selection;
  }

  async write(
    identity: ProtocolProbeIdentity,
    selection: SyncProtocolSelection,
  ): Promise<void> {
    await this.repository.write({
      schemaVersion: 1,
      serverOrigin: identity.serverOrigin,
      serverInstanceId: identity.serverInstanceId,
      pluginVersion: identity.pluginVersion,
      selection,
    });
  }
}
