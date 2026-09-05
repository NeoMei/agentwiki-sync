import { blobContentHashV3 } from "@neomei/agentwiki-sync-protocol";

export const STAGING_ROOT =
  ".agentwiki/devices/d-local/spaces/s-space/blob-staging";

export async function blobRequirement(bytes: Uint8Array) {
  return {
    contentHash: await blobContentHashV3(bytes),
    sizeBytes: String(bytes.byteLength),
    mimeType: "image/png" as const,
    width: 1,
    height: 1,
  };
}

export const futureExpiry = "2099-09-05T01:00:00.000Z";
export const beforeExpiry = new Date("2026-09-05T00:00:00.000Z");
