export type SpaceSyncRoute =
  "legacy" | "native_v3" | "bootstrap" | "upgrade" | "recover_upgrade";

export function selectSpaceSyncRoute(input: {
  serverVersion: "1" | "2" | "3";
  syncMode: "legacy_v2" | "bootstrap_required" | "native_v3" | null;
  requiredVersion: "1" | "2" | "3";
  pendingUpgrade: boolean;
  localImageCandidate: boolean;
  remoteImageCandidate: boolean;
}): SpaceSyncRoute {
  if (input.pendingUpgrade) return "recover_upgrade";
  if (input.serverVersion !== "3") {
    if (
      input.requiredVersion === "3" ||
      input.localImageCandidate ||
      input.remoteImageCandidate
    )
      throw new Error("SYNC_PROTOCOL_UPGRADE_REQUIRED");
    return "legacy";
  }
  if (input.syncMode === "native_v3") return "native_v3";
  if (input.requiredVersion === "3")
    throw new Error("SPACE_PROTOCOL_INCONSISTENT");
  if (input.syncMode === "bootstrap_required") return "bootstrap";
  if (input.syncMode !== "legacy_v2") throw new Error("SPACE_MODE_INVALID");
  if (input.remoteImageCandidate)
    throw new Error("SPACE_MODE_REFRESH_REQUIRED");
  return input.localImageCandidate ? "upgrade" : "legacy";
}
