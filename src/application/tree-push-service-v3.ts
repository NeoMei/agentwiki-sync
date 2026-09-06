import {
  BlobChunkReceiptV3Schema,
  BlobRequirementV3Schema,
  CreateTreePushSessionRequestV3Schema,
  TreeFinalizePushResponseV3Schema,
  TreePushChangeV3Schema,
  TreePushManifestChangeV3Schema,
  TreeSyncCapabilitiesV3Schema,
  canonicalTreeDeltaItemsV3,
  treeBatchHashV3,
  treeCapabilitiesHashV3,
  treeConfirmationHashV3,
  type BlobRequirementV3,
  type TreePushChangeV3,
  type TreePushConfirmationManifestV3,
  type TreeSyncCapabilitiesV3,
} from "@neomei/agentwiki-sync-protocol";

import { AgentWikiHttpError } from "../agentwiki/client";
import { canonicalBytes, contentHash } from "../agentwiki/protocol";
import { opaqueFileKey } from "../core/identity-key";
import type {
  TreeAttachment,
  TreeFolder,
  TreePageV3,
} from "../core/tree-model";
import type { ControlStorePort } from "../ports/control-store";
import type {
  TreeFinalizeResultV3,
  TreeRemotePortV3,
} from "../ports/tree-remote";
import { BlobStagingRepository } from "../storage/blob-staging";
import { MutableControlRepository } from "../storage/envelope";
import { BlobTransfer } from "./blob-transfer";
import {
  progressCheckpoint,
  reportProgress,
  SyncCancelledError,
  type SyncOperationOptions,
} from "./progress";

const encoder = new TextEncoder();

type PreparedTreePageV3 = Omit<TreePageV3, "body"> & {
  payloadPath: string;
  bodyBytes: number;
};

export type PreparedTreePushChangeV3 =
  | { operation: "upsert_folder"; folder: TreeFolder }
  | { operation: "archive_folder"; folderId: string; previousPath: string }
  | {
      operation: "upsert_attachment";
      attachment: TreeAttachment;
      vaultPath: string;
    }
  | { operation: "upsert_page"; page: PreparedTreePageV3 }
  | { operation: "archive_page"; pageId: string; previousPath: string }
  | {
      operation: "detach_attachment";
      attachmentId: string;
      previousPath: string;
    };

export interface TreePushPreviewV3 {
  protocolVersion: "3";
  spaceId: string;
  baseRevision: string;
  changes: PreparedTreePushChangeV3[];
  capabilities: TreeSyncCapabilitiesV3;
  capabilitiesHash: string;
  confirmationHash: string;
  credentialId?: string | null;
  previewId?: string;
}

export interface TreePushJournalV3 {
  schemaVersion: 3;
  protocolVersion: "3";
  spaceId: string;
  baseRevision: string;
  idempotencyKey: string;
  confirmationHash: string;
  capabilitiesHash: string;
  capabilities: TreeSyncCapabilitiesV3;
  changes: PreparedTreePushChangeV3[];
  requiredBlobs: Record<
    string,
    {
      vaultPath: string;
      sizeBytes: number;
      chunkReceipts: Record<string, string>;
      completed: boolean;
    }
  >;
  blobRequirements: BlobRequirementV3[];
  totalBodyBytes: number;
  attachmentCount: number;
  transferBlobBytes: number;
  sessionId: string | null;
  credentialIdAtCreation: string | null;
  remoteState:
    | "not_created"
    | "uploading_blobs"
    | "uploading_changes"
    | "finalizing"
    | "published"
    | "superseded";
  result: TreeFinalizeResultV3 | null;
  finalizeRejectionCode?: "ATTACHMENT_NAME_CONFLICT";
  localCommitPhase: "not_started" | "verified";
}

export interface TreePushLocalPortV3 {
  readBlob(vaultPath: string): Promise<Uint8Array | null>;
  revalidateConfirmation(input: {
    spaceId: string;
    baseRevision: string;
    capabilitiesHash: string;
    changes: PreparedTreePushChangeV3[];
  }): Promise<string>;
}

function recordWithOnlyKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function toManifestChangeV3(
  change: PreparedTreePushChangeV3,
): TreePushConfirmationManifestV3["changes"][number] {
  switch (change.operation) {
    case "upsert_folder":
      return { operation: change.operation, folder: change.folder };
    case "archive_folder":
      return {
        operation: change.operation,
        folderId: change.folderId,
        previousPath: change.previousPath,
      };
    case "upsert_attachment":
      return { operation: change.operation, attachment: change.attachment };
    case "upsert_page": {
      const {
        payloadPath: _payloadPath,
        bodyBytes: _bodyBytes,
        ...page
      } = change.page;
      return { operation: change.operation, page };
    }
    case "archive_page":
      return {
        operation: change.operation,
        pageId: change.pageId,
        previousPath: change.previousPath,
      };
    case "detach_attachment":
      return {
        operation: change.operation,
        attachmentId: change.attachmentId,
        previousPath: change.previousPath,
      };
  }
}

function isPreparedTreePushChangeV3(
  value: unknown,
): value is PreparedTreePushChangeV3 {
  if (
    !recordWithOnlyKeys(value, ["operation", "folder"]) &&
    !recordWithOnlyKeys(value, ["operation", "folderId", "previousPath"]) &&
    !recordWithOnlyKeys(value, ["operation", "attachment", "vaultPath"]) &&
    !recordWithOnlyKeys(value, ["operation", "page"]) &&
    !recordWithOnlyKeys(value, ["operation", "pageId", "previousPath"]) &&
    !recordWithOnlyKeys(value, ["operation", "attachmentId", "previousPath"])
  )
    return false;
  const change = value;
  if (change.operation === "upsert_attachment") {
    if (typeof change.vaultPath !== "string") return false;
    return TreePushManifestChangeV3Schema.safeParse({
      operation: change.operation,
      attachment: change.attachment,
    }).success;
  }
  if (change.operation === "upsert_page") {
    if (
      !recordWithOnlyKeys(change.page, [
        "pageId",
        "folderId",
        "path",
        "title",
        "contentHash",
        "updatedAt",
        "referencedAttachmentIds",
        "payloadPath",
        "bodyBytes",
      ])
    )
      return false;
    const { payloadPath, bodyBytes, ...page } = change.page;
    return (
      typeof payloadPath === "string" &&
      Number.isSafeInteger(bodyBytes) &&
      Number(bodyBytes) >= 0 &&
      TreePushManifestChangeV3Schema.safeParse({
        operation: change.operation,
        page,
      }).success
    );
  }
  return TreePushManifestChangeV3Schema.safeParse(change).success;
}

function isTreePushJournalV3(value: unknown): value is TreePushJournalV3 {
  if (
    !recordWithOnlyKeys(value, [
      "schemaVersion",
      "protocolVersion",
      "spaceId",
      "baseRevision",
      "idempotencyKey",
      "confirmationHash",
      "capabilitiesHash",
      "capabilities",
      "changes",
      "requiredBlobs",
      "blobRequirements",
      "totalBodyBytes",
      "attachmentCount",
      "transferBlobBytes",
      "sessionId",
      "credentialIdAtCreation",
      "remoteState",
      "result",
      "finalizeRejectionCode",
      "localCommitPhase",
    ])
  )
    return false;
  if (
    value.schemaVersion !== 3 ||
    value.protocolVersion !== "3" ||
    typeof value.spaceId !== "string" ||
    typeof value.baseRevision !== "string" ||
    typeof value.idempotencyKey !== "string" ||
    typeof value.confirmationHash !== "string" ||
    typeof value.capabilitiesHash !== "string" ||
    !TreeSyncCapabilitiesV3Schema.safeParse(value.capabilities).success ||
    !Array.isArray(value.changes) ||
    !value.changes.every(isPreparedTreePushChangeV3) ||
    !recordWithOnlyKeys(
      value.requiredBlobs,
      Object.keys(value.requiredBlobs ?? {}),
    ) ||
    !Array.isArray(value.blobRequirements) ||
    !value.blobRequirements.every(
      (item) => BlobRequirementV3Schema.safeParse(item).success,
    ) ||
    !Number.isSafeInteger(value.totalBodyBytes) ||
    Number(value.totalBodyBytes) < 0 ||
    !Number.isSafeInteger(value.attachmentCount) ||
    Number(value.attachmentCount) < 0 ||
    !Number.isSafeInteger(value.transferBlobBytes) ||
    Number(value.transferBlobBytes) < 0 ||
    (value.sessionId !== null && typeof value.sessionId !== "string") ||
    (value.credentialIdAtCreation !== null &&
      typeof value.credentialIdAtCreation !== "string") ||
    ![
      "not_created",
      "uploading_blobs",
      "uploading_changes",
      "finalizing",
      "published",
      "superseded",
    ].includes(String(value.remoteState)) ||
    (value.result !== null &&
      !TreeFinalizePushResponseV3Schema.safeParse(value.result).success) ||
    (value.finalizeRejectionCode !== undefined &&
      value.finalizeRejectionCode !== "ATTACHMENT_NAME_CONFLICT") ||
    (value.localCommitPhase !== "not_started" &&
      value.localCommitPhase !== "verified")
  )
    return false;
  for (const [hash, raw] of Object.entries(value.requiredBlobs)) {
    if (
      !/^[a-f0-9]{64}$/u.test(hash) ||
      !recordWithOnlyKeys(raw, [
        "vaultPath",
        "sizeBytes",
        "chunkReceipts",
        "completed",
      ]) ||
      typeof raw.vaultPath !== "string" ||
      !Number.isSafeInteger(raw.sizeBytes) ||
      Number(raw.sizeBytes) < 1 ||
      !recordWithOnlyKeys(
        raw.chunkReceipts,
        Object.keys(raw.chunkReceipts ?? {}),
      ) ||
      Object.entries(raw.chunkReceipts).some(
        ([index, receipt]) =>
          !/^\d+$/u.test(index) || typeof receipt !== "string",
      ) ||
      typeof raw.completed !== "boolean"
    )
      return false;
  }
  return true;
}

