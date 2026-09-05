import { describe, expect, it } from "vitest";
import {
  blobChunkHashV3,
  blobContentHashV3,
  type BlobChunkReceiptV3,
  type BlobRequirementV3,
  type CompletedBlobV3,
  type SyncAttachmentV3,
  type TreeSyncCapabilitiesV3,
} from "@neomei/agentwiki-sync-protocol";

import { AgentWikiHttpError } from "../../src/agentwiki/client";
import { BlobTransfer } from "../../src/application/blob-transfer";
import type { TreeRemotePortV3 } from "../../src/ports/tree-remote";
import { BlobStagingRepository } from "../../src/storage/blob-staging";
import { MemoryControlStore } from "../fakes/memory-control-store";
import {
  STAGING_ROOT,
  beforeExpiry,
  futureExpiry,
} from "../fakes/blob-staging-fixture";

const capabilities = {
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxRevisionAttachments: 1000,
  maxTransferBlobBytes: 100 * 1024 * 1024,
  blobChunkBytes: 4,
  maxBlobChunks: 10,
  maxConcurrentBlobs: 2,
  maxImageDimension: 10_000,
  maxDecodedPixels: 40_000_000,
} as TreeSyncCapabilitiesV3;

async function requirement(bytes: Uint8Array): Promise<BlobRequirementV3> {
  return {
    contentHash: await blobContentHashV3(bytes),
    sizeBytes: String(bytes.byteLength),
    mimeType: "image/png",
    width: 1,
    height: 1,
  };
}

class FakeV3Remote {
  readonly protocolVersion = "3" as const;
  readonly uploaded: Array<{ hash: string; index: number; bytes: Uint8Array }> =
    [];
  active = 0;
  maxActive = 0;
  firstResponseLost = true;
  fail401 = false;
  transientSecondChunk = true;
  readonly attempts = new Map<string, number>();
  downloads = new Map<string, Uint8Array>();
  readonly downloadAttempts = new Map<string, number>();

  async uploadBlobChunk(
    _sessionId: string,
    contentHash: string,
    chunkIndex: number,
    bytes: Uint8Array,
  ): Promise<BlobChunkReceiptV3> {
    const key = `${contentHash}:${chunkIndex}`;
    this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
    this.uploaded.push({
      hash: contentHash,
      index: chunkIndex,
      bytes: bytes.slice(),
    });
    if (this.fail401)
      throw new AgentWikiHttpError(401, {
        protocolVersion: "3",
        error: { code: "AUTHENTICATION_REQUIRED", retryable: false },
      });
    if (chunkIndex === 0 && this.firstResponseLost) {
      this.firstResponseLost = false;
      throw new Error("transport response lost");
    }
    if (chunkIndex === 1 && this.transientSecondChunk) {
      this.transientSecondChunk = false;
      throw new AgentWikiHttpError(503, {
        protocolVersion: "3",
        error: { code: "INTERNAL_ERROR", retryable: true },
      });
    }
    return {
      contentHash,
      chunkIndex,
      chunkHash: await blobChunkHashV3(bytes),
      receipt: `receipt-${chunkIndex}`,
    };
  }

  async completeBlob(
    _sessionId: string,
    blob: BlobRequirementV3,
    _chunkCount: number,
  ): Promise<CompletedBlobV3> {
    return { ...blob, verifiedAt: "2026-09-05T00:00:00.000Z" };
  }

  async downloadBlob(input: {
    revision: string;
    attachmentId: string;
    contentHash: string;
  }): Promise<Uint8Array> {
    this.downloadAttempts.set(
      input.attachmentId,
      (this.downloadAttempts.get(input.attachmentId) ?? 0) + 1,
    );
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await Promise.resolve();
    const bytes = this.downloads.get(input.attachmentId);
    this.active -= 1;
    if (!bytes) throw new Error("missing download");
    return bytes.slice();
  }
}

class CorruptingCompleteStore extends MemoryControlStore {
  private chunkReads = 0;

  override async readBinary(path: string): Promise<Uint8Array | null> {
    const bytes = await super.readBinary(path);
    if (!path.includes("/chunks/") || !bytes) return bytes;
    this.chunkReads += 1;
    return this.chunkReads >= 2 ? new Uint8Array(bytes.byteLength) : bytes;
  }
}

class FailingCompleteReadStore extends MemoryControlStore {
  private chunkReads = 0;

