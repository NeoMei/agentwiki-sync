import { canonicalBytes, comparePushChanges } from "./canonical";
import { batchHash } from "./hash";
import type { PushBatch, PushChange, SyncCapabilities } from "./types";

const encoder = new TextEncoder();

function pageBodyBytes(change: PushChange): number {
  return change.operation === "upsert"
    ? encoder.encode(change.body.replace(/\r\n?/g, "\n")).byteLength
    : 0;
}

async function materializeBatch(
  batchIndex: number,
  changes: PushChange[],
): Promise<PushBatch> {
  const withoutHash = { protocolVersion: "1" as const, batchIndex, changes };
  return { ...withoutHash, batchHash: await batchHash(withoutHash) };
}

export async function partitionPushChanges(
  changes: PushChange[],
  capabilities: SyncCapabilities,
): Promise<PushBatch[]> {
  if (changes.length > capabilities.maxChangeCount)
    throw new RangeError("BATCH_TOO_LARGE");
  const sorted = [...changes].sort(comparePushChanges);
  const batches: PushBatch[] = [];
  let current: PushChange[] = [];
  for (const change of sorted) {
    if (pageBodyBytes(change) > capabilities.maxPageBytes)
      throw new RangeError("PAGE_TOO_LARGE");
    const proposed = [...current, change];
    const batch = await materializeBatch(batches.length, proposed);
    const exceeds =
      proposed.length > capabilities.maxBatchItems ||
      canonicalBytes(batch).byteLength > capabilities.maxBatchBytes;
    if (exceeds && current.length === 0)
      throw new RangeError("BATCH_TOO_LARGE");
    if (exceeds) {
      batches.push(await materializeBatch(batches.length, current));
      current = [change];
      const single = await materializeBatch(batches.length, current);
      if (canonicalBytes(single).byteLength > capabilities.maxBatchBytes)
        throw new RangeError("BATCH_TOO_LARGE");
    } else {
      current = proposed;
    }
  }
  if (current.length > 0)
    batches.push(await materializeBatch(batches.length, current));
  return batches;
}
