import { z } from "zod";
import { validatePortablePath } from "../../core/portable-path";

const PublicIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const CanonicalIndexSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
const CursorSchema = z.string().max(4096);
const Rfc3339Schema = z.string().datetime({ offset: true });

export const DecimalCountSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine(
    (value) => BigInt(value) <= 9223372036854775807n,
    "Decimal count exceeds signed bigint",
  );
export const DecimalByteCountSchema = DecimalCountSchema;
export const SyncCapabilitiesSchema = z
  .object({
    maxPageBytes: z.number().int(),
    maxBatchBytes: z.number().int(),
    maxBatchItems: z.number().int(),
    maxChangeCount: z.number().int(),
    maxConfirmationBytes: z.number().int(),
    maxClientSpacePages: z.number().int(),
    maxClientManifestBytes: z.number().int(),
    maxClientTotalBodyBytes: z.number().int(),
    maxResponseBytes: z.number().int(),
    maxPageItems: z.number().int(),
    pushSessionTtlSeconds: z.number().int(),
  })
  .passthrough();

export function parseCapabilities(value: unknown) {
  const parsed = SyncCapabilitiesSchema.parse(value);
  if (
    parsed.maxPageBytes !== 1_048_576 ||
    parsed.maxBatchItems < 1 ||
    parsed.maxBatchItems > 100 ||
    parsed.maxBatchBytes < 1_048_576 ||
    parsed.maxBatchBytes > 4_194_304 ||
    parsed.maxResponseBytes < 1_048_576 ||
    parsed.maxResponseBytes > 4_194_304 ||
    parsed.maxPageItems < 1 ||
    parsed.maxPageItems > 200 ||
    parsed.maxChangeCount !== 5_000 ||
    parsed.maxConfirmationBytes < 1_048_576 ||
    parsed.maxConfirmationBytes > 4_194_304 ||
    parsed.maxClientSpacePages !== 5_000 ||
    parsed.maxClientManifestBytes !== 4_194_304 ||
    parsed.maxClientTotalBodyBytes !== 104_857_600 ||
    parsed.pushSessionTtlSeconds < 900 ||
    parsed.pushSessionTtlSeconds > 86_400
  )
    throw new TypeError("Capabilities exceed protocol v1 hard bounds");
  return parsed;
}

const UuidSchema = z.string().uuid();
export const SpaceParamsSchema = z.object({ spaceId: PublicIdSchema }).strict();
export const PushSessionParamsSchema = z
  .object({ spaceId: PublicIdSchema, sessionId: UuidSchema })
  .strict();
export const PushBatchParamsSchema = z
  .object({
    spaceId: PublicIdSchema,
    sessionId: UuidSchema,
    batchIndex: CanonicalIndexSchema,
  })
  .strict();
export const CredentialParamsSchema = z
  .object({ credentialId: UuidSchema })
  .strict();
export const InstallationParamsSchema = z
  .object({ installationId: UuidSchema })
  .strict();
export const SnapshotQuerySchema = z
  .object({
    revision: z.union([z.literal("current"), PublicIdSchema]),
    cursor: CursorSchema.optional(),
    limit: CanonicalIndexSchema.refine(
      (value) => Number(value) >= 1 && Number(value) <= 200,
    ).optional(),
  })
  .strict();
export const DeltaQuerySchema = z
  .object({
    from: PublicIdSchema,
    cursor: CursorSchema.optional(),
    limit: CanonicalIndexSchema.refine(
      (value) => Number(value) >= 1 && Number(value) <= 200,
    ).optional(),
  })
  .strict();
export const CreateObsidianInstallationRequestSchema = z
  .object({
    pluginId: z.literal("agentwiki-sync"),
    requestedProtocolVersion: z.literal("1"),
  })
  .strict();
export const ExchangeObsidianCredentialRequestSchema = z
  .object({
    code: z.string().regex(/^[A-Za-z0-9_-]{27,256}$/),
    exchangeId: UuidSchema,
    credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    deviceId: UuidSchema,
    deviceName: z.string().trim().min(1).max(100),
    vaultId: UuidSchema,
    pluginVersion: z.string().max(64),
    supportedProtocolVersions: z
      .array(z.string().regex(/^(0|[1-9][0-9]*)$/))
      .min(1)
      .max(8)
      .refine(
        (values) =>
          new Set(values).size === values.length && values.includes("1"),
      ),
  })
  .strict();
