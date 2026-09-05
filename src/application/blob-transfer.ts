import {
  BlobChunkReceiptV3Schema,
  BlobRequirementV3Schema,
  TREE_SYNC_V3_HARD_LIMITS,
  blobChunkHashV3,
  blobContentHashV3,
  type BlobChunkReceiptV3,
  type BlobRequirementV3,
  type SyncAttachmentV3,
  type TreeSyncCapabilitiesV3,
} from "@neomei/agentwiki-sync-protocol";

import { isRetryableReadError, type RetryPolicy } from "../agentwiki/retry";
import type { TreeRemotePortV3 } from "../ports/tree-remote";
import {
  BlobStagingIntegrityError,
  type BlobStagingRepository,
} from "../storage/blob-staging";

const DEFAULT_TRANSFER_RETRY: RetryPolicy = {
  maxAttempts: 3,
  maxElapsedMs: 30_000,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

export class BlobTransferDeterministicError extends Error {
  readonly retryable = false;
  constructor(code: string) {
    super(code);
  }
}

export interface BlobTransferOptions {
  retryPolicy?: RetryPolicy;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
}

export interface UploadMissingInput {
  sessionId: string;
  missingContentHashes: string[];
  requirements: BlobRequirementV3[];
  readBlob(requirement: BlobRequirementV3): Promise<Uint8Array | null>;
  receiptFor?(
    contentHash: string,
    chunkIndex: number,
  ): Promise<BlobChunkReceiptV3 | null>;
  persistReceipt(receipt: BlobChunkReceiptV3): Promise<void>;
  signal?: AbortSignal;
}

export interface DownloadMissingInput {
  transferId: string;
  expiresAt: string;
  revision: string;
  attachments: SyncAttachmentV3[];
  signal?: AbortSignal;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Transfer aborted", "AbortError");
}

export class BlobTransfer {
  private readonly retryPolicy: RetryPolicy;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly chunkBytes: number;
  private readonly concurrency: number;

  constructor(
    private readonly remote: TreeRemotePortV3,
    private readonly staging: BlobStagingRepository,
    private readonly capabilities: TreeSyncCapabilitiesV3,
    options: BlobTransferOptions = {},
  ) {
    this.retryPolicy = options.retryPolicy ?? DEFAULT_TRANSFER_RETRY;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => window.setTimeout(resolve, milliseconds)));
    this.now = options.now ?? (() => new Date());
    this.chunkBytes = Math.min(
      capabilities.blobChunkBytes,
      TREE_SYNC_V3_HARD_LIMITS.blobChunkBytes,
    );
    this.concurrency = Math.min(
      2,
      capabilities.maxConcurrentBlobs,
      TREE_SYNC_V3_HARD_LIMITS.maxConcurrentBlobs,
    );
    if (this.chunkBytes < 1 || this.concurrency < 1)
      throw new BlobTransferDeterministicError("BLOB_CAPABILITIES_INVALID");
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    const started = Date.now();
    let last: unknown;
    for (
      let attempt = 0;
      attempt < this.retryPolicy.maxAttempts;
      attempt += 1
    ) {
      try {
        return await operation();
      } catch (error) {
        last = error;
        if (
          !isRetryableReadError(error) ||
          attempt + 1 >= this.retryPolicy.maxAttempts
        )
          throw error;
        const delay = Math.min(
          this.retryPolicy.maxDelayMs,
          this.retryPolicy.baseDelayMs * 2 ** attempt,
        );
        if (Date.now() - started + delay > this.retryPolicy.maxElapsedMs)
          throw error;
        await this.sleep(delay);
      }
    }
    throw last;
  }

  private requirementMap(
    requirements: BlobRequirementV3[],
  ): Map<string, BlobRequirementV3> {
    const result = new Map<string, BlobRequirementV3>();
    for (const raw of requirements) {
      const value = BlobRequirementV3Schema.parse(raw);
      if (result.has(value.contentHash))
        throw new BlobTransferDeterministicError("BLOB_REQUIREMENT_REPEATED");
      const size = Number(value.sizeBytes);
      if (
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size >
          Math.min(
            this.capabilities.maxAttachmentBytes,
            TREE_SYNC_V3_HARD_LIMITS.maxAttachmentBytes,
          ) ||
        Math.ceil(size / this.chunkBytes) >
          Math.min(
            this.capabilities.maxBlobChunks,
            TREE_SYNC_V3_HARD_LIMITS.maxBlobChunks,
          ) ||
        value.width >
          Math.min(
            this.capabilities.maxImageDimension,
            TREE_SYNC_V3_HARD_LIMITS.maxImageDimension,
          ) ||
        value.height >
          Math.min(
            this.capabilities.maxImageDimension,
            TREE_SYNC_V3_HARD_LIMITS.maxImageDimension,
          ) ||
        value.width * value.height >
          Math.min(
            this.capabilities.maxDecodedPixels,
            TREE_SYNC_V3_HARD_LIMITS.maxDecodedPixels,
          )
      )
        throw new BlobTransferDeterministicError("BLOB_LIMIT_EXCEEDED");
      result.set(value.contentHash, value);
    }
    if (
      result.size >
      Math.min(
        this.capabilities.maxRevisionAttachments,
        TREE_SYNC_V3_HARD_LIMITS.maxRevisionAttachments,
      )
    )
      throw new BlobTransferDeterministicError("BLOB_LIMIT_EXCEEDED");
    return result;
  }

  private assertTransferBytes(requirements: Iterable<BlobRequirementV3>): void {
    let total = 0;
    for (const requirement of requirements) {
      total += Number(requirement.sizeBytes);
      if (
        !Number.isSafeInteger(total) ||
        total >
          Math.min(
            this.capabilities.maxTransferBlobBytes,
            TREE_SYNC_V3_HARD_LIMITS.maxTransferBlobBytes,
          )
      )
        throw new BlobTransferDeterministicError("BLOB_LIMIT_EXCEEDED");
    }
  }

  private async workers<T>(
    values: Iterable<T>,
    operation: (value: T) => Promise<void>,
  ): Promise<void> {
    const iterator = values[Symbol.iterator]();
    let stopped = false;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (stopped) return;
        const next = iterator.next();
        if (next.done) return;
        try {
          await operation(next.value);
        } catch (error) {
          stopped = true;
          throw error;
        }
      }
    };
    const active: Promise<void>[] = [];
    for (let index = 0; index < this.concurrency; index += 1)
      active.push(worker());
    const settled = await Promise.allSettled(active);
    const failed = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) throw failed.reason;
  }

  async uploadMissing(input: UploadMissingInput): Promise<void> {
    const requirements = this.requirementMap(input.requirements);
    const missing = new Set<string>();
    for (const hash of input.missingContentHashes) {
      if (missing.has(hash))
        throw new BlobTransferDeterministicError("MISSING_HASH_REPEATED");
      if (!requirements.has(hash))
        throw new BlobTransferDeterministicError("MISSING_HASH_UNKNOWN");
      missing.add(hash);
    }
    this.assertTransferBytes(
      [...missing].map((hash) => requirements.get(hash)!),
    );
    await this.workers(missing, async (hash) => {
      assertNotAborted(input.signal);
      const expected = requirements.get(hash)!;
      const bytes = await input.readBlob(expected);
      if (
        !bytes ||
        bytes.byteLength !== Number(expected.sizeBytes) ||
        (await blobContentHashV3(bytes)) !== expected.contentHash
      )
        throw new BlobTransferDeterministicError("UPLOAD_BLOB_MISMATCH");
      const chunkCount = Math.ceil(bytes.byteLength / this.chunkBytes);
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        assertNotAborted(input.signal);
        const start = chunkIndex * this.chunkBytes;
        const chunk = bytes.subarray(
          start,
          Math.min(bytes.byteLength, start + this.chunkBytes),
        );
        const chunkHash = await blobChunkHashV3(chunk);
        const recovered = await input.receiptFor?.(hash, chunkIndex);
        if (recovered) {
          const existing = BlobChunkReceiptV3Schema.parse(recovered);
          if (
            existing.contentHash !== hash ||
            existing.chunkIndex !== chunkIndex ||
            existing.chunkHash !== chunkHash
          )
            throw new BlobTransferDeterministicError(
              "BLOB_RECEIPT_RESUME_MISMATCH",
            );
          continue;
        }
        const receipt = await this.retry(() =>
          this.remote.uploadBlobChunk(input.sessionId, hash, chunkIndex, chunk),
        );
        await input.persistReceipt(receipt);
      }
      assertNotAborted(input.signal);
      await this.retry(() =>
        this.remote.completeBlob(input.sessionId, expected, chunkCount),
      );
    });
  }

  async downloadMissing(input: DownloadMissingInput): Promise<void> {
    if (input.revision === "current")
      throw new BlobTransferDeterministicError("DOWNLOAD_REVISION_NOT_FIXED");
    const byHash = new Map<string, SyncAttachmentV3>();
    for (const attachment of input.attachments) {
      const expected = BlobRequirementV3Schema.parse({
        contentHash: attachment.contentHash,
        sizeBytes: attachment.sizeBytes,
        mimeType: attachment.mimeType,
        width: attachment.width,
        height: attachment.height,
      });
      const prior = byHash.get(expected.contentHash);
      if (
        prior &&
        (prior.sizeBytes !== expected.sizeBytes ||
          prior.mimeType !== expected.mimeType ||
          prior.width !== expected.width ||
          prior.height !== expected.height)
      )
        throw new BlobTransferDeterministicError("BLOB_HASH_METADATA_MISMATCH");
      byHash.set(expected.contentHash, prior ?? attachment);
    }
    const requirements = [...byHash.values()].map((attachment) => ({
      contentHash: attachment.contentHash,
      sizeBytes: attachment.sizeBytes,
      mimeType: attachment.mimeType,
      width: attachment.width,
      height: attachment.height,
    }));
    this.requirementMap(requirements);
    this.assertTransferBytes(requirements);
    assertNotAborted(input.signal);
    const existing = await this.staging.readJournal(this.now());
    if (existing) {
      const expectedByHash = new Map(
        requirements.map((requirement) => [
          requirement.contentHash,
          requirement,
        ]),
      );
      if (
        existing.schemaVersion !== 2 ||
        existing.revision !== input.revision ||
        existing.transferId !== input.transferId ||
        existing.expiresAt !== input.expiresAt ||
        Object.keys(existing.blobs).length !== expectedByHash.size ||
        Object.entries(existing.blobs).some(([hash, entry]) => {
          const expected = expectedByHash.get(hash);
          return (
            !expected ||
            JSON.stringify(entry.expected) !== JSON.stringify(expected)
          );
        })
      )
        throw new BlobTransferDeterministicError(
          "BLOB_STAGING_RESUME_MISMATCH",
        );
    } else
      await this.staging.begin(
        input.transferId,
        requirements,
        input.expiresAt,
        input.revision,
      );
    try {
      await this.workers(byHash.values(), async (attachment) => {
        assertNotAborted(input.signal);
        if (await this.staging.readComplete(attachment.contentHash, this.now()))
          return;
        const bytes = await this.remote.downloadBlob({
          revision: input.revision,
          attachmentId: attachment.attachmentId,
          contentHash: attachment.contentHash,
        });
        if (
          bytes.byteLength !== Number(attachment.sizeBytes) ||
          (await blobContentHashV3(bytes)) !== attachment.contentHash
        )
          throw new BlobTransferDeterministicError("DOWNLOAD_HASH_MISMATCH");
        const chunkCount = Math.ceil(bytes.byteLength / this.chunkBytes);
        for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
          const start = chunkIndex * this.chunkBytes;
          const chunk = bytes.subarray(
            start,
            Math.min(bytes.byteLength, start + this.chunkBytes),
          );
          await this.staging.writeChunk(
            attachment.contentHash,
            chunkIndex,
            chunk,
            await blobChunkHashV3(chunk),
            this.now(),
          );
        }
        assertNotAborted(input.signal);
        await this.staging.complete(attachment.contentHash, this.now());
      });
    } catch (error) {
      if (
        error instanceof BlobTransferDeterministicError ||
        error instanceof BlobStagingIntegrityError ||
        (typeof error === "object" &&
          error !== null &&
          "retryable" in error &&
          (error as { retryable?: unknown }).retryable === false &&
          !(error instanceof DOMException))
      )
        await this.staging.cleanup();
      throw error;
    }
  }
}
