import { describe, expect, it } from "vitest";
import {
  canonicalBytes,
  blobChunkHashV3,
  blobContentHashV3,
  treeCapabilitiesHashV3,
  treeRevisionContentHashV3,
  type TreeSyncCapabilitiesV3,
} from "@neomei/agentwiki-sync-protocol";

import { AgentWikiClient } from "../../src/agentwiki/client";
import { V3TreeRemote } from "../../src/agentwiki/v3-tree-remote";
import { FakeHttp } from "../fakes/fake-http";

const capabilities: TreeSyncCapabilitiesV3 = {
  maxPageBytes: 1024 * 1024,
  maxBatchBytes: 4 * 1024 * 1024,
  maxBatchItems: 100,
  maxChangeCount: 100,
  maxConfirmationBytes: 4 * 1024 * 1024,
  maxClientSpacePages: 5000,
  maxClientSpaceFolders: 5000,
  maxSnapshotObjects: 10_000,
  maxClientManifestBytes: 4 * 1024 * 1024,
  maxClientTotalBodyBytes: 2 * 1024 * 1024,
  maxDeltaItems: 5000,
  maxResponseBytes: 4 * 1024 * 1024,
  maxPageItems: 200,
  pushSessionTtlSeconds: 900,
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxRevisionAttachments: 1000,
  maxTransferBlobBytes: 100 * 1024 * 1024,
  blobChunkBytes: 1024 * 1024,
  maxBlobChunks: 10,
  maxConcurrentBlobs: 2,
  maxImageDimension: 10_000,
  maxDecodedPixels: 40_000_000,
  allowedMimeTypes: ["image/gif", "image/jpeg", "image/png", "image/webp"],
  blobStagingTtlSeconds: 900,
  downloadAuthorizationTtlSeconds: 300,
};

const folder = {
  folderId: "folder-1",
  parentFolderId: null,
  path: "pages/Guide",
  name: "Guide",
  sortOrder: 0,
  updatedAt: "2026-09-05T00:00:00.000Z",
};
const page = {
  pageId: "page-1",
  folderId: "folder-1",
  path: "pages/Guide/Start.md",
  title: "Start",
  body: "hello\n",
  contentHash:
    "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
  updatedAt: "2026-09-05T00:00:00.000Z",
  referencedAttachmentIds: [],
};

async function snapshotMetadata(revision = "revision-1") {
  const manifest = {
    protocolVersion: "3" as const,
    spaceId: "space-1",
    folders: [folder],
    pages: [page],
    attachments: [],
  };
  return {
    protocolVersion: "3" as const,
    spaceId: "space-1",
    revision,
    sequence: 1,
    revisionContentHash: await treeRevisionContentHashV3(manifest),
    folderCount: "1",
    pageCount: "1",
    attachmentCount: "0",
    revisionManifestByteLength: String(canonicalBytes(manifest).byteLength),
    revisionBodyBytes: "6",
    revisionAttachmentBytes: "0",
  };
}