function deterministicFinalizeRejectionCode(
  error: unknown,
): "ATTACHMENT_NAME_CONFLICT" | null {
  if (!(error instanceof AgentWikiHttpError)) return null;
  if (!error.body || typeof error.body !== "object") return null;
  const envelope = error.body as {
    protocolVersion?: unknown;
    error?: { code?: unknown; retryable?: unknown };
  };
  return envelope.protocolVersion === "3" &&
    envelope.error?.code === "ATTACHMENT_NAME_CONFLICT" &&
    envelope.error.retryable === false
    ? "ATTACHMENT_NAME_CONFLICT"
    : null;
}

function v3Manifest(
  journal: Pick<
    TreePushJournalV3,
    "spaceId" | "baseRevision" | "capabilitiesHash" | "changes"
  >,
): TreePushConfirmationManifestV3 {
  return {
    protocolVersion: "3",
    spaceId: journal.spaceId,
    baseRevision: journal.baseRevision,
    capabilitiesHash: journal.capabilitiesHash,
    changes: journal.changes.map(toManifestChangeV3),
  };
}

/** Strict v3 coordinator; the frozen v1/v2 TreePushService stays unchanged. */
export class TreePushServiceV3 {
  private readonly journal: MutableControlRepository<TreePushJournalV3>;
  private receiptWriteQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly remote: TreeRemotePortV3,
    private readonly store: ControlStorePort,
    private readonly root: string,
    private readonly local: TreePushLocalPortV3,
  ) {
    this.journal = new MutableControlRepository(
      store,
      `${root}/journal.json`,
      isTreePushJournalV3,
    );
  }

  private async save(journal: TreePushJournalV3): Promise<void> {
    await this.journal.write(structuredClone(journal));
  }

  private async persistReceipt(
    journal: TreePushJournalV3,
    raw: unknown,
  ): Promise<void> {
    const receipt = BlobChunkReceiptV3Schema.parse(raw);
    const operation = this.receiptWriteQueue.then(async () => {
      const entry = journal.requiredBlobs[receipt.contentHash];
      if (!entry) throw new Error("BLOB_RECEIPT_RESUME_MISMATCH");
      entry.chunkReceipts[String(receipt.chunkIndex)] = receipt.receipt;
      await this.save(journal);
    });
    this.receiptWriteQueue = operation.catch(() => undefined);
    await operation;
  }

  private async load(): Promise<TreePushJournalV3> {
    const raw = await this.store.read(`${this.root}/journal.json`);
    const version = readJournalSchemaVersion(raw);
    if (version !== null && version !== 3)
      throw new Error("不支持的推送日志版本");
    const value = await this.journal.read();
    if (!value) throw new Error("推送日志缺失或已损坏");
    return value.payload;
  }

  async inspect(): Promise<Pick<
    TreePushJournalV3,
    "remoteState" | "result" | "localCommitPhase" | "credentialIdAtCreation"
  > | null> {
    const value = await this.journal.read();
    return value
      ? {
          remoteState: value.payload.remoteState,
          result: value.payload.result,
          localCommitPhase: value.payload.localCommitPhase,
          credentialIdAtCreation: value.payload.credentialIdAtCreation,
        }
      : null;
  }

  private async pagePayloadPath(pageId: string): Promise<string> {
    return `${this.root}/payload/${await opaqueFileKey(pageId)}.md`;
  }

  private requirements(changes: PreparedTreePushChangeV3[]): {
    requirements: BlobRequirementV3[];
    requiredBlobs: TreePushJournalV3["requiredBlobs"];
    attachmentCount: number;
    transferBlobBytes: number;
  } {
    const byHash = new Map<
      string,
      { requirement: BlobRequirementV3; vaultPath: string }
    >();
    let attachmentCount = 0;
    for (const change of changes) {
      if (change.operation !== "upsert_attachment") continue;
      attachmentCount += 1;
      const requirement = BlobRequirementV3Schema.parse({
        contentHash: change.attachment.contentHash,
        sizeBytes: change.attachment.sizeBytes,
        mimeType: change.attachment.mimeType,
        width: change.attachment.width,
        height: change.attachment.height,
      });
      const prior = byHash.get(requirement.contentHash);
      if (
        prior &&
        JSON.stringify(prior.requirement) !== JSON.stringify(requirement)
      )
        throw new Error("BLOB_HASH_METADATA_MISMATCH");
      if (!prior || change.vaultPath.localeCompare(prior.vaultPath) < 0)
        byHash.set(requirement.contentHash, {
          requirement,
          vaultPath: change.vaultPath,
        });
    }
    const ordered = [...byHash.values()].sort((left, right) =>
      left.requirement.contentHash.localeCompare(right.requirement.contentHash),
    );
    const requirements = ordered.map((item) => item.requirement);
    const requiredBlobs = Object.fromEntries(
      ordered.map((item) => [
        item.requirement.contentHash,
        {
          vaultPath: item.vaultPath,
          sizeBytes: Number(item.requirement.sizeBytes),
          chunkReceipts: {},
          completed: false,
        },
      ]),
    );
    const transferBlobBytes = requirements.reduce(
      (total, item) => total + Number(item.sizeBytes),
      0,
    );
    return { requirements, requiredBlobs, attachmentCount, transferBlobBytes };
  }

  private async stage(input: TreePushPreviewV3): Promise<TreePushJournalV3> {
    const capabilityDigest = await treeCapabilitiesHashV3(input.capabilities);
    if (
      capabilityDigest !== input.capabilitiesHash ||
      capabilityDigest !== (await this.remote.capabilitiesHash)
    )
      throw new Error("CAPABILITIES_CHANGED");
    const changes: PreparedTreePushChangeV3[] = [];
    let totalBodyBytes = 0;
    for (const change of input.changes) {
      if (change.operation !== "upsert_page") {
        changes.push(structuredClone(change));
        continue;
      }
      const body = await this.store.read(change.page.payloadPath);
      if (
        body === null ||
        (await contentHash(body)) !== change.page.contentHash
      )
        throw new Error("推送预览数据损坏");
      const bodyBytes = encoder.encode(body).byteLength;
      if (bodyBytes !== change.page.bodyBytes)
        throw new Error("推送预览数据长度变化");
      if (bodyBytes > input.capabilities.maxPageBytes)
        throw new RangeError("PAGE_TOO_LARGE");
      const payloadPath = await this.pagePayloadPath(change.page.pageId);
      await this.store.write(payloadPath, body);
      totalBodyBytes += bodyBytes;
      changes.push({
        operation: "upsert_page",
        page: {
          ...change.page,
          referencedAttachmentIds: [
            ...new Set(change.page.referencedAttachmentIds),
          ].sort(),
          payloadPath,
          bodyBytes,
        },
      });
    }
    const blob = this.requirements(changes);
    if (
      changes.length > input.capabilities.maxChangeCount ||
      totalBodyBytes > input.capabilities.maxClientTotalBodyBytes ||
      blob.attachmentCount > input.capabilities.maxRevisionAttachments ||
      blob.transferBlobBytes > input.capabilities.maxTransferBlobBytes ||
      blob.requirements.some(
        (item) =>
          Number(item.sizeBytes) > input.capabilities.maxAttachmentBytes ||
          Math.ceil(
            Number(item.sizeBytes) / input.capabilities.blobChunkBytes,
          ) > input.capabilities.maxBlobChunks ||
          !input.capabilities.allowedMimeTypes.includes(item.mimeType) ||
          item.width > input.capabilities.maxImageDimension ||
          item.height > input.capabilities.maxImageDimension ||
          item.width * item.height > input.capabilities.maxDecodedPixels,
      )
    )
      throw new RangeError("BLOB_LIMIT_EXCEEDED");
    const journal: TreePushJournalV3 = {
      schemaVersion: 3,
      protocolVersion: "3",
      spaceId: input.spaceId,
      baseRevision: input.baseRevision,
      idempotencyKey: crypto.randomUUID(),
      confirmationHash: input.confirmationHash,
      capabilitiesHash: input.capabilitiesHash,
      capabilities: structuredClone(input.capabilities),
      changes,
      requiredBlobs: blob.requiredBlobs,
      blobRequirements: blob.requirements,
      totalBodyBytes,
      attachmentCount: blob.attachmentCount,
      transferBlobBytes: blob.transferBlobBytes,
      sessionId: null,
      credentialIdAtCreation: input.credentialId ?? null,
      remoteState: "not_created",
      result: null,
      localCommitPhase: "not_started",
    };
    if (
      (await treeConfirmationHashV3(v3Manifest(journal))) !==
      input.confirmationHash
    )
      throw new Error("CONFIRMATION_MISMATCH");
    if (
      canonicalBytes(v3Manifest(journal)).byteLength >
      input.capabilities.maxConfirmationBytes
    )
      throw new RangeError("BATCH_TOO_LARGE");
    return journal;
  }

  private createInput(journal: TreePushJournalV3) {
    return CreateTreePushSessionRequestV3Schema.parse({
      protocolVersion: "3",
      baseRevision: journal.baseRevision,
      idempotencyKey: journal.idempotencyKey,
      capabilitiesHash: journal.capabilitiesHash,
      confirmationHash: journal.confirmationHash,
      confirmationByteLength: canonicalBytes(v3Manifest(journal)).byteLength,
      changeCount: journal.changes.length,
      totalBodyBytes: journal.totalBodyBytes,
      attachmentCount: journal.attachmentCount,
      transferBlobBytes: journal.transferBlobBytes,
      blobRequirements: journal.blobRequirements,
    });
  }

  private async assertCurrent(journal: TreePushJournalV3): Promise<void> {
    const actual = await this.local.revalidateConfirmation({
      spaceId: journal.spaceId,
      baseRevision: journal.baseRevision,
      capabilitiesHash: journal.capabilitiesHash,
      changes: journal.changes,
    });
    if (actual !== journal.confirmationHash)
      throw new Error("CONFIRMATION_MISMATCH");
  }

  private async hydrate(
    change: PreparedTreePushChangeV3,
  ): Promise<TreePushChangeV3> {
    if (change.operation !== "upsert_page")
      return TreePushChangeV3Schema.parse(toManifestChangeV3(change));
    const body = await this.store.read(change.page.payloadPath);
    if (body === null || (await contentHash(body)) !== change.page.contentHash)
      throw new Error("推送负载已损坏");
    const {
      payloadPath: _payloadPath,
      bodyBytes: _bodyBytes,
      ...page
    } = change.page;
    return TreePushChangeV3Schema.parse({
      operation: "upsert_page",
      page: { ...page, body },
    });
  }

  private async batches(journal: TreePushJournalV3) {
    const hydrated = await Promise.all(
      journal.changes.map((item) => this.hydrate(item)),
    );
    const ordered = canonicalTreeDeltaItemsV3(hydrated) as TreePushChangeV3[];
    if (ordered.length > journal.capabilities.maxChangeCount)
      throw new RangeError("BATCH_TOO_LARGE");
    const result: Array<{
      protocolVersion: "3";
      batchIndex: number;
      changes: TreePushChangeV3[];
      batchHash: string;
    }> = [];
    let current: TreePushChangeV3[] = [];
    const flush = async () => {
      if (!current.length) return;
      const batchIndex = result.length;
      const withoutHash = {
        protocolVersion: "3" as const,
        batchIndex,
        changes: current,
      };
      result.push({
        ...withoutHash,
        batchHash: await treeBatchHashV3(withoutHash),
      });
      current = [];
    };
    for (const change of ordered) {
      const proposed = [...current, change];
      const batchIndex = result.length;
      const bytes = canonicalBytes({
        protocolVersion: "3",
        batchIndex,
        changes: proposed,
      }).byteLength;
      if (
        proposed.length > journal.capabilities.maxBatchItems ||
        bytes > journal.capabilities.maxBatchBytes
      ) {
        if (!current.length) throw new RangeError("BATCH_TOO_LARGE");
        await flush();
        current = [change];
      } else current = proposed;
    }
    await flush();
    return result;
  }

  private async uploadBlobs(
    journal: TreePushJournalV3,
    missing: string[],
    options?: SyncOperationOptions,
  ): Promise<void> {
    const transfer = new BlobTransfer(
      this.remote,
      new BlobStagingRepository(this.store, `${this.root}/blob-staging`),
      journal.capabilities,
    );
    await transfer.uploadMissing({
      sessionId: journal.sessionId!,
      missingContentHashes: missing.filter(
        (hash) => !journal.requiredBlobs[hash]?.completed,
      ),
      requirements: journal.blobRequirements,
      signal: options?.signal,
      readBlob: async (requirement) => {
        const entry = journal.requiredBlobs[requirement.contentHash];
        if (!entry) return null;
        return this.local.readBlob(entry.vaultPath);
      },
      receiptFor: async (hash, chunkIndex, chunkHash) => {
        const receipt =
          journal.requiredBlobs[hash]?.chunkReceipts[String(chunkIndex)];
        if (!receipt) return null;
        return {
          contentHash: hash,
          chunkIndex,
          chunkHash,
          receipt,
        };
      },
      persistReceipt: async (raw) => {
        await this.persistReceipt(journal, raw);
        await progressCheckpoint(options, {
          phase: "upload_blob",
          completed: Object.values(journal.requiredBlobs).reduce(
            (total, item) => total + Object.keys(item.chunkReceipts).length,
            0,
          ),
          cancellable: true,
        });
      },
    });
    for (const hash of missing) {
      const entry = journal.requiredBlobs[hash];
      if (entry) entry.completed = true;
    }
    await this.save(journal);
  }

  private async uploadChanges(
    journal: TreePushJournalV3,
    received: Set<number>,
    options?: SyncOperationOptions,
  ): Promise<void> {
    const batches = await this.batches(journal);
    let completed = 0;
    for (const batch of batches) {
      if (!received.has(batch.batchIndex))
        await this.remote.uploadBatch(journal.sessionId!, batch);
      completed += 1;
      await progressCheckpoint(options, {
        phase: "upload_changes",
        completed,
        total: batches.length,
        cancellable: true,
      });
    }
  }

  private async commitResult(
    journal: TreePushJournalV3,
    raw: TreeFinalizeResultV3,
  ): Promise<TreeFinalizeResultV3> {
    const result = TreeFinalizePushResponseV3Schema.parse(raw);
    journal.remoteState = "published";
    journal.result = result;
    await this.save(journal);
    return result;
  }

  private rejectionError(code: "ATTACHMENT_NAME_CONFLICT"): AgentWikiHttpError {
    return new AgentWikiHttpError(409, {
      protocolVersion: "3",
      error: { code, retryable: false },
    });
  }

  private async resolveFinalizeRejection(
    journal: TreePushJournalV3,
    error: unknown,
    returnAfterSupersede: boolean,
    knownStatus?: Awaited<ReturnType<TreeRemotePortV3["getSession"]>>,
  ): Promise<TreeFinalizeResultV3 | null> {
    const publishedResult = async (
      status: Awaited<ReturnType<TreeRemotePortV3["getSession"]>>,
    ): Promise<TreeFinalizeResultV3 | null> =>
      status.result ? this.commitResult(journal, status.result) : null;
    let status: Awaited<ReturnType<TreeRemotePortV3["getSession"]>>;
    try {
      status =
        knownStatus ?? (await this.remote.getSession(journal.sessionId!));
    } catch {
      throw error;
    }
    const published = await publishedResult(status);
    if (published) return published;
    if (status.status !== "ready_to_finalize") throw error;
    try {
      await this.remote.abort(journal.sessionId!);
    } catch {
      try {
        const raced = await this.remote.getSession(journal.sessionId!);
        const racedResult = await publishedResult(raced);
        if (racedResult) return racedResult;
      } catch {
        // Preserve the durable rejection and finalizing journal for recovery.
      }
      throw error;
    }
    let terminal: Awaited<ReturnType<TreeRemotePortV3["getSession"]>>;
    try {
      terminal = await this.remote.getSession(journal.sessionId!);
    } catch {
      throw error;
    }
    const terminalResult = await publishedResult(terminal);
    if (terminalResult) return terminalResult;
    if (terminal.status !== "aborted" && terminal.status !== "expired")
      throw error;
    journal.remoteState = "superseded";
    await this.save(journal);
    if (returnAfterSupersede) return null;
    throw error;
  }

  private async finalize(
    journal: TreePushJournalV3,
    returnAfterSupersede = false,
  ): Promise<TreeFinalizeResultV3 | null> {
    try {
      return await this.commitResult(
        journal,
        await this.remote.finalize(
          journal.sessionId!,
          journal.confirmationHash,
        ),
      );
    } catch (error) {
      const code = deterministicFinalizeRejectionCode(error);
      if (!code) throw error;
      journal.finalizeRejectionCode = code;
      await this.save(journal);
      return this.resolveFinalizeRejection(
        journal,
        error,
        returnAfterSupersede,
      );
    }
  }

  private async cancelBeforeFinalize(
    journal: TreePushJournalV3,
    clear: boolean,
  ): Promise<void> {
    if (journal.sessionId) {
      try {
        await this.remote.abort(journal.sessionId);
      } catch {
        // Expiry is an acceptable terminal state for an abandoned session.
      }
    }
    if (clear) {
      await this.journal.clear();
      await this.store.removeTree?.(`${this.root}/payload`);
      return;
    }
    journal.remoteState = "superseded";
    await this.save(journal);
  }

  private async runUploading(
    journal: TreePushJournalV3,
    missing: string[],
    received: Set<number>,
    options?: SyncOperationOptions,
  ): Promise<TreeFinalizeResultV3> {
    journal.remoteState = "uploading_blobs";
    await this.save(journal);
    await this.uploadBlobs(journal, missing, options);
    journal.remoteState = "uploading_changes";
    await this.save(journal);
    await this.uploadChanges(journal, received, options);
    try {
      await this.assertCurrent(journal);
    } catch (error) {
      await this.cancelBeforeFinalize(journal, false);
      throw error;
    }
    journal.remoteState = "finalizing";
    await this.save(journal);
    reportProgress(options, {
      phase: "finalize",
      completed: 0,
      cancellable: false,
    });
    const result = await this.finalize(journal);
    if (!result) throw new Error("PUSH_RECOVERY_REQUIRED");
    return result;
  }

  async publishPrepared(
    input: TreePushPreviewV3,
    options?: SyncOperationOptions,
  ): Promise<TreeFinalizeResultV3> {
    const existing = await this.journal.read();
    if (
      existing &&
      existing.payload.remoteState !== "superseded" &&
      existing.payload.localCommitPhase !== "verified"
    )
      throw new Error("存在未终结的推送，请先执行恢复（recover）");
    let journal = await this.stage(input);
    await this.save(journal);
    journal = await this.load();
    try {
      await progressCheckpoint(options, {
        phase: "upload_blob",
        completed: 0,
        cancellable: true,
      });
      if ((await this.remote.head()).revision !== journal.baseRevision) {
        journal.remoteState = "superseded";
        await this.save(journal);
        throw new Error("BASE_STALE");
      }
      await this.assertCurrent(journal);
      const session = await this.remote.createPushSession(
        this.createInput(journal),
      );
      journal.sessionId = session.sessionId;
      await this.save(journal);
      if (session.status === "published") {
        const terminal = await this.remote.getSession(session.sessionId);
        if (!terminal.result) throw new Error("PUSH_TERMINAL_RESULT_MISSING");
        return this.commitResult(journal, terminal.result);
      }
      if (
        session.status === "ready_to_finalize" ||
        session.status === "finalizing"
      ) {
        journal.remoteState = "finalizing";
        await this.save(journal);
        reportProgress(options, {
          phase: "finalize",
          completed: 0,
          cancellable: false,
        });
        const result = await this.finalize(journal);
        if (!result) throw new Error("PUSH_RECOVERY_REQUIRED");
        return result;
      }
      return await this.runUploading(
        journal,
        session.missingContentHashes,
        new Set(),
        options,
      );
    } catch (error) {
      const cancelled =
        error instanceof SyncCancelledError ||
        options?.signal?.aborted === true;
      if (cancelled && journal.remoteState !== "finalizing") {
        await this.cancelBeforeFinalize(journal, journal.sessionId === null);
        if (!(error instanceof SyncCancelledError))
          throw new SyncCancelledError();
      }
      if (syncErrorCode(error) === "BASE_STALE") {
        journal.remoteState = "superseded";
        await this.save(journal);
      }
      throw error;
    }
  }

  async resumePending(): Promise<TreeFinalizeResultV3 | null> {
    const journal = await this.load();
    if (journal.remoteState === "superseded")
      throw new Error("已取消的推送无法恢复");
    if (journal.remoteState === "published" && journal.result)
      return journal.result;
    if (!journal.sessionId) {
      const session = await this.remote.createPushSession(
        this.createInput(journal),
      );
      journal.sessionId = session.sessionId;
      await this.save(journal);
    }
    const status = await this.remote.getSession(journal.sessionId);
    if (status.result) return this.commitResult(journal, status.result);
    if (journal.finalizeRejectionCode)
      return this.resolveFinalizeRejection(
        journal,
        this.rejectionError(journal.finalizeRejectionCode),
        true,
        status,
      );
    if (status.status === "aborted" || status.status === "expired")
      throw new Error("推送会话无法恢复");
    for (const hash of status.completedContentHashes) {
      const entry = journal.requiredBlobs[hash];
      if (entry) entry.completed = true;
    }
    await this.save(journal);
    if (
      journal.remoteState === "finalizing" ||
      status.status === "ready_to_finalize" ||
      status.status === "finalizing"
    ) {
      if (
        status.status === "ready_to_finalize" &&
        journal.remoteState !== "finalizing"
      ) {
        try {
          await this.assertCurrent(journal);
        } catch (error) {
          await this.cancelBeforeFinalize(journal, false);
          throw error;
        }
      }
      journal.remoteState = "finalizing";
      await this.save(journal);
      return this.finalize(journal, true);
    }
    return this.runUploading(
      journal,
      status.missingContentHashes,
      new Set(status.receivedBatchIndexes),
    );
  }

  async markVerified(): Promise<void> {
    const journal = await this.load();
    if (journal.remoteState !== "published" || !journal.result)
      throw new Error("推送结果未发布");
    journal.localCommitPhase = "verified";
    await this.save(journal);
    for (const dir of ["payload", "blob-staging"])
      try {
        await this.store.removeTree?.(`${this.root}/${dir}`);
      } catch {
        // Terminal metadata remains sufficient after local verification.
      }
  }

  async supersede(): Promise<void> {
    const existing = await this.journal.read();
    if (!existing) return;
    const journal = existing.payload;
    if (
      journal.remoteState === "published" &&
      journal.localCommitPhase === "verified"
    )
      return;
    if (journal.remoteState === "published")
      throw new Error("已发布的推送无法被替代");
    if (journal.remoteState === "superseded") return;
    await this.cancelBeforeFinalize(journal, false);
  }
}

function readJournalSchemaVersion(raw: string | null): number | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { payload?: { schemaVersion?: unknown } };
    const version = parsed.payload?.schemaVersion;
    return typeof version === "number" ? version : null;
  } catch {
    return null;
  }
}

function syncErrorCode(error: unknown): string | null {
  if (!(error instanceof AgentWikiHttpError)) return null;
  const body = error.body;
  if (typeof body !== "object" || body === null) return null;
  const code = (body as { error?: { code?: unknown } }).error?.code;
  return typeof code === "string" ? code : null;
}