  override async readBinary(path: string): Promise<Uint8Array | null> {
    const bytes = await super.readBinary(path);
    if (!path.includes("/chunks/") || !bytes) return bytes;
    this.chunkReads += 1;
    if (this.chunkReads >= 2) throw new Error("transient staging read");
    return bytes;
  }
}

function transfer(
  remote: FakeV3Remote,
  store = new MemoryControlStore(),
  delays: number[] = [],
  capabilityOverrides: Partial<TreeSyncCapabilitiesV3> = {},
) {
  const effectiveCapabilities = { ...capabilities, ...capabilityOverrides };
  return {
    store,
    subject: new BlobTransfer(
      remote as unknown as TreeRemotePortV3,
      new BlobStagingRepository(store, STAGING_ROOT, effectiveCapabilities),
      effectiveCapabilities,
      {
        now: () => beforeExpiry,
        sleep: async (ms) => void delays.push(ms),
        retryPolicy: {
          maxAttempts: 3,
          maxElapsedMs: 30_000,
          baseDelayMs: 5,
          maxDelayMs: 20,
        },
      },
    ),
  };
}

describe("BlobTransfer", () => {
  it("passes the verified chunk hash to resume lookup without retaining prior Blob bytes", async () => {
    const remote = new FakeV3Remote();
    remote.firstResponseLost = false;
    remote.transientSecondChunk = false;
    const blobs = Array.from(
      { length: 5 },
      (_, index) => new Uint8Array([index + 1, index + 11]),
    );
    const requirements = await Promise.all(blobs.map(requirement));
    const bytesByHash = new Map(
      requirements.map((item, index) => [item.contentHash, blobs[index]!]),
    );
    let liveReads = 0;
    let maxLiveReads = 0;
    const released: string[] = [];

    await transfer(remote).subject.uploadMissing({
      sessionId: "session-1",
      missingContentHashes: requirements.map((item) => item.contentHash),
      requirements,
      readBlob: async (expected) => {
        liveReads += 1;
        maxLiveReads = Math.max(maxLiveReads, liveReads);
        return bytesByHash.get(expected.contentHash)!;
      },
      receiptFor: async (contentHash, chunkIndex, chunkHash) => {
        expect(chunkHash).toMatch(/^[a-f0-9]{64}$/u);
        return null;
      },
      releaseBlob: async (contentHash) => {
        liveReads -= 1;
        released.push(contentHash);
      },
      persistReceipt: async () => undefined,
    });

    expect(maxLiveReads).toBe(2);
    expect(liveReads).toBe(0);
    expect(released.sort()).toEqual(
      requirements.map((item) => item.contentHash).sort(),
    );
  });

  it("retries identical chunk bytes after a lost response and durably records each receipt", async () => {
    const remote = new FakeV3Remote();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const expected = await requirement(bytes);
    const receipts: string[] = [];
    await transfer(remote).subject.uploadMissing({
      sessionId: "session-1",
      missingContentHashes: [expected.contentHash],
      requirements: [expected],
      readBlob: async () => bytes,
      persistReceipt: async (receipt) => void receipts.push(receipt.receipt),
    });
    expect(remote.uploaded[0]?.bytes).toEqual(remote.uploaded[1]?.bytes);
    expect(receipts).toEqual(["receipt-0", "receipt-1"]);
  });

  it("resumes from validated durable chunk receipts without re-uploading them", async () => {
    const remote = new FakeV3Remote();
    remote.firstResponseLost = false;
    remote.transientSecondChunk = false;
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const expected = await requirement(bytes);
    const firstChunk = bytes.subarray(0, 4);
    await transfer(remote).subject.uploadMissing({
      sessionId: "session-1",
      missingContentHashes: [expected.contentHash],
      requirements: [expected],
      readBlob: async () => bytes,
      receiptFor: async (_hash, chunkIndex) =>
        chunkIndex === 0
          ? {
              contentHash: expected.contentHash,
              chunkIndex: 0,
              chunkHash: await blobChunkHashV3(firstChunk),
              receipt: "durable-0",
            }
          : null,
      persistReceipt: async () => undefined,
    });
    expect(remote.uploaded.map((upload) => upload.index)).toEqual([1]);
  });

  it("budgets upload bytes only across unique missing hashes", async () => {
    const remote = new FakeV3Remote();
    remote.firstResponseLost = false;
    remote.transientSecondChunk = false;
    const missingBytes = new Uint8Array([1]);
    const missing = await requirement(missingBytes);
    const existing = Array.from({ length: 3 }, (_, index) => ({
      contentHash: String(index + 1).padStart(64, "0"),
      sizeBytes: "4",
      mimeType: "image/png" as const,
      width: 1,
      height: 1,
    }));
    const { subject } = transfer(remote, undefined, [], {
      maxTransferBlobBytes: 10,
    });

    await subject.uploadMissing({
      sessionId: "session-1",
      missingContentHashes: [missing.contentHash],
      requirements: [missing, ...existing],
      readBlob: async (value) =>
        value.contentHash === missing.contentHash ? missingBytes : null,
      persistReceipt: async () => undefined,
    });

    expect(remote.uploaded.map((upload) => upload.hash)).toEqual([
      missing.contentHash,
    ]);
  });

  it("uses exponential retry delay for a retryable 503", async () => {
    const remote = new FakeV3Remote();
    remote.firstResponseLost = false;
    const delays: number[] = [];
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const expected = await requirement(bytes);
    await transfer(remote, undefined, delays).subject.uploadMissing({
      sessionId: "session-1",
      missingContentHashes: [expected.contentHash],
      requirements: [expected],
      readBlob: async () => bytes,
      persistReceipt: async () => undefined,
    });
    expect(delays).toEqual([5]);
    expect(remote.attempts.get(`${expected.contentHash}:1`)).toBe(2);
  });

  it("does not retry 401", async () => {
    const remote = new FakeV3Remote();
    remote.fail401 = true;
    const bytes = new Uint8Array([1]);
    const expected = await requirement(bytes);
    await expect(
      transfer(remote).subject.uploadMissing({
        sessionId: "session-1",
        missingContentHashes: [expected.contentHash],
        requirements: [expected],
        readBlob: async () => bytes,
        persistReceipt: async () => undefined,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(remote.uploaded).toHaveLength(1);
  });

  it("downloads with concurrency at most two and stages each verified Blob", async () => {
    const remote = new FakeV3Remote();
    remote.firstResponseLost = false;
    const attachments: SyncAttachmentV3[] = [];
    for (let index = 0; index < 5; index += 1) {
      const bytes = new Uint8Array([index + 1]);
      const contentHash = await blobContentHashV3(bytes);
      const attachment = {
        attachmentId: `attachment-${index}`,
        path: `assets/${index}.png`,
        mimeType: "image/png" as const,
        sizeBytes: "1",
        width: 1,
        height: 1,
        contentHash,
        updatedAt: "2026-09-05T00:00:00.000Z",
      };
      attachments.push(attachment);
      remote.downloads.set(attachment.attachmentId, bytes);
    }
    const { subject } = transfer(remote);
    await subject.downloadMissing({
      transferId: "download-1",
      expiresAt: futureExpiry,
      revision: "revision-1",
      attachments,
    });
    expect(remote.maxActive).toBeLessThanOrEqual(2);
  });

  it("does not resume schema-1 staging without a fixed revision binding", async () => {
    const remote = new FakeV3Remote();
    const bytes = new Uint8Array([1]);
    const expected = await requirement(bytes);
    const attachment: SyncAttachmentV3 = {
      attachmentId: "attachment-1",
      path: "assets/a.png",
      ...expected,
      updatedAt: "2026-09-05T00:00:00.000Z",
    };
    const store = new MemoryControlStore();
    const staging = new BlobStagingRepository(store, STAGING_ROOT);
    await staging.begin("download-1", [expected], futureExpiry);
    const { subject } = transfer(remote, store);

    await expect(
      subject.downloadMissing({
        transferId: "download-1",
        expiresAt: futureExpiry,
        revision: "revision-1",
        attachments: [attachment],
      }),
    ).rejects.toThrow(/BLOB_STAGING_RESUME_MISMATCH/);
  });

  it("cleans staging when downloaded bytes do not match the fixed manifest hash", async () => {
    const remote = new FakeV3Remote();
    const good = new Uint8Array([1]);
    const expected = await requirement(good);
    const attachment: SyncAttachmentV3 = {
      attachmentId: "attachment-1",
      path: "assets/a.png",
      ...expected,
      updatedAt: "2026-09-05T00:00:00.000Z",
    };
    remote.downloads.set(attachment.attachmentId, new Uint8Array([2]));
    const { subject, store } = transfer(remote);
    await expect(
      subject.downloadMissing({
        transferId: "download-1",
        expiresAt: futureExpiry,
        revision: "revision-1",
        attachments: [attachment],
      }),
    ).rejects.toThrow(/hash/i);
    expect(
      [...store.files.keys(), ...store.binaryFiles.keys()].some((path) =>
        path.startsWith(STAGING_ROOT),
      ),
    ).toBe(false);
  });

  it("cleans staging when the real repository detects complete hash corruption", async () => {
    const remote = new FakeV3Remote();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const expected = await requirement(bytes);
    const attachment: SyncAttachmentV3 = {
      attachmentId: "attachment-1",
      path: "assets/a.png",
      ...expected,
      updatedAt: "2026-09-05T00:00:00.000Z",
    };
    remote.downloads.set(attachment.attachmentId, bytes);
    const store = new CorruptingCompleteStore();
    const { subject } = transfer(remote, store);

    await expect(
      subject.downloadMissing({
        transferId: "download-corrupt",
        expiresAt: futureExpiry,
        revision: "revision-1",
        attachments: [attachment],
      }),
    ).rejects.toThrow("Blob staging chunk verification failed");
    expect(
      [...store.files.keys(), ...store.binaryFiles.keys()].some((path) =>
        path.startsWith(STAGING_ROOT),
      ),
    ).toBe(false);
  });

  it("preserves staging when the repository encounters transient storage I/O", async () => {
    const remote = new FakeV3Remote();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const expected = await requirement(bytes);
    const attachment: SyncAttachmentV3 = {
      attachmentId: "attachment-1",
      path: "assets/a.png",
      ...expected,
      updatedAt: "2026-09-05T00:00:00.000Z",
    };
    remote.downloads.set(attachment.attachmentId, bytes);
    const store = new FailingCompleteReadStore();
    const { subject } = transfer(remote, store);

    await expect(
      subject.downloadMissing({
        transferId: "download-transient",
        expiresAt: futureExpiry,
        revision: "revision-1",
        attachments: [attachment],
      }),
    ).rejects.toThrow("transient staging read");
    expect(
      [...store.files.keys(), ...store.binaryFiles.keys()].some((path) =>
        path.startsWith(STAGING_ROOT),
      ),
    ).toBe(true);
  });

  it("rejects duplicate content hashes with inconsistent metadata before transfer", async () => {
    const remote = new FakeV3Remote();
    const bytes = new Uint8Array([1]);
    const expected = await requirement(bytes);
    const base: SyncAttachmentV3 = {
      attachmentId: "attachment-1",
      path: "assets/a.png",
      ...expected,
      updatedAt: "2026-09-05T00:00:00.000Z",
    };
    await expect(
      transfer(remote).subject.downloadMissing({
        transferId: "download-1",
        expiresAt: futureExpiry,
        revision: "revision-1",
        attachments: [
          base,
          {
            ...base,
            attachmentId: "attachment-2",
            path: "assets/b.png",
            width: 2,
          },
        ],
      }),
    ).rejects.toThrow("BLOB_HASH_METADATA_MISMATCH");
    expect(remote.downloadAttempts.size).toBe(0);
  });

  it("resumes a matching partial transfer without downloading completed hashes again", async () => {
    const remote = new FakeV3Remote();
    const firstBytes = new Uint8Array([1]);
    const secondBytes = new Uint8Array([2]);
    const firstRequirement = await requirement(firstBytes);
    const secondRequirement = await requirement(secondBytes);
    const attachments: SyncAttachmentV3[] = [
      {
        attachmentId: "attachment-1",
        path: "assets/1.png",
        ...firstRequirement,
        updatedAt: "2026-09-05T00:00:00.000Z",
      },
      {
        attachmentId: "attachment-2",
        path: "assets/2.png",
        ...secondRequirement,
        updatedAt: "2026-09-05T00:00:00.000Z",
      },
    ];
    remote.downloads.set("attachment-1", firstBytes);
    const { subject } = transfer(remote);
    await expect(
      subject.downloadMissing({
        transferId: "download-resume",
        expiresAt: futureExpiry,
        revision: "revision-1",
        attachments,
      }),
    ).rejects.toThrow("missing download");
    remote.downloads.set("attachment-2", secondBytes);
    await subject.downloadMissing({
      transferId: "download-resume",
      expiresAt: futureExpiry,
      revision: "revision-1",
      attachments,
    });
    expect(remote.downloadAttempts.get("attachment-1")).toBe(1);
    expect(remote.downloadAttempts.get("attachment-2")).toBe(2);
  });
});
