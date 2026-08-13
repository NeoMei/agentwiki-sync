import { describe, expect, it } from "vitest";
import {
  partitionPushChanges,
  type PushChange,
  type SyncCapabilities,
} from "../../src/agentwiki/protocol";

const capabilities: SyncCapabilities = {
  maxPageBytes: 1_048_576,
  maxBatchBytes: 1_048_576,
  maxBatchItems: 2,
  maxChangeCount: 5_000,
  maxConfirmationBytes: 4_194_304,
  maxClientSpacePages: 5_000,
  maxClientManifestBytes: 4_194_304,
  maxClientTotalBodyBytes: 104_857_600,
  maxResponseBytes: 4_194_304,
  maxPageItems: 200,
  pushSessionTtlSeconds: 900,
};

describe("partitionPushChanges", () => {
  it("uses deterministic ordering and both item and byte limits", async () => {
    const changes: PushChange[] = ["c", "a", "b"].map((pageId) => ({
      operation: "archive",
      pageId,
      previousPath: `${pageId}.md`,
    }));
    const batches = await partitionPushChanges(changes, capabilities);
    expect(
      batches.map((batch) => batch.changes.map((change) => change.pageId)),
    ).toEqual([["a", "b"], ["c"]]);
    expect(batches.map((batch) => batch.batchIndex)).toEqual([0, 1]);
  });

  it("rejects a single change that cannot fit a legal batch", async () => {
    const body = "x".repeat(1_048_577);
    await expect(
      partitionPushChanges(
        [
          {
            operation: "upsert",
            pageId: "a",
            path: "a.md",
            title: "a",
            body,
            contentHash: "0".repeat(64),
          },
        ],
        capabilities,
      ),
    ).rejects.toThrow(/PAGE_TOO_LARGE/);
  });
});
