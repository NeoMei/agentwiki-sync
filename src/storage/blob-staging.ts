import {
  BlobRequirementV3Schema,
  TREE_SYNC_V3_HARD_LIMITS,
  blobChunkHashV3,
  blobContentHashV3,
  type BlobRequirementV3,
} from "@neomei/agentwiki-sync-protocol";

import { MutableControlRepository } from "./envelope";
import type { ControlStorePort } from "../ports/control-store";

export interface BlobStagingLimits {
  maxAttachmentBytes: number;
  maxRevisionAttachments: number;
  maxTransferBlobBytes: number;
  blobChunkBytes: number;
  maxBlobChunks: number;
  maxImageDimension: number;
  maxDecodedPixels: number;
}

interface BlobChunkCheckpoint {
  contentHash: string;
  sizeBytes: number;
}

interface BlobStagingEntry {
  expected: BlobRequirementV3;
  receivedChunks: Record<string, BlobChunkCheckpoint>;
  completeHash?: string;
}

export interface BlobStagingJournal {
  schemaVersion: 1;
  transferId: string;
  expiresAt: string;
  expectedBytes: number;
  blobs: Record<string, BlobStagingEntry>;
}

const PRIVATE_ROOT = /^\.agentwiki\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const HASH = /^[a-f0-9]{64}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
const mutationQueues = new WeakMap<
  ControlStorePort,
  Map<string, Promise<void>>
>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJournal(value: unknown): value is BlobStagingJournal {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (
    !Object.keys(value).every((key) =>
      [
        "schemaVersion",
        "transferId",
        "expiresAt",
        "expectedBytes",
        "blobs",
      ].includes(key),
    )
  )
    return false;
  if (
    typeof value.transferId !== "string" ||
    !OPAQUE_ID.test(value.transferId) ||
    typeof value.expiresAt !== "string" ||
    !RFC3339.test(value.expiresAt) ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    !Number.isSafeInteger(value.expectedBytes) ||
    (value.expectedBytes as number) < 0 ||
    !isRecord(value.blobs)
  )
    return false;
  for (const [hash, raw] of Object.entries(value.blobs)) {
    if (
      !HASH.test(hash) ||
      !isRecord(raw) ||
      !Object.keys(raw).every((key) =>
        ["expected", "receivedChunks", "completeHash"].includes(key),
      ) ||
      !isRecord(raw.receivedChunks)
    )
      return false;
    const parsed = BlobRequirementV3Schema.safeParse(raw.expected);
    if (!parsed.success || parsed.data.contentHash !== hash) return false;
    if (raw.completeHash !== undefined && raw.completeHash !== hash)
      return false;
    for (const [index, checkpoint] of Object.entries(raw.receivedChunks)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(index) || !isRecord(checkpoint))
        return false;
      if (
        !Object.keys(checkpoint).every((key) =>
          ["contentHash", "sizeBytes"].includes(key),
        ) ||
        typeof checkpoint.contentHash !== "string" ||
        !HASH.test(checkpoint.contentHash) ||
        !Number.isSafeInteger(checkpoint.sizeBytes) ||
        (checkpoint.sizeBytes as number) < 1
      )
        return false;
    }
  }
  return true;
}