export const ActivateCurrentObsidianCredentialRequestSchema = z
  .object({ credentialId: UuidSchema })
  .strict();
export const CreatePushSessionRequestSchema = z
  .object({
    baseRevision: PublicIdSchema,
    idempotencyKey: UuidSchema,
    capabilitiesHash: HashSchema,
    confirmationHash: HashSchema,
    confirmationByteLength: z.number().int().positive().max(4_194_304),
    changeCount: z.number().int().min(0).max(5_000),
    totalBodyBytes: z.number().int().nonnegative(),
  })
  .strict();
export const FinalizePushRequestSchema = z
  .object({ confirmationHash: HashSchema, userConfirmed: z.literal(true) })
  .strict();
export const PushManifestUpsertSchema = z
  .object({
    operation: z.literal("upsert"),
    pageId: PublicIdSchema,
    path: z.string().transform((value, context) => {
      try {
        return validatePortablePath(value).path;
      } catch (error) {
        context.addIssue({
          code: "custom",
          message:
            error instanceof Error ? error.message : "Path is not portable",
        });
        return z.NEVER;
      }
    }),
    title: z.string(),
    contentHash: HashSchema,
  })
  .strict();
export const PushArchiveSchema = z
  .object({
    operation: z.literal("archive"),
    pageId: PublicIdSchema,
    previousPath: z.string().transform((value, context) => {
      try {
        return validatePortablePath(value).path;
      } catch (error) {
        context.addIssue({
          code: "custom",
          message:
            error instanceof Error ? error.message : "Path is not portable",
        });
        return z.NEVER;
      }
    }),
  })
  .strict();
export const PushUpsertSchema = PushManifestUpsertSchema.extend({
  body: z.string(),
}).strict();
export const UploadPushBatchRequestSchema = z
  .object({
    protocolVersion: z.literal("1"),
    batchIndex: z.number().int().nonnegative(),
    changes: z.array(z.union([PushUpsertSchema, PushArchiveSchema])).min(1),
    batchHash: HashSchema,
  })
  .strict();
