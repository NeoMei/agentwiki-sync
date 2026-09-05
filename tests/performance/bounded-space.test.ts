import { describe, expect, it } from "vitest";
import { memoryUsage } from "node:process";
import {
  TREE_SYNC_V2_LIMITS,
  TreeCapabilitiesResponseV2Schema,
  partitionTreePushChangesV2,
  treeCapabilitiesHashV3,
  treeConfirmationHashV3,
  type TreeSyncCapabilitiesV2,
} from "@neomei/agentwiki-sync-protocol";
import { AgentWikiClient } from "../../src/agentwiki/client";
import { V2TreeRemote } from "../../src/agentwiki/v2-tree-remote";
import {
  partitionPushChanges,
  type PushChange,
} from "../../src/agentwiki/protocol";
import type { TreeSnapshot } from "../../src/core/tree-model";
import { scanLocalTree, type TreeScanLimits } from "../../src/core/tree-scan";
import { scanMapping } from "../../src/core/status";
import { emptyTreeIdentityState } from "../../src/storage/tree-identities";
import { FakeHttp } from "../fakes/fake-http";
import { MemoryVault } from "../fakes/memory-vault";
import { MemoryControlStore } from "../fakes/memory-control-store";
import {
  TreePushServiceV3,
  type PreparedTreePushChangeV3,
} from "../../src/application/tree-push-service-v3";
import { FakeTreeRemoteV3, V3_CAPABILITIES } from "../fakes/fake-tree-remote";

describe("bounded v1 space", () => {
  it("streams 5,000 metadata entries and deterministically partitions 5,000 changes", async () => {
    const files = Array.from({ length: 5_000 }, (_, index) => ({
      relativePath: `p${String(index).padStart(4, "0")}.md`,
      bytes: new TextEncoder().encode(`page ${index}`),
    }));
    const scan = await scanMapping(files, {
      complete: true,
      scanEpoch: 1,
      capabilities: {
        pages: 5_000,
        bodyBytes: 104_857_600,
        manifestBytes: 4_194_304,
      },
    });
    expect(scan.files).toHaveLength(5_000);
    const changes: PushChange[] = scan.files.map((file, index) => ({
      operation: "archive",
      pageId: `p${index}`,
      previousPath: file.relativePath,
    }));
    const batches = await partitionPushChanges(changes, {
      maxPageBytes: 1048576,
      maxBatchBytes: 4194304,
      maxBatchItems: 100,
      maxChangeCount: 5000,
      maxConfirmationBytes: 4194304,
      maxClientSpacePages: 5000,
      maxClientManifestBytes: 4194304,
      maxClientTotalBodyBytes: 104857600,
      maxResponseBytes: 4194304,
      maxPageItems: 200,
      pushSessionTtlSeconds: 900,
    });
    expect(batches).toHaveLength(50);
  }, 30_000);

  it("processes a near-100MiB space within a bounded heap delta", async () => {
    const body = "x".repeat(20_000);
    async function* files() {
      for (let index = 0; index < 5_000; index += 1)
        yield {
          relativePath: `b${String(index).padStart(4, "0")}.md`,
          bytes: new TextEncoder().encode(body),
        };
    }
    globalThis.gc?.();
    const before = memoryUsage().heapUsed;
    const scan = await scanMapping(files(), {
      complete: true,
      scanEpoch: 1,
      retainBodies: false,
      capabilities: {
        pages: 5_000,
        bodyBytes: 104_857_600,
        manifestBytes: 4_194_304,
      },
    });
    globalThis.gc?.();
    const delta = memoryUsage().heapUsed - before;
    expect(scan.bodyBytes).toBe(100_000_000);
    if (globalThis.gc) expect(delta).toBeLessThan(32 * 1024 * 1024);
  }, 60_000);
});

