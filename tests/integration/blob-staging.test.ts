import { blobChunkHashV3 } from "@neomei/agentwiki-sync-protocol";
import { describe, expect, it } from "vitest";

import { canonicalBytes, sha256Hex } from "../../src/agentwiki/protocol";
import { BlobStagingRepository } from "../../src/storage/blob-staging";
import {
  distinctControlStoreView,
  MemoryControlStore,
} from "../fakes/memory-control-store";
import {
  beforeExpiry,
  blobRequirement,
  futureExpiry,
  STAGING_ROOT,
} from "../fakes/blob-staging-fixture";

describe("bounded blob staging", () => {
  it("checkpoints verified chunks and completes only after a binary reread", async () => {
    const store = new MemoryControlStore();
    const repository = new BlobStagingRepository(store, STAGING_ROOT);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const requirement = await blobRequirement(bytes);
    await repository.begin("transfer-1", [requirement], futureExpiry);
    const chunkHash = await blobChunkHashV3(bytes);
    await repository.writeChunk(
      requirement.contentHash,
      0,
      bytes,
      chunkHash,
      beforeExpiry,
    );

    const checkpoint = await repository.readJournal(beforeExpiry);
    expect(checkpoint?.blobs[requirement.contentHash]?.receivedChunks).toEqual({
      "0": { contentHash: chunkHash, sizeBytes: 4 },
    });
    await repository.complete(requirement.contentHash, beforeExpiry);
    expect(
      await repository.readComplete(requirement.contentHash, beforeExpiry),
    ).toEqual(bytes);
    expect(
      (await repository.readJournal(beforeExpiry))?.blobs[
        requirement.contentHash
      ]?.completeHash,
    ).toBe(requirement.contentHash);
  });

  it("recovers a chunk written before its journal checkpoint", async () => {
    const store = new MemoryControlStore();
    const repository = new BlobStagingRepository(store, STAGING_ROOT);
    const bytes = new Uint8Array([9, 8, 7]);
    const requirement = await blobRequirement(bytes);
    await repository.begin("transfer-1", [requirement], futureExpiry);
    const chunkHash = await blobChunkHashV3(bytes);
    store.failNextTextWriteAt = `${STAGING_ROOT}/journal.json.next`;
    await expect(
      repository.writeChunk(
        requirement.contentHash,
        0,
        bytes,
        chunkHash,
        beforeExpiry,
      ),
    ).rejects.toThrow(/injected/);

    expect(store.binaryFiles.size).toBe(1);
    await repository.writeChunk(
      requirement.contentHash,
      0,
      bytes,
      chunkHash,
      beforeExpiry,
    );
    await expect(
      repository.complete(requirement.contentHash, beforeExpiry),
    ).resolves.toBeUndefined();
  });

  it("recovers sequentially through a distinct store wrapper over the same durable bytes", async () => {
    const store = new MemoryControlStore();
    const bytes = new Uint8Array([4, 3, 2, 1]);
    const requirement = await blobRequirement(bytes);
    const firstProcess = new BlobStagingRepository(store, STAGING_ROOT);
    await firstProcess.begin("transfer-1", [requirement], futureExpiry);
    await firstProcess.writeChunk(
      requirement.contentHash,
      0,
      bytes,
      await blobChunkHashV3(bytes),
      beforeExpiry,
    );

    const restarted = new BlobStagingRepository(
      distinctControlStoreView(store),
      STAGING_ROOT,
    );
    await expect(
      restarted.complete(requirement.contentHash, beforeExpiry),
    ).resolves.toBeUndefined();
    await expect(
      restarted.readComplete(requirement.contentHash, beforeExpiry),
    ).resolves.toEqual(bytes);
  });

  it("serializes concurrent blob checkpoints without losing either receipt", async () => {
    const store = new MemoryControlStore();
    const repository = new BlobStagingRepository(store, STAGING_ROOT);
    const left = new Uint8Array([1, 2]);
    const right = new Uint8Array([3, 4]);
    const [leftRequirement, rightRequirement] = await Promise.all([
      blobRequirement(left),
      blobRequirement(right),
    ]);
    await repository.begin(
      "transfer-1",
      [leftRequirement, rightRequirement],
      futureExpiry,
    );
    await Promise.all([
      repository.writeChunk(
        leftRequirement.contentHash,
        0,
        left,
        await blobChunkHashV3(left),
        beforeExpiry,
      ),
      repository.writeChunk(
        rightRequirement.contentHash,
        0,
        right,
        await blobChunkHashV3(right),
        beforeExpiry,
      ),
    ]);
    const journal = await repository.readJournal(beforeExpiry);
    expect(
      journal?.blobs[leftRequirement.contentHash]?.receivedChunks["0"],
    ).toBeDefined();
    expect(
      journal?.blobs[rightRequirement.contentHash]?.receivedChunks["0"],
    ).toBeDefined();
  });

  it("serializes concurrent checkpoints across workers sharing a staging root", async () => {
    const store = new MemoryControlStore();
    const leftWorker = new BlobStagingRepository(store, STAGING_ROOT);
    const rightWorker = new BlobStagingRepository(store, STAGING_ROOT);
    const left = new Uint8Array([1, 2]);
    const right = new Uint8Array([3, 4]);
    const [leftRequirement, rightRequirement] = await Promise.all([
      blobRequirement(left),
      blobRequirement(right),
    ]);
    await leftWorker.begin(
      "transfer-1",
      [leftRequirement, rightRequirement],
      futureExpiry,
    );

    await Promise.all([
      leftWorker.writeChunk(
        leftRequirement.contentHash,
        0,
        left,
        await blobChunkHashV3(left),
        beforeExpiry,
      ),
      rightWorker.writeChunk(
        rightRequirement.contentHash,
        0,
        right,
        await blobChunkHashV3(right),
        beforeExpiry,
      ),
    ]);

    const journal = await leftWorker.readJournal(beforeExpiry);
    expect(
      journal?.blobs[leftRequirement.contentHash]?.receivedChunks["0"],
    ).toBeDefined();
    expect(
      journal?.blobs[rightRequirement.contentHash]?.receivedChunks["0"],
    ).toBeDefined();
  });

  it("refuses to replace an active transfer and clears old chunks after complete", async () => {
    const store = new MemoryControlStore();
    const repository = new BlobStagingRepository(store, STAGING_ROOT);
    const bytes = new Uint8Array([1, 2, 3]);
    const requirement = await blobRequirement(bytes);
    await repository.begin("transfer-1", [requirement], futureExpiry);
    await expect(
      repository.begin("transfer-2", [requirement], futureExpiry),
    ).rejects.toThrow(/active/i);
    await repository.writeChunk(
      requirement.contentHash,
      0,
      bytes,
      await blobChunkHashV3(bytes),
      beforeExpiry,
    );
    await repository.complete(requirement.contentHash, beforeExpiry);
    expect(
      [...store.binaryFiles.keys()].some((path) => path.includes("/chunks/")),
    ).toBe(false);
    expect(
      [...store.binaryFiles.keys()].filter((path) =>
        path.includes("/complete/"),
      ),
    ).toHaveLength(1);

    await expect(
      repository.complete(requirement.contentHash, beforeExpiry),
    ).resolves.toBeUndefined();
    expect(
      [...store.binaryFiles.keys()].filter((path) =>
        path.includes("/complete/"),
      ),
    ).toHaveLength(1);
  });

  it("rejects chunk, blob, aggregate, count and image limits before ownership changes", async () => {
    const store = new MemoryControlStore();
    const repository = new BlobStagingRepository(store, STAGING_ROOT, {
      maxAttachmentBytes: 4,
      maxRevisionAttachments: 1,
      maxTransferBlobBytes: 4,
      blobChunkBytes: 2,
      maxBlobChunks: 2,
      maxImageDimension: 10,
      maxDecodedPixels: 50,
    });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const requirement = await blobRequirement(bytes);
    await expect(
      repository.begin("too-many", [requirement, requirement], futureExpiry),
    ).rejects.toThrow(/quota/i);
    await repository.begin("transfer-1", [requirement], futureExpiry);
    await expect(
      repository.writeChunk(
        requirement.contentHash,
        0,
        new Uint8Array([1, 2, 3]),
        await blobChunkHashV3(new Uint8Array([1, 2, 3])),
        beforeExpiry,
      ),
    ).rejects.toThrow(/quota/i);
    expect(store.binaryFiles.size).toBe(0);
  });

  it("blocks forked journal candidates and preserves them as recovery evidence", async () => {
    const store = new MemoryControlStore();
    const repository = new BlobStagingRepository(store, STAGING_ROOT);
    const bytes = new Uint8Array([1]);
    const requirement = await blobRequirement(bytes);
    await repository.begin("transfer-1", [requirement], futureExpiry);
    const raw = await store.read(`${STAGING_ROOT}/journal.json`);
    const fork = JSON.parse(raw ?? "{}") as {
      writeGeneration: number;
      payload: { transferId: string };
      payloadHash: string;
    };
    fork.payload.transferId = "fork";
    fork.payloadHash = await sha256Hex(canonicalBytes(fork.payload));
    await store.write(
      `${STAGING_ROOT}/journal.json.prev`,
      JSON.stringify(fork),
    );
    await expect(repository.readJournal(beforeExpiry)).rejects.toThrow(
      /fork|\u5206\u53c9|\u635f\u574f/i,
    );
    expect(
      await store.read(`${STAGING_ROOT}/journal.json.prev`),
    ).not.toBeNull();
  });

  it("rejects a future or over-budget recovered journal without cleanup", async () => {
    const store = new MemoryControlStore();
    const repository = new BlobStagingRepository(store, STAGING_ROOT, {
      maxTransferBlobBytes: 1,
    });
    const bytes = new Uint8Array([1, 2]);
    const requirement = await blobRequirement(bytes);
    const payload = {
      schemaVersion: 1,
      transferId: "transfer-1",
      expiresAt: futureExpiry,
      expectedBytes: 2,
      blobs: {
        [requirement.contentHash]: {
          expected: requirement,
          receivedChunks: {},
        },
      },
    };
    const envelope = {
      envelopeSchemaVersion: 1,
      writeGeneration: 1,
      payloadHash: await sha256Hex(canonicalBytes(payload)),
      payload,
    };
    await store.write(`${STAGING_ROOT}/journal.json`, JSON.stringify(envelope));
    await expect(repository.readJournal(beforeExpiry)).rejects.toThrow(
      /quota/i,
    );
    expect(await store.read(`${STAGING_ROOT}/journal.json`)).not.toBeNull();
  });

  it("rejects a recovered journal with a non-RFC3339 expiry without cleanup", async () => {
    const store = new MemoryControlStore();
    const repository = new BlobStagingRepository(store, STAGING_ROOT);
    const payload = {
      schemaVersion: 1,
      transferId: "transfer-1",
      expiresAt: "tomorrow",
      expectedBytes: 0,
      blobs: {},
    };
    const envelope = {
      envelopeSchemaVersion: 1,
      writeGeneration: 1,
      payloadHash: await sha256Hex(canonicalBytes(payload)),
      payload,
    };
    await store.write(`${STAGING_ROOT}/journal.json`, JSON.stringify(envelope));

    await expect(repository.readJournal(beforeExpiry)).rejects.toThrow();
    expect(await store.read(`${STAGING_ROOT}/journal.json`)).not.toBeNull();
  });

  it("reapplies the effective chunk-count budget to a recovered journal", async () => {
    const store = new MemoryControlStore();
    const repository = new BlobStagingRepository(store, STAGING_ROOT, {
      maxAttachmentBytes: 10,
      maxTransferBlobBytes: 10,
      blobChunkBytes: 2,
      maxBlobChunks: 2,
    });
    const requirement = await blobRequirement(new Uint8Array(5));
    const payload = {
      schemaVersion: 1,
      transferId: "transfer-1",
      expiresAt: futureExpiry,
      expectedBytes: 5,
      blobs: {
        [requirement.contentHash]: {
          expected: requirement,
          receivedChunks: {},
        },
      },
    };
    const envelope = {
      envelopeSchemaVersion: 1,
      writeGeneration: 1,
      payloadHash: await sha256Hex(canonicalBytes(payload)),
      payload,
    };
    await store.write(`${STAGING_ROOT}/journal.json`, JSON.stringify(envelope));

    await expect(repository.readJournal(beforeExpiry)).rejects.toThrow(
      /quota/i,
    );
    expect(await store.read(`${STAGING_ROOT}/journal.json`)).not.toBeNull();
  });

  it("cleans only the fixed private staging root after expiry", async () => {
    const store = new MemoryControlStore();
    const repository = new BlobStagingRepository(store, STAGING_ROOT);
    const bytes = new Uint8Array([1]);
    const requirement = await blobRequirement(bytes);
    await repository.begin(
      "transfer-1",
      [requirement],
      "2026-09-04T23:59:59.000Z",
    );
    await store.write(".agentwiki/do-not-remove.json", "keep");
    await expect(repository.readJournal(beforeExpiry)).resolves.toBeNull();
    expect(await store.read(".agentwiki/do-not-remove.json")).toBe("keep");
    for (const path of [...store.files.keys(), ...store.binaryFiles.keys()])
      expect(path.startsWith(`${STAGING_ROOT}/`)).toBe(false);
  });

  it("rejects an unsafe caller root", () => {
    expect(
      () => new BlobStagingRepository(new MemoryControlStore(), "../outside"),
    ).toThrow(/private control root/i);
  });
});