async function remoteWith(http: FakeHttp): Promise<V3TreeRemote> {
  return new V3TreeRemote(
    new AgentWikiClient("https://wiki.example.com", http, () => "secret"),
    "space-1",
    {
      version: "3",
      capabilities,
      capabilitiesHash: await treeCapabilitiesHashV3(capabilities),
    },
    { sleep: async () => undefined },
  );
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

describe("V3TreeRemote", () => {
  it("pins current snapshots and verifies their complete revision hash", async () => {
    const http = new FakeHttp();
    const metadata = await snapshotMetadata();
    http.enqueue({
      status: 200,
      json: {
        ...metadata,
        folders: [folder],
        pages: [],
        attachments: [],
        nextCursor: "next-1",
      },
    });
    http.enqueue({
      status: 200,
      json: {
        ...metadata,
        folders: [],
        pages: [page],
        attachments: [],
        nextCursor: null,
      },
    });

    await expect(
      collect((await remoteWith(http)).snapshotPages()),
    ).resolves.toHaveLength(2);
    expect(http.calls[0]?.path).toContain("revision=current");
    expect(http.calls[1]?.path).toContain("revision=revision-1");
  });

  it("rejects snapshot pages that change revision metadata", async () => {
    const http = new FakeHttp();
    const first = await snapshotMetadata("revision-1");
    const second = await snapshotMetadata("revision-2");
    http.enqueue({
      status: 200,
      json: {
        ...first,
        folders: [folder],
        pages: [],
        attachments: [],
        nextCursor: "next",
      },
    });
    http.enqueue({
      status: 200,
      json: {
        ...second,
        folders: [],
        pages: [page],
        attachments: [],
        nextCursor: null,
      },
    });

    await expect(
      collect((await remoteWith(http)).snapshotPages("revision-1")),
    ).rejects.toThrow("SNAPSHOT_METADATA_CHANGED");
  });

  it("rejects unknown response fields before accepting a v3 page", async () => {
    const http = new FakeHttp();
    const metadata = await snapshotMetadata();
    http.enqueue({
      status: 200,
      json: {
        ...metadata,
        folders: [folder],
        pages: [page],
        attachments: [],
        nextCursor: null,
        leaked: "no",
      },
    });
    await expect(
      collect((await remoteWith(http)).snapshotPages("revision-1")),
    ).rejects.toThrow();
  });

  it("rejects repeated entities and cursors deterministically", async () => {
    const http = new FakeHttp();
    const metadata = await snapshotMetadata();
    http.enqueue({
      status: 200,
      json: {
        ...metadata,
        folders: [folder],
        pages: [],
        attachments: [],
        nextCursor: "same",
      },
    });
    http.enqueue({
      status: 200,
      json: {
        ...metadata,
        folders: [folder],
        pages: [page],
        attachments: [],
        nextCursor: "same",
      },
    });
    await expect(
      collect((await remoteWith(http)).snapshotPages("revision-1")),
    ).rejects.toThrow(/SNAPSHOT_ENTITY_REPEATED|CURSOR_REPEATED/);
  });

  it("uses bounded JSON mode for real v3 capability discovery", async () => {
    const http = new FakeHttp();
    http.enqueue({
      status: 200,
      json: {
        protocolVersion: "3",
        capabilities,
        capabilitiesHash: await treeCapabilitiesHashV3(capabilities),
      },
    });
    const client = new AgentWikiClient(
      "https://wiki.example.com",
      http,
      () => "secret",
    );
    await client.boundedJson("GET", "/api/sync/v3/capabilities", 64 * 1024);
    expect(http.calls[0]).toMatchObject({
      responseType: "bounded-json",
      maxResponseBytes: 64 * 1024,
    });
  });

  it("uploads Blob chunks as raw bytes and validates the bound receipt", async () => {
    const http = new FakeHttp();
    const bytes = new Uint8Array([0, 255, 1]);
    const contentHash = await blobContentHashV3(bytes);
    http.enqueue({
      status: 200,
      json: {
        contentHash,
        chunkIndex: 0,
        chunkHash: await blobChunkHashV3(bytes),
        receipt: "receipt-1",
      },
    });
    await expect(
      (await remoteWith(http)).uploadBlobChunk(
        "11111111-1111-4111-8111-111111111111",
        contentHash,
        0,
        bytes,
      ),
    ).resolves.toMatchObject({ receipt: "receipt-1" });
    expect(http.calls[0]?.binaryBody).toEqual(bytes);
    expect(http.calls[0]?.body).toBeUndefined();
  });

  it("does not retry a strict retryable=false server error", async () => {
    const http = new FakeHttp();
    http.enqueue({
      status: 503,
      json: {
        protocolVersion: "3",
        error: { code: "INTERNAL_ERROR", retryable: false },
      },
    });
    await expect((await remoteWith(http)).head()).rejects.toMatchObject({
      status: 503,
    });
    expect(http.calls).toHaveLength(1);
  });

  it("rejects an oversized download through the binary response bound", async () => {
    const http = new FakeHttp();
    http.enqueue({
      status: 200,
      json: undefined,
      bytes: new Uint8Array(capabilities.maxAttachmentBytes + 1),
    });
    await expect(
      (await remoteWith(http)).downloadBlob({
        revision: "revision-1",
        attachmentId: "attachment-1",
        contentHash: "0".repeat(64),
      }),
    ).rejects.toThrow("HTTP_RESPONSE_TOO_LARGE");
  });

  it("accepts abort only as 204 without parsing JSON", async () => {
    const http = new FakeHttp();
    http.enqueue({ status: 204, json: undefined });
    await expect(
      (await remoteWith(http)).abort("11111111-1111-4111-8111-111111111111"),
    ).resolves.toBeUndefined();
    expect(http.calls[0]?.responseType).toBe("empty");
  });

  it("keeps bootstrap as preview-only until an explicit confirmed input", async () => {
    const http = new FakeHttp();
    http.enqueue({
      status: 200,
      json: {
        protocolVersion: "3",
        mode: "bootstrap_required",
        baseRevision: "revision-1",
        candidateHash: "0".repeat(64),
        attachmentCount: "0",
        transferBytes: "0",
        blockers: [],
      },
    });
    const remote = await remoteWith(http);
    await expect(remote.bootstrapPreview()).resolves.toMatchObject({
      mode: "bootstrap_required",
    });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.method).toBe("GET");
  });
});