describe("bounded strict-v3 push", () => {
  it("journals the negotiated 100-attachment change bound without reading image bytes before create", async () => {
    const capabilities = {
      ...V3_CAPABILITIES,
      maxRevisionAttachments: 1_000,
    };
    const remote = new FakeTreeRemoteV3();
    remote.setCapabilities(capabilities);
    const control = new MemoryControlStore();
    let largestJournalWrite = 0;
    control.onTextWrite = (path) => {
      if (path.endsWith("/journal.json.next"))
        largestJournalWrite = Math.max(
          largestJournalWrite,
          control.files.get(path)?.length ?? 0,
        );
    };
    const changes: PreparedTreePushChangeV3[] = Array.from(
      { length: capabilities.maxChangeCount },
      (_, index) => {
        const suffix = String(index).padStart(12, "0");
        return {
          operation: "upsert_attachment" as const,
          attachment: {
            attachmentId: `00000000-0000-4000-8000-${suffix}`,
            path: `assets/image-${suffix}.png`,
            mimeType: "image/png" as const,
            sizeBytes: "1",
            width: 1,
            height: 1,
            contentHash: index.toString(16).padStart(64, "0"),
            updatedAt: "2026-09-06T00:00:00.000Z",
          },
          vaultPath: `Wiki/assets/image-${suffix}.png`,
        };
      },
    );
    const capabilitiesHash = await treeCapabilitiesHashV3(capabilities);
    const confirmationHash = await treeConfirmationHashV3({
      protocolVersion: "3",
      spaceId: "space",
      baseRevision: "rev-3",
      capabilitiesHash,
      changes: changes.map((change) => {
        if (change.operation !== "upsert_attachment")
          throw new Error("fixture");
        return {
          operation: change.operation,
          attachment: change.attachment,
        };
      }),
    });
    const controller = new AbortController();
    controller.abort();
    let reads = 0;
    const service = new TreePushServiceV3(
      remote,
      control,
      ".agentwiki/perf-v3",
      {
        readBlob: async () => {
          reads += 1;
          return null;
        },
        revalidateConfirmation: async () => confirmationHash,
      },
    );

    await expect(
      service.publishPrepared(
        {
          protocolVersion: "3",
          spaceId: "space",
          baseRevision: "rev-3",
          capabilities,
          capabilitiesHash,
          confirmationHash,
          changes,
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/取消/);
    expect(reads).toBe(0);
    expect(remote.createInputs).toHaveLength(0);
    expect(largestJournalWrite).toBeLessThan(2 * 1024 * 1024);
  });
});

const v2Capabilities: TreeSyncCapabilitiesV2 = {
  maxPageBytes: 1_048_576,
  maxBatchBytes: 4_194_304,
  maxBatchItems: 100,
  maxChangeCount: 100,
  maxConfirmationBytes: 4_194_304,
  maxClientSpacePages: 5_000,
  maxClientSpaceFolders: 10_000,
  maxSnapshotObjects: 15_000,
  maxClientManifestBytes: 4_194_304,
  maxClientTotalBodyBytes: 2_097_152,
  maxDeltaItems: 15_000,
  maxResponseBytes: 4_194_304,
  maxPageItems: 200,
  pushSessionTtlSeconds: 900,
};

function client(http: FakeHttp): AgentWikiClient {
  return new AgentWikiClient("https://wiki.example.com", http, () => "secret");
}

function v2Remote(http: FakeHttp): V2TreeRemote {
  return new V2TreeRemote(client(http), "space", {
    version: "2",
    capabilities: v2Capabilities,
    capabilitiesHash: "c".repeat(64),
  });
}

function v2SnapshotPage(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: "2",
    spaceId: "space",
    revision: "r1",
    sequence: 1,
    revisionContentHash: "e".repeat(64),
    folderCount: "0",
    pageCount: "0",
    revisionManifestByteLength: "10",
    revisionBodyBytes: "0",
    folders: [],
    pages: [],
    nextCursor: null,
    ...overrides,
  };
}

describe("bounded v2 tree", () => {
  it("rejects a scan that would retain more folders than maxClientSpaceFolders", async () => {
    const vault = new MemoryVault({});
    for (
      let index = 0;
      index <= TREE_SYNC_V2_LIMITS.maxClientSpaceFolders;
      index += 1
    )
      await vault.createDirectory(
        `Wiki/pages/f${String(index).padStart(5, "0")}`,
      );
    const limits: TreeScanLimits = {
      maxFolders: TREE_SYNC_V2_LIMITS.maxClientSpaceFolders,
      maxPages: 100_000,
      maxPageBytes: 100_000_000,
    };
    await expect(
      scanLocalTree(
        vault,
        "Wiki",
        {
          protocolVersion: "2",
          spaceId: "space",
          revision: "0",
          revisionContentHash: "",
          folders: [],
          pages: [],
        } satisfies TreeSnapshot,
        emptyTreeIdentityState(),
        limits,
      ),
    ).rejects.toThrow(/SPACE_TOO_LARGE/);
  }, 60_000);

  it("rejects a snapshot that exceeds maxSnapshotObjects", async () => {
    const http = new FakeHttp();
    http.responses.push({
      status: 200,
      json: v2SnapshotPage({
        folderCount: String(TREE_SYNC_V2_LIMITS.maxSnapshotObjects + 1),
        pageCount: "0",
      }),
    });
    await expect(
      v2Remote(http).snapshotPages()[Symbol.asyncIterator]().next(),
    ).rejects.toThrow(/快照对象数量超过限制/);
  });

  it("rejects a snapshot that exceeds maxDocumentTreeBytes", async () => {
    const http = new FakeHttp();
    http.responses.push({
      status: 200,
      json: v2SnapshotPage({
        revisionManifestByteLength: String(
          TREE_SYNC_V2_LIMITS.maxDocumentTreeBytes + 1,
        ),
        revisionBodyBytes: "0",
      }),
    });
    await expect(
      v2Remote(http).snapshotPages()[Symbol.asyncIterator]().next(),
    ).rejects.toThrow(/快照字节数超过限制/);
  });

  it("rejects a delta that exceeds maxDeltaItems", async () => {
    const http = new FakeHttp();
    const items = Array.from(
      { length: TREE_SYNC_V2_LIMITS.maxDeltaItems + 1 },
      (_, index) => ({
        operation: "archive_page",
        pageId: `p${index}`,
        previousPath: "pages/Old.md",
      }),
    );
    http.responses.push({
      status: 200,
      json: {
        protocolVersion: "2",
        spaceId: "space",
        fromRevision: "r0",
        toRevision: "r1",
        toSequence: 1,
        toRevisionContentHash: "a".repeat(64),
        toFolderCount: "0",
        toPageCount: "0",
        toRevisionManifestByteLength: "10",
        toRevisionBodyBytes: "0",
        items,
        nextCursor: null,
      },
    });
    await expect(v2Remote(http).delta("r0")).rejects.toThrow(
      /增量条目数量超过限制/,
    );
  });

  it("rejects more than maxPushChanges in a v2 push partition", async () => {
    const changes = Array.from(
      { length: TREE_SYNC_V2_LIMITS.maxPushChanges + 1 },
      (_, index) => ({
        operation: "archive_page" as const,
        pageId: `p${index}`,
        previousPath: "pages/Old.md",
      }),
    );
    await expect(
      partitionTreePushChangesV2(changes, v2Capabilities),
    ).rejects.toThrow(/BATCH_TOO_LARGE/);
  });

  it("rejects v2 capabilities advertising maxResponseBytes above the protocol bound", () => {
    expect(() =>
      TreeCapabilitiesResponseV2Schema.parse({
        protocolVersion: "2",
        capabilities: {
          ...v2Capabilities,
          maxResponseBytes: TREE_SYNC_V2_LIMITS.maxResponseBytes + 1,
        },
        capabilitiesHash: "c".repeat(64),
      }),
    ).toThrow();
  });
});