function clampedLimit(value: number | undefined, hard: number): number {
  if (value === undefined) return hard;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError("Invalid Blob staging limit");
  return Math.min(value, hard);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

export class BlobStagingRepository {
  private readonly journal: MutableControlRepository<BlobStagingJournal>;
  private readonly limits: BlobStagingLimits;

  constructor(
    private readonly store: ControlStorePort,
    private readonly root: string,
    limits: Partial<BlobStagingLimits> = {},
  ) {
    if (!PRIVATE_ROOT.test(root) || root.includes("..") || root.includes("\\"))
      throw new TypeError("Blob staging requires a private control root");
    if (!store.readBinary || !store.writeBinary || !store.removeTree)
      throw new TypeError("Blob staging requires binary control sidecars");
    this.limits = {
      maxAttachmentBytes: clampedLimit(
        limits.maxAttachmentBytes,
        TREE_SYNC_V3_HARD_LIMITS.maxAttachmentBytes,
      ),
      maxRevisionAttachments: clampedLimit(
        limits.maxRevisionAttachments,
        TREE_SYNC_V3_HARD_LIMITS.maxRevisionAttachments,
      ),
      maxTransferBlobBytes: clampedLimit(
        limits.maxTransferBlobBytes,
        TREE_SYNC_V3_HARD_LIMITS.maxTransferBlobBytes,
      ),
      blobChunkBytes: clampedLimit(
        limits.blobChunkBytes,
        TREE_SYNC_V3_HARD_LIMITS.blobChunkBytes,
      ),
      maxBlobChunks: clampedLimit(
        limits.maxBlobChunks,
        TREE_SYNC_V3_HARD_LIMITS.maxBlobChunks,
      ),
      maxImageDimension: clampedLimit(
        limits.maxImageDimension,
        TREE_SYNC_V3_HARD_LIMITS.maxImageDimension,
      ),
      maxDecodedPixels: clampedLimit(
        limits.maxDecodedPixels,
        TREE_SYNC_V3_HARD_LIMITS.maxDecodedPixels,
      ),
    };
    this.journal = new MutableControlRepository(
      store,
      `${root}/journal.json`,
      isJournal,
    );
  }

  private chunkPath(contentHash: string, chunkIndex: number): string {
    return `${this.root}/chunks/${contentHash}/${chunkIndex}.bin`;
  }

  private completePath(contentHash: string): string {
    return `${this.root}/complete/${contentHash}.bin`;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    let queues = mutationQueues.get(this.store);
    if (!queues) {
      queues = new Map();
      mutationQueues.set(this.store, queues);
    }
    const previous = queues.get(this.root) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    queues.set(this.root, tail);
    void tail.then(() => {
      if (queues?.get(this.root) === tail) queues.delete(this.root);
    });
    return result;
  }

  async begin(
    transferId: string,
    requirements: BlobRequirementV3[],
    expiresAt: string,
  ): Promise<void> {
    return this.exclusive(async () => {
      if (
        !OPAQUE_ID.test(transferId) ||
        !RFC3339.test(expiresAt) ||
        !Number.isFinite(Date.parse(expiresAt))
      )
        throw new TypeError("Invalid Blob staging journal");
      const existing = await this.readJournalUnsafe(new Date());
      if (existing) throw new Error("Blob staging transfer is already active");
      await this.cleanupUnsafe();
      if (requirements.length > this.limits.maxRevisionAttachments)
        throw new RangeError("Blob staging quota exceeded");
      const blobs: BlobStagingJournal["blobs"] = {};
      let expectedBytes = 0;
      for (const raw of requirements) {
        const expected = BlobRequirementV3Schema.parse(raw);
        const size = Number(expected.sizeBytes);
        if (
          size > this.limits.maxAttachmentBytes ||
          Math.ceil(size / this.limits.blobChunkBytes) >
            this.limits.maxBlobChunks ||
          expected.width > this.limits.maxImageDimension ||
          expected.height > this.limits.maxImageDimension ||
          expected.width * expected.height > this.limits.maxDecodedPixels ||
          blobs[expected.contentHash]
        )
          throw new RangeError("Blob staging quota exceeded");
        expectedBytes += size;
        if (expectedBytes > this.limits.maxTransferBlobBytes)
          throw new RangeError("Blob staging quota exceeded");
        blobs[expected.contentHash] = { expected, receivedChunks: {} };
      }
      await this.journal.write({
        schemaVersion: 1,
        transferId,
        expiresAt,
        expectedBytes,
        blobs,
      });
    });
  }

  async readJournal(now = new Date()): Promise<BlobStagingJournal | null> {
    return this.exclusive(() => this.readJournalUnsafe(now));
  }

  private async readJournalUnsafe(
    now: Date,
  ): Promise<BlobStagingJournal | null> {
    const envelope = await this.journal.read();
    if (!envelope) return null;
    if (Date.parse(envelope.payload.expiresAt) <= now.getTime()) {
      await this.cleanupUnsafe();
      return null;
    }
    this.assertWithinLimits(envelope.payload);
    return envelope.payload;
  }

  private assertWithinLimits(journal: BlobStagingJournal): void {
    const entries = Object.values(journal.blobs);
    if (entries.length > this.limits.maxRevisionAttachments)
      throw new RangeError("Blob staging quota exceeded");
    let expectedBytes = 0;
    for (const entry of entries) {
      const size = Number(entry.expected.sizeBytes);
      expectedBytes += size;
      if (
        size > this.limits.maxAttachmentBytes ||
        Math.ceil(size / this.limits.blobChunkBytes) >
          this.limits.maxBlobChunks ||
        entry.expected.width > this.limits.maxImageDimension ||
        entry.expected.height > this.limits.maxImageDimension ||
        entry.expected.width * entry.expected.height >
          this.limits.maxDecodedPixels
      )
        throw new RangeError("Blob staging quota exceeded");
      const chunks = Object.entries(entry.receivedChunks);
      if (chunks.length > this.limits.maxBlobChunks)
        throw new RangeError("Blob staging quota exceeded");
      let receivedBytes = 0;
      for (const [index, chunk] of chunks) {
        if (
          Number(index) >= this.limits.maxBlobChunks ||
          chunk.sizeBytes > this.limits.blobChunkBytes
        )
          throw new RangeError("Blob staging quota exceeded");
        receivedBytes += chunk.sizeBytes;
      }
      if (receivedBytes > size)
        throw new RangeError("Blob staging quota exceeded");
    }
    if (
      expectedBytes !== journal.expectedBytes ||
      expectedBytes > this.limits.maxTransferBlobBytes
    )
      throw new RangeError("Blob staging quota exceeded");
  }

  async writeChunk(
    contentHash: string,
    chunkIndex: number,
    bytes: Uint8Array,
    expectedChunkHash: string,
    now = new Date(),
  ): Promise<void> {
    return this.exclusive(() =>
      this.writeChunkUnsafe(
        contentHash,
        chunkIndex,
        bytes,
        expectedChunkHash,
        now,
      ),
    );
  }

  private async writeChunkUnsafe(
    contentHash: string,
    chunkIndex: number,
    bytes: Uint8Array,
    expectedChunkHash: string,
    now: Date,
  ): Promise<void> {
    const journal = await this.readJournalUnsafe(now);
    const entry = journal?.blobs[contentHash];
    if (!journal || !entry) throw new Error("Blob staging entry missing");
    if (
      !Number.isInteger(chunkIndex) ||
      chunkIndex < 0 ||
      chunkIndex >= this.limits.maxBlobChunks ||
      bytes.byteLength < 1 ||
      bytes.byteLength > this.limits.blobChunkBytes
    )
      throw new RangeError("Blob staging quota exceeded");
    if ((await blobChunkHashV3(bytes)) !== expectedChunkHash)
      throw new Error("Blob staging chunk hash mismatch");
    const path = this.chunkPath(contentHash, chunkIndex);
    const existing = await this.store.readBinary!(path);
    if (existing && !bytesEqual(existing, bytes))
      throw new Error("Blob staging chunk conflict");
    const otherReceivedBytes = Object.entries(entry.receivedChunks).reduce(
      (sum, [index, chunk]) =>
        Number(index) === chunkIndex ? sum : sum + chunk.sizeBytes,
      0,
    );
    if (
      otherReceivedBytes + bytes.byteLength >
      Number(entry.expected.sizeBytes)
    )
      throw new RangeError("Blob staging quota exceeded");
    if (!existing) await this.store.writeBinary!(path, bytes);
    const verified = await this.store.readBinary!(path);
    if (!verified || (await blobChunkHashV3(verified)) !== expectedChunkHash)
      throw new Error("Blob staging chunk verification failed");
    entry.receivedChunks[String(chunkIndex)] = {
      contentHash: expectedChunkHash,
      sizeBytes: verified.byteLength,
    };
    await this.journal.write(journal);
  }

  async complete(contentHash: string, now = new Date()): Promise<void> {
    return this.exclusive(() => this.completeUnsafe(contentHash, now));
  }

  private async completeUnsafe(contentHash: string, now: Date): Promise<void> {
    const journal = await this.readJournalUnsafe(now);
    const entry = journal?.blobs[contentHash];
    if (!journal || !entry) throw new Error("Blob staging entry missing");
    if (entry.completeHash) {
      const completed = await this.store.readBinary!(
        this.completePath(contentHash),
      );
      if (
        !completed ||
        completed.byteLength !== Number(entry.expected.sizeBytes) ||
        (await blobContentHashV3(completed)) !== contentHash
      )
        throw new Error("Blob staging complete verification failed");
      await this.store.removeTree!(`${this.root}/chunks/${contentHash}`);
      return;
    }
    const indexes = Object.keys(entry.receivedChunks)
      .map(Number)
      .sort((left, right) => left - right);
    if (
      indexes.length < 1 ||
      indexes.length > this.limits.maxBlobChunks ||
      indexes.some((index, position) => index !== position)
    )
      throw new Error("Blob staging chunks incomplete");
    const size = indexes.reduce(
      (sum, index) => sum + entry.receivedChunks[String(index)]!.sizeBytes,
      0,
    );
    if (size !== Number(entry.expected.sizeBytes))
      throw new Error("Blob staging size mismatch");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const index of indexes) {
      const chunk = await this.store.readBinary!(
        this.chunkPath(contentHash, index),
      );
      if (
        !chunk ||
        (await blobChunkHashV3(chunk)) !==
          entry.receivedChunks[String(index)]!.contentHash
      )
        throw new Error("Blob staging chunk verification failed");
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if ((await blobContentHashV3(bytes)) !== contentHash)
      throw new Error("Blob staging complete hash mismatch");
    const path = this.completePath(contentHash);
    await this.store.writeBinary!(path, bytes);
    const verified = await this.store.readBinary!(path);
    if (!verified || (await blobContentHashV3(verified)) !== contentHash)
      throw new Error("Blob staging complete verification failed");
    entry.completeHash = contentHash;
    await this.journal.write(journal);
    await this.store.removeTree!(`${this.root}/chunks/${contentHash}`);
  }

  async readComplete(
    contentHash: string,
    now = new Date(),
  ): Promise<Uint8Array | null> {
    return this.exclusive(() => this.readCompleteUnsafe(contentHash, now));
  }

  private async readCompleteUnsafe(
    contentHash: string,
    now: Date,
  ): Promise<Uint8Array | null> {
    const journal = await this.readJournalUnsafe(now);
    const entry = journal?.blobs[contentHash];
    if (!entry?.completeHash) return null;
    const bytes = await this.store.readBinary!(this.completePath(contentHash));
    if (
      !bytes ||
      bytes.byteLength !== Number(entry.expected.sizeBytes) ||
      (await blobContentHashV3(bytes)) !== contentHash
    )
      throw new Error("Blob staging complete verification failed");
    return bytes;
  }

  async cleanup(): Promise<void> {
    return this.exclusive(() => this.cleanupUnsafe());
  }

  private async cleanupUnsafe(): Promise<void> {
    await this.store.removeTree!(this.root);
  }
}
