import {
  BlobChunkReceiptV3Schema,
  BlobRequirementV3Schema,
  CompleteBlobRequestV3Schema,
  CompletedBlobV3Schema,
  CreateTreePushSessionRequestV3Schema,
  CreateTreePushSessionResponseV3Schema,
  SyncV3ErrorEnvelopeSchema,
  TREE_SYNC_V2_LIMITS,
  TREE_SYNC_V3_HARD_LIMITS,
  TreeBootstrapPreviewV3Schema,
  TreeBootstrapRequestV3Schema,
  TreeCapabilitiesResponseV3Schema,
  TreeDeltaPageV3Schema,
  TreeFinalizePushRequestV3Schema,
  TreeFinalizePushResponseV3Schema,
  TreePushBatchReceiptV3Schema,
  TreePushBatchV3Schema,
  TreePushSessionStatusResponseV3Schema,
  TreeRevisionContentManifestV3Schema,
  TreeRevisionHeadResponseV3Schema,
  TreeSnapshotPageV3Schema,
  TreeSyncSpaceListResponseV3Schema,
  blobChunkHashV3,
  blobContentHashV3,
  canonicalBytes,
  treeCapabilitiesHashV3,
  treeRevisionContentHashV3,
  type BlobRequirementV3,
  type SyncAttachmentV3,
  type SyncFolderV3,
  type SyncPageV3,
  type TreeDeltaItemV3,
  type TreeSyncCapabilitiesV3,
} from "@neomei/agentwiki-sync-protocol";

import type { SyncProtocolSelection } from "../application/protocol-negotiator";
import type {
  TreeBootstrapPreviewV3,
  TreeCreatePushSessionV3,
  TreeDeltaV3,
  TreeFinalizeResultV3,
  TreeHeadV3,
  TreePushSessionStatusV3,
  TreePushSessionV3,
  TreeRemotePortV3,
  TreeSnapshotSegmentV3,
  TreeSpaceSummaryV3,
} from "../ports/tree-remote";
import { AgentWikiHttpError, type AgentWikiClient } from "./client";
import { DEFAULT_RETRY_POLICY, retryRead, type RetryPolicy } from "./retry";

type V3Selection = Extract<SyncProtocolSelection, { version: "3" }>;

export class V3RemoteDeterministicError extends Error {
  readonly retryable = false;
  constructor(code: string) {
    super(code);
  }
}

interface V3RemoteOptions {
  retryPolicy?: RetryPolicy;
  sleep?: (milliseconds: number) => Promise<void>;
}

function decimal(value: string, code: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new V3RemoteDeterministicError(code);
  }
}

function metadataSignature(
  value: Record<string, unknown>,
  keys: string[],
): string {
  return JSON.stringify(keys.map((key) => value[key]));
}

function deltaEntityKey(item: TreeDeltaItemV3): string {
  switch (item.operation) {
    case "upsert_folder":
      return `folder:${item.folder.folderId}`;
    case "archive_folder":
      return `folder:${item.folderId}`;
    case "upsert_page":
      return `page:${item.page.pageId}`;
    case "archive_page":
      return `page:${item.pageId}`;
    case "upsert_attachment":
      return `attachment:${item.attachment.attachmentId}`;
    case "detach_attachment":
      return `attachment:${item.attachmentId}`;
  }
}

function finalizeResult(
  value: ReturnType<typeof TreeFinalizePushResponseV3Schema.parse>,
): TreeFinalizeResultV3 {
  return { ...value };
}

