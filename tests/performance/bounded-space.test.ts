import { describe, expect, it } from "vitest";
import { partitionPushChanges, type PushChange } from "../../src/agentwiki/protocol";
import { scanMapping } from "../../src/core/status";

describe("bounded v1 space", () => {
  it("streams 5,000 metadata entries and deterministically partitions 5,000 changes", async () => {
    const files = Array.from({ length: 5_000 }, (_, index) => ({ relativePath: `p${String(index).padStart(4, "0")}.md`, bytes: new TextEncoder().encode(`page ${index}`) }));
    const scan = await scanMapping(files, { complete: true, scanEpoch: 1, capabilities: { pages: 5_000, bodyBytes: 104_857_600, manifestBytes: 4_194_304 } });
    expect(scan.files).toHaveLength(5_000);
    const changes: PushChange[] = scan.files.map((file, index) => ({ operation: "archive", pageId: `p${index}`, previousPath: file.relativePath }));
    const batches = await partitionPushChanges(changes, { maxPageBytes: 1048576, maxBatchBytes: 4194304, maxBatchItems: 100, maxChangeCount: 5000, maxConfirmationBytes: 4194304, maxClientSpacePages: 5000, maxClientManifestBytes: 4194304, maxClientTotalBodyBytes: 104857600, maxResponseBytes: 4194304, maxPageItems: 200, pushSessionTtlSeconds: 900 });
    expect(batches).toHaveLength(50);
  }, 30_000);
});