export const SyncApiErrorResponseSchema = z
  .object({
    protocolVersion: z.literal("1"),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
        details: z
          .record(
            z.string(),
            z.union([z.string(), z.number(), z.boolean(), z.null()]),
          )
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();
export const ExchangeResponseSchema = z
  .object({
    protocolVersion: z.literal("1"),
    serverInstanceId: UuidSchema,
    credentialId: UuidSchema,
    credentialStatus: z.literal("provisional"),
    provisionalExpiresAt: z.string(),
    user: z.object({ id: z.string(), displayName: z.string() }),
    capabilities: SyncCapabilitiesSchema,
  })
  .passthrough();
export const SessionResponseSchema = z
  .object({
    protocolVersion: z.literal("1"),
    serverInstanceId: UuidSchema,
    credentialId: UuidSchema,
    deviceId: UuidSchema,
    deviceName: z.string(),
    vaultId: UuidSchema,
    createdAt: z.string(),
    lastUsedAt: z.string(),
    credentialStatus: z.enum(["provisional", "active"]),
    provisionalExpiresAt: z.string().nullable(),
    user: z.object({ id: z.string(), displayName: z.string() }),
    capabilities: SyncCapabilitiesSchema,
  })
  .passthrough();
export const FinalizeResultSchema = z
  .object({
    protocolVersion: z.literal("1"),
    status: z.enum(["published", "noop"]),
    revision: PublicIdSchema,
    sequence: z.number().int(),
    publishedAt: Rfc3339Schema.nullable(),
    revisionContentHash: HashSchema,
    pageCount: DecimalCountSchema,
    revisionManifestByteLength: DecimalByteCountSchema,
    revisionBodyBytes: DecimalByteCountSchema,
    changeSetId: z.string().nullable(),
  })
  .passthrough();
export const CreatePushSessionResponseSchema = z
  .object({
    protocolVersion: z.literal("1"),
    sessionId: UuidSchema,
    status: z.enum([
      "uploading",
      "ready_to_finalize",
      "published",
      "aborted",
      "expired",
    ]),
    expiresAt: Rfc3339Schema,
    capabilities: SyncCapabilitiesSchema,
    result: FinalizeResultSchema.nullable(),
  })
  .passthrough();
export const PushSessionStatusResponseSchema = z
  .object({
    protocolVersion: z.literal("1"),
    sessionId: UuidSchema,
    status: z.enum([
      "uploading",
      "ready_to_finalize",
      "published",
      "aborted",
      "expired",
    ]),
    expiresAt: Rfc3339Schema,
    receivedBatchIndexes: z.array(z.number().int().nonnegative()),
    result: FinalizeResultSchema.nullable(),
  })
  .passthrough();
export const PushReceiptSchema = z
  .object({ receipt: z.string() })
  .passthrough();

export const RevisionHeadResponseSchema = z
  .object({
    protocolVersion: z.literal("1"),
    spaceId: PublicIdSchema,
    revision: PublicIdSchema,
    sequence: z.number().int().nonnegative(),
    revisionContentHash: HashSchema,
    pageCount: DecimalCountSchema,
    revisionManifestByteLength: DecimalByteCountSchema,
    revisionBodyBytes: DecimalByteCountSchema,
    publishedAt: Rfc3339Schema.nullable(),
  })
  .passthrough();

const PortablePathSchema = z.string().transform((value, context) => {
  try {
    return validatePortablePath(value).path;
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Path is not portable",
    });
    return z.NEVER;
  }
});
const SyncPageSchema = z
  .object({
    pageId: PublicIdSchema,
    path: PortablePathSchema,
    title: z.string(),
    body: z.string(),
    contentHash: HashSchema,
    updatedAt: Rfc3339Schema,
  })
  .passthrough();
export const SnapshotPageSchema = z
  .object({
    protocolVersion: z.literal("1"),
    spaceId: PublicIdSchema,
    revision: PublicIdSchema,
    sequence: z.number().int().nonnegative(),
    revisionContentHash: HashSchema,
    pageCount: DecimalCountSchema,
    revisionManifestByteLength: DecimalByteCountSchema,
    revisionBodyBytes: DecimalByteCountSchema,
    items: z.array(SyncPageSchema),
    nextCursor: CursorSchema.nullable(),
  })
  .passthrough();
export const DeltaPageSchema = z
  .object({
    protocolVersion: z.literal("1"),
    spaceId: PublicIdSchema,
    fromRevision: PublicIdSchema,
    toRevision: PublicIdSchema,
    toSequence: z.number().int().nonnegative(),
    toRevisionContentHash: HashSchema,
    toPageCount: DecimalCountSchema,
    toRevisionManifestByteLength: DecimalByteCountSchema,
    toRevisionBodyBytes: DecimalByteCountSchema,
    items: z.array(
      z.union([
        z.object({ operation: z.literal("upsert"), page: SyncPageSchema }),
        z.object({
          operation: z.literal("archive"),
          pageId: PublicIdSchema,
          previousPath: PortablePathSchema,
        }),
      ]),
    ),
    nextCursor: CursorSchema.nullable(),
  })
  .passthrough();

const SyncSpaceSummarySchema = z
  .object({
    spaceId: PublicIdSchema,
    displayName: z.string(),
    role: z.enum(["viewer", "editor", "admin", "owner"]),
    canRead: z.literal(true),
    canPublish: z.boolean(),
    currentRevision: PublicIdSchema,
    pageCount: DecimalCountSchema,
    revisionManifestByteLength: DecimalByteCountSchema,
    revisionBodyBytes: DecimalByteCountSchema,
  })
  .passthrough();

export const SyncSpaceListResponseSchema = z
  .object({
    protocolVersion: z.literal("1"),
    spaces: z.array(SyncSpaceSummarySchema),
  })
  .passthrough();