export class V3TreeRemote implements TreeRemotePortV3 {
  readonly protocolVersion = "3" as const;
  readonly capabilitiesHash: Promise<string>;
  private readonly retryPolicy: RetryPolicy;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly client: AgentWikiClient,
    private readonly spaceId: string,
    private readonly selection: V3Selection,
    options: V3RemoteOptions = {},
  ) {
    this.capabilitiesHash = Promise.resolve(selection.capabilitiesHash);
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => window.setTimeout(resolve, milliseconds)));
  }

  async capabilities(): Promise<TreeSyncCapabilitiesV3> {
    return this.selection.capabilities;
  }

  private async strictJson(
    method: string,
    path: string,
    body?: unknown,
    canonical = false,
    retry = false,
    maxResponseBytes = this.selection.capabilities.maxResponseBytes,
  ): Promise<unknown> {
    const operation = async (): Promise<unknown> => {
      try {
        return (
          await this.client.boundedJson(
            method,
            path,
            maxResponseBytes,
            body,
            canonical,
          )
        ).json;
      } catch (error) {
        if (error instanceof AgentWikiHttpError) {
          const parsed = SyncV3ErrorEnvelopeSchema.safeParse(error.body);
          if (!parsed.success)
            throw new V3RemoteDeterministicError("V3_ERROR_RESPONSE_INVALID");
          throw new AgentWikiHttpError(
            error.status,
            parsed.data,
            error.headers,
            error.message,
          );
        }
        throw error;
      }
    };
    return retry
      ? retryRead(operation, this.retryPolicy, this.sleep)
      : operation();
  }

  async refreshCapabilities(): Promise<TreeSyncCapabilitiesV3> {
    const parsed = TreeCapabilitiesResponseV3Schema.parse(
      await this.strictJson(
        "GET",
        "/api/sync/v3/capabilities",
        undefined,
        false,
        true,
        TREE_SYNC_V2_LIMITS.capabilitiesDiscoveryBytes,
      ),
    );
    if (
      (await treeCapabilitiesHashV3(parsed.capabilities)) !==
      parsed.capabilitiesHash
    )
      throw new V3RemoteDeterministicError("CAPABILITIES_HASH_MISMATCH");
    return parsed.capabilities;
  }

  async spaces(): Promise<TreeSpaceSummaryV3[]> {
    return TreeSyncSpaceListResponseV3Schema.parse(
      await this.strictJson(
        "GET",
        "/api/sync/v3/spaces",
        undefined,
        false,
        true,
      ),
    ).spaces;
  }

  async head(): Promise<TreeHeadV3> {
    const parsed = TreeRevisionHeadResponseV3Schema.parse(
      await this.strictJson(
        "GET",
        `/api/sync/v3/spaces/${encodeURIComponent(this.spaceId)}/head`,
        undefined,
        false,
        true,
      ),
    );
    if (parsed.spaceId !== this.spaceId)
      throw new V3RemoteDeterministicError("HEAD_SPACE_MISMATCH");
    return parsed;
  }

  async *snapshotPages(
    revision = "current",
  ): AsyncIterable<TreeSnapshotSegmentV3> {
    let cursor: string | null = null;
    let requestRevision = revision;
    let fixedSignature: string | null = null;
    let fixedMetadata: Omit<
      TreeSnapshotSegmentV3,
      "folders" | "pages" | "attachments"
    > | null = null;
    const cursors = new Set<string>();
    const entities = new Set<string>();
    const folders: SyncFolderV3[] = [];
    const pages: SyncPageV3[] = [];
    const attachments: SyncAttachmentV3[] = [];
    const metadataKeys = [
      "protocolVersion",
      "spaceId",
      "revision",
      "sequence",
      "revisionContentHash",
      "folderCount",
      "pageCount",
      "attachmentCount",
      "revisionManifestByteLength",
      "revisionBodyBytes",
      "revisionAttachmentBytes",
    ];
    do {
      const query = new URLSearchParams({ revision: requestRevision });
      if (cursor) query.set("cursor", cursor);
      const parsed = TreeSnapshotPageV3Schema.parse(
        await this.strictJson(
          "GET",
          `/api/sync/v3/spaces/${encodeURIComponent(this.spaceId)}/snapshot?${query}`,
          undefined,
          false,
          true,
        ),
      );
      if (parsed.spaceId !== this.spaceId)
        throw new V3RemoteDeterministicError("SNAPSHOT_SPACE_MISMATCH");
      if (
        fixedMetadata === null &&
        revision !== "current" &&
        parsed.revision !== revision
      )
        throw new V3RemoteDeterministicError("SNAPSHOT_TARGET_MISMATCH");
      if (
        parsed.folders.length +
          parsed.pages.length +
          parsed.attachments.length >
        this.selection.capabilities.maxPageItems
      )
        throw new V3RemoteDeterministicError("SNAPSHOT_PAGE_LIMIT_EXCEEDED");
      const signature = metadataSignature(parsed, metadataKeys);
      if (fixedSignature !== null && fixedSignature !== signature)
        throw new V3RemoteDeterministicError("SNAPSHOT_METADATA_CHANGED");
      fixedSignature = signature;
      fixedMetadata ??= {
        protocolVersion: "3",
        spaceId: parsed.spaceId,
        revision: parsed.revision,
        sequence: parsed.sequence,
        revisionContentHash: parsed.revisionContentHash,
        folderCount: parsed.folderCount,
        pageCount: parsed.pageCount,
        attachmentCount: parsed.attachmentCount,
        revisionManifestByteLength: parsed.revisionManifestByteLength,
        revisionBodyBytes: parsed.revisionBodyBytes,
        revisionAttachmentBytes: parsed.revisionAttachmentBytes,
      };
      requestRevision = parsed.revision;
      this.assertPageItems(parsed.pages, parsed.attachments);
      for (const folder of parsed.folders) {
        const key = `folder:${folder.folderId}`;
        if (entities.has(key))
          throw new V3RemoteDeterministicError("SNAPSHOT_ENTITY_REPEATED");
        entities.add(key);
        folders.push(folder);
      }
      for (const page of parsed.pages) {
        const key = `page:${page.pageId}`;
        if (entities.has(key))
          throw new V3RemoteDeterministicError("SNAPSHOT_ENTITY_REPEATED");
        entities.add(key);
        pages.push(page);
      }
      for (const attachment of parsed.attachments) {
        const key = `attachment:${attachment.attachmentId}`;
        if (entities.has(key))
          throw new V3RemoteDeterministicError("SNAPSHOT_ENTITY_REPEATED");
        entities.add(key);
        attachments.push(attachment);
      }
      this.assertSnapshotBudgets(
        parsed,
        folders.length,
        pages.length,
        attachments.length,
      );
      yield {
        ...fixedMetadata,
        folders: parsed.folders,
        pages: parsed.pages,
        attachments: parsed.attachments,
      };
      const next = parsed.nextCursor;
      if (next !== null) {
        if (cursors.has(next))
          throw new V3RemoteDeterministicError("CURSOR_REPEATED");
        cursors.add(next);
      }
      cursor = next;
    } while (cursor !== null);
    if (!fixedMetadata)
      throw new V3RemoteDeterministicError("SNAPSHOT_EMPTY_RESPONSE");
    const manifest = TreeRevisionContentManifestV3Schema.parse({
      protocolVersion: "3",
      spaceId: fixedMetadata.spaceId,
      folders,
      pages,
      attachments,
    });
    const bodyBytes = pages.reduce(
      (total, page) => total + new TextEncoder().encode(page.body).byteLength,
      0,
    );
    const attachmentBytes = attachments.reduce(
      (total, attachment) => total + Number(attachment.sizeBytes),
      0,
    );
    if (
      decimal(fixedMetadata.folderCount, "SNAPSHOT_COUNT_INVALID") !==
        BigInt(folders.length) ||
      decimal(fixedMetadata.pageCount, "SNAPSHOT_COUNT_INVALID") !==
        BigInt(pages.length) ||
      decimal(fixedMetadata.attachmentCount, "SNAPSHOT_COUNT_INVALID") !==
        BigInt(attachments.length) ||
      decimal(
        fixedMetadata.revisionManifestByteLength,
        "SNAPSHOT_BYTES_INVALID",
      ) !== BigInt(canonicalBytes(manifest).byteLength) ||
      decimal(fixedMetadata.revisionBodyBytes, "SNAPSHOT_BYTES_INVALID") !==
        BigInt(bodyBytes) ||
      decimal(
        fixedMetadata.revisionAttachmentBytes,
        "SNAPSHOT_BYTES_INVALID",
      ) !== BigInt(attachmentBytes)
    )
      throw new V3RemoteDeterministicError("SNAPSHOT_METRICS_MISMATCH");
    if (
      (await treeRevisionContentHashV3(manifest)) !==
      fixedMetadata.revisionContentHash
    )
      throw new V3RemoteDeterministicError("SNAPSHOT_HASH_MISMATCH");
  }

  private assertSnapshotBudgets(
    metadata: {
      folderCount: string;
      pageCount: string;
      attachmentCount: string;
      revisionManifestByteLength: string;
      revisionBodyBytes: string;
      revisionAttachmentBytes: string;
    },
    folderCount: number,
    pageCount: number,
    attachmentCount: number,
  ): void {
    const limits = this.selection.capabilities;
    if (
      decimal(metadata.folderCount, "SNAPSHOT_COUNT_INVALID") >
        BigInt(limits.maxClientSpaceFolders) ||
      decimal(metadata.pageCount, "SNAPSHOT_COUNT_INVALID") >
        BigInt(limits.maxClientSpacePages) ||
      decimal(metadata.folderCount, "SNAPSHOT_COUNT_INVALID") +
        decimal(metadata.pageCount, "SNAPSHOT_COUNT_INVALID") +
        decimal(metadata.attachmentCount, "SNAPSHOT_COUNT_INVALID") >
        BigInt(limits.maxSnapshotObjects) ||
      decimal(metadata.attachmentCount, "SNAPSHOT_COUNT_INVALID") >
        BigInt(
          Math.min(
            limits.maxRevisionAttachments,
            TREE_SYNC_V3_HARD_LIMITS.maxRevisionAttachments,
          ),
        ) ||
      folderCount > limits.maxClientSpaceFolders ||
      pageCount > limits.maxClientSpacePages ||
      folderCount + pageCount + attachmentCount > limits.maxSnapshotObjects ||
      attachmentCount >
        Math.min(
          limits.maxRevisionAttachments,
          TREE_SYNC_V3_HARD_LIMITS.maxRevisionAttachments,
        ) ||
      decimal(metadata.revisionManifestByteLength, "SNAPSHOT_BYTES_INVALID") >
        BigInt(limits.maxClientManifestBytes) ||
      decimal(metadata.revisionBodyBytes, "SNAPSHOT_BYTES_INVALID") >
        BigInt(limits.maxClientTotalBodyBytes)
    )
      throw new V3RemoteDeterministicError("SNAPSHOT_LIMIT_EXCEEDED");
  }

  private assertPageItems(
    pages: SyncPageV3[],
    attachments: SyncAttachmentV3[],
  ): void {
    const limits = this.selection.capabilities;
    for (const page of pages)
      if (new TextEncoder().encode(page.body).byteLength > limits.maxPageBytes)
        throw new V3RemoteDeterministicError("PAGE_LIMIT_EXCEEDED");
    for (const attachment of attachments) {
      const size = decimal(attachment.sizeBytes, "ATTACHMENT_BYTES_INVALID");
      if (
        size >
          BigInt(
            Math.min(
              limits.maxAttachmentBytes,
              TREE_SYNC_V3_HARD_LIMITS.maxAttachmentBytes,
            ),
          ) ||
        attachment.width >
          Math.min(
            limits.maxImageDimension,
            TREE_SYNC_V3_HARD_LIMITS.maxImageDimension,
          ) ||
        attachment.height >
          Math.min(
            limits.maxImageDimension,
            TREE_SYNC_V3_HARD_LIMITS.maxImageDimension,
          ) ||
        attachment.width * attachment.height >
          Math.min(
            limits.maxDecodedPixels,
            TREE_SYNC_V3_HARD_LIMITS.maxDecodedPixels,
          ) ||
        !limits.allowedMimeTypes.includes(attachment.mimeType)
      )
        throw new V3RemoteDeterministicError("ATTACHMENT_LIMIT_EXCEEDED");
    }
  }

  private assertDeltaTargetBudgets(page: {
    toFolderCount: string;
    toPageCount: string;
    toAttachmentCount: string;
    toRevisionManifestByteLength: string;
    toRevisionBodyBytes: string;
    toRevisionAttachmentBytes: string;
  }): void {
    const limits = this.selection.capabilities;
    const folderCount = decimal(page.toFolderCount, "DELTA_COUNT_INVALID");
    const pageCount = decimal(page.toPageCount, "DELTA_COUNT_INVALID");
    const attachmentCount = decimal(
      page.toAttachmentCount,
      "DELTA_COUNT_INVALID",
    );
    if (
      folderCount > BigInt(limits.maxClientSpaceFolders) ||
      pageCount > BigInt(limits.maxClientSpacePages) ||
      folderCount + pageCount + attachmentCount >
        BigInt(limits.maxSnapshotObjects) ||
      attachmentCount >
        BigInt(
          Math.min(
            limits.maxRevisionAttachments,
            TREE_SYNC_V3_HARD_LIMITS.maxRevisionAttachments,
          ),
        ) ||
      decimal(page.toRevisionManifestByteLength, "DELTA_BYTES_INVALID") >
        BigInt(limits.maxClientManifestBytes) ||
      decimal(page.toRevisionBodyBytes, "DELTA_BYTES_INVALID") >
        BigInt(limits.maxClientTotalBodyBytes)
    )
      throw new V3RemoteDeterministicError("DELTA_LIMIT_EXCEEDED");
  }

  async delta(fromRevision: string): Promise<TreeDeltaV3> {
    let cursor: string | null = null;
    let fixedSignature: string | null = null;
    let toRevision = fromRevision;
    const cursors = new Set<string>();
    const entities = new Set<string>();
    const items: TreeDeltaItemV3[] = [];
    const metadataKeys = [
      "protocolVersion",
      "spaceId",
      "fromRevision",
      "toRevision",
      "toSequence",
      "toRevisionContentHash",
      "toFolderCount",
      "toPageCount",
      "toAttachmentCount",
      "toRevisionManifestByteLength",
      "toRevisionBodyBytes",
      "toRevisionAttachmentBytes",
    ];
    do {
      const query = new URLSearchParams({ from: fromRevision });
      if (cursor) query.set("cursor", cursor);
      const parsed = TreeDeltaPageV3Schema.parse(
        await this.strictJson(
          "GET",
          `/api/sync/v3/spaces/${encodeURIComponent(this.spaceId)}/delta?${query}`,
          undefined,
          false,
          true,
        ),
      );
      if (parsed.spaceId !== this.spaceId)
        throw new V3RemoteDeterministicError("DELTA_SPACE_MISMATCH");
      if (parsed.fromRevision !== fromRevision)
        throw new V3RemoteDeterministicError("DELTA_METADATA_CHANGED");
      if (parsed.items.length > this.selection.capabilities.maxPageItems)
        throw new V3RemoteDeterministicError("DELTA_PAGE_LIMIT_EXCEEDED");
      const signature = metadataSignature(parsed, metadataKeys);
      if (fixedSignature !== null && fixedSignature !== signature)
        throw new V3RemoteDeterministicError("DELTA_METADATA_CHANGED");
      fixedSignature = signature;
      toRevision = parsed.toRevision;
      this.assertDeltaTargetBudgets(parsed);
      for (const item of parsed.items) {
        if (item.operation === "upsert_page")
          this.assertPageItems([item.page], []);
        else if (item.operation === "upsert_attachment")
          this.assertPageItems([], [item.attachment]);
      }
      for (const item of parsed.items) {
        const key = deltaEntityKey(item);
        if (entities.has(key))
          throw new V3RemoteDeterministicError("DELTA_ENTITY_REPEATED");
        entities.add(key);
        items.push(item);
        if (items.length > this.selection.capabilities.maxDeltaItems)
          throw new V3RemoteDeterministicError("DELTA_LIMIT_EXCEEDED");
      }
      const next = parsed.nextCursor;
      if (next !== null) {
        if (cursors.has(next))
          throw new V3RemoteDeterministicError("CURSOR_REPEATED");
        cursors.add(next);
      }
      cursor = next;
    } while (cursor !== null);
    return { toRevision, items };
  }

  async bootstrapPreview(): Promise<TreeBootstrapPreviewV3> {
    return TreeBootstrapPreviewV3Schema.parse(
      await this.strictJson(
        "GET",
        `/api/sync/v3/spaces/${encodeURIComponent(this.spaceId)}/bootstrap-preview`,
        undefined,
        false,
        true,
      ),
    );
  }

  async bootstrapConfirmed(input: {
    baseRevision: string;
    confirmationHash: string;
    userConfirmed: true;
  }): Promise<TreeFinalizeResultV3> {
    const body = TreeBootstrapRequestV3Schema.parse({
      protocolVersion: "3",
      ...input,
    });
    return finalizeResult(
      TreeFinalizePushResponseV3Schema.parse(
        await this.strictJson(
          "POST",
          `/api/sync/v3/spaces/${encodeURIComponent(this.spaceId)}/bootstrap`,
          body,
          true,
        ),
      ),
    );
  }

  async createPushSession(
    input: TreeCreatePushSessionV3,
  ): Promise<TreePushSessionV3> {
    const body = CreateTreePushSessionRequestV3Schema.parse(input);
    const value = CreateTreePushSessionResponseV3Schema.parse(
      await this.strictJson(
        "POST",
        `/api/sync/v3/spaces/${encodeURIComponent(this.spaceId)}/push-sessions`,
        body,
        true,
      ),
    );
    return value;
  }

  async uploadBatch(
    sessionId: string,
    batch: Parameters<TreeRemotePortV3["uploadBatch"]>[1],
  ): Promise<{ receipt: string }> {
    const body = TreePushBatchV3Schema.parse(batch);
    const value = TreePushBatchReceiptV3Schema.parse(
      await this.strictJson(
        "PUT",
        `/api/sync/v3/spaces/${encodeURIComponent(this.spaceId)}/push-sessions/${encodeURIComponent(sessionId)}/batches/${body.batchIndex}`,
        body,
        true,
      ),
    );
    if (
      value.sessionId !== sessionId ||
      value.batchIndex !== body.batchIndex ||
      value.batchHash !== body.batchHash
    )
      throw new V3RemoteDeterministicError("BATCH_RECEIPT_MISMATCH");
    return { receipt: value.receipt };
  }

  async finalize(
    sessionId: string,
    confirmationHash: string,
  ): Promise<TreeFinalizeResultV3> {
    const body = TreeFinalizePushRequestV3Schema.parse({
      protocolVersion: "3",
      confirmationHash,
      userConfirmed: true,
    });
    return finalizeResult(
      TreeFinalizePushResponseV3Schema.parse(
        await this.strictJson(
          "POST",
          `/api/sync/v3/spaces/${encodeURIComponent(this.spaceId)}/push-sessions/${encodeURIComponent(sessionId)}/finalize`,
          body,
          true,
        ),
      ),
    );
  }

  async getSession(sessionId: string): Promise<TreePushSessionStatusV3> {
    const value = TreePushSessionStatusResponseV3Schema.parse(
      await this.strictJson(
        "GET",
        `/api/sync/v3/spaces/${encodeURIComponent(this.spaceId)}/push-sessions/${encodeURIComponent(sessionId)}`,
        undefined,
        false,
        true,
      ),
    );
    if (value.sessionId !== sessionId)
      throw new V3RemoteDeterministicError("SESSION_RESPONSE_MISMATCH");
    return {
      ...value,
      result: value.result ? finalizeResult(value.result) : null,
    };
  }

  async abort(sessionId: string): Promise<void> {
    let status: number;
    try {
      status = await this.client.noContent(
        "DELETE",
        `/api/sync/v3/spaces/${encodeURIComponent(this.spaceId)}/push-sessions/${encodeURIComponent(sessionId)}`,
        this.selection.capabilities.maxResponseBytes,
      );
    } catch (error) {
      if (error instanceof AgentWikiHttpError) {
        const parsed = SyncV3ErrorEnvelopeSchema.safeParse(error.body);
        if (!parsed.success)
          throw new V3RemoteDeterministicError("V3_ERROR_RESPONSE_INVALID");
        throw new AgentWikiHttpError(
          error.status,
          parsed.data,
          error.headers,
          error.message,
        );
      }
      throw error;
    }
    if (status !== 204)
      throw new V3RemoteDeterministicError("ABORT_RESPONSE_INVALID");
  }

  async uploadBlobChunk(
    sessionId: string,
    contentHash: string,
    chunkIndex: number,
    bytes: Uint8Array,
  ) {
    if (
      bytes.byteLength < 1 ||
      bytes.byteLength > this.selection.capabilities.blobChunkBytes ||
      !Number.isInteger(chunkIndex) ||
      chunkIndex < 0 ||
      chunkIndex >= this.selection.capabilities.maxBlobChunks
    )
      throw new V3RemoteDeterministicError("BLOB_CHUNK_LIMIT_EXCEEDED");
    let response: unknown;
    try {
      response = (
        await this.client.uploadBinary(
          "PUT",
          `/api/sync/v3/spaces/${encodeURIComponent(this.spaceId)}/push-sessions/${encodeURIComponent(sessionId)}/blobs/${encodeURIComponent(contentHash)}/chunks/${chunkIndex}`,
          bytes,
          this.selection.capabilities.maxResponseBytes,
        )
      ).json;
    } catch (error) {
      if (error instanceof AgentWikiHttpError) {
        const parsed = SyncV3ErrorEnvelopeSchema.safeParse(error.body);
        if (!parsed.success)
          throw new V3RemoteDeterministicError("V3_ERROR_RESPONSE_INVALID");
        throw new AgentWikiHttpError(
          error.status,
          parsed.data,
          error.headers,
          error.message,
        );
      }
      throw error;
    }
    const receipt = BlobChunkReceiptV3Schema.parse(response);
    const chunkHash = await blobChunkHashV3(bytes);
    if (
      receipt.contentHash !== contentHash ||
      receipt.chunkIndex !== chunkIndex ||
      receipt.chunkHash !== chunkHash
    )
      throw new V3RemoteDeterministicError("BLOB_CHUNK_RECEIPT_MISMATCH");
    return receipt;
  }

  async completeBlob(
    sessionId: string,
    requirement: BlobRequirementV3,
    chunkCount: number,
  ) {
    const expected = BlobRequirementV3Schema.parse(requirement);
    const body = CompleteBlobRequestV3Schema.parse({
      protocolVersion: "3",
      contentHash: expected.contentHash,
      sizeBytes: expected.sizeBytes,
      chunkCount,
    });
    const completed = CompletedBlobV3Schema.parse(
      await this.strictJson(
        "POST",
        `/api/sync/v3/spaces/${encodeURIComponent(this.spaceId)}/push-sessions/${encodeURIComponent(sessionId)}/blobs/${expected.contentHash}/complete`,
        body,
        true,
      ),
    );
    if (
      completed.contentHash !== expected.contentHash ||
      completed.sizeBytes !== expected.sizeBytes ||
      completed.mimeType !== expected.mimeType ||
      completed.width !== expected.width ||
      completed.height !== expected.height
    )
      throw new V3RemoteDeterministicError("BLOB_COMPLETE_MISMATCH");
    return completed;
  }

  async downloadBlob(input: {
    revision: string;
    attachmentId: string;
    contentHash: string;
  }): Promise<Uint8Array> {
    if (input.revision === "current")
      throw new V3RemoteDeterministicError("DOWNLOAD_REVISION_NOT_FIXED");
    const bytes = await retryRead(
      async () => {
        try {
          return await this.client.downloadBinary(
            `/api/sync/v3/spaces/${encodeURIComponent(this.spaceId)}/revisions/${encodeURIComponent(input.revision)}/attachments/${encodeURIComponent(input.attachmentId)}/content`,
            Math.min(
              this.selection.capabilities.maxAttachmentBytes,
              TREE_SYNC_V3_HARD_LIMITS.maxAttachmentBytes,
            ),
          );
        } catch (error) {
          if (error instanceof AgentWikiHttpError) {
            const parsed = SyncV3ErrorEnvelopeSchema.safeParse(error.body);
            if (!parsed.success)
              throw new V3RemoteDeterministicError("V3_ERROR_RESPONSE_INVALID");
            throw new AgentWikiHttpError(
              error.status,
              parsed.data,
              error.headers,
              error.message,
            );
          }
          throw error;
        }
      },
      this.retryPolicy,
      this.sleep,
    );
    if ((await blobContentHashV3(bytes)) !== input.contentHash)
      throw new V3RemoteDeterministicError("DOWNLOAD_HASH_MISMATCH");
    return bytes;
  }
}
