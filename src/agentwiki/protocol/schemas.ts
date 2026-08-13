import { z } from "zod";
import { validatePortablePath } from "../../core/portable-path";

export const DecimalCountSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const DecimalByteCountSchema = DecimalCountSchema;
export const SyncCapabilitiesSchema = z.object({
  maxPageBytes: z.number().int(), maxBatchBytes: z.number().int(), maxBatchItems: z.number().int(),
  maxChangeCount: z.number().int(), maxConfirmationBytes: z.number().int(), maxClientSpacePages: z.number().int(),
  maxClientManifestBytes: z.number().int(), maxClientTotalBodyBytes: z.number().int(), maxResponseBytes: z.number().int(),
  maxPageItems: z.number().int(), pushSessionTtlSeconds: z.number().int()
}).passthrough();

export function parseCapabilities(value: unknown) {
  const parsed = SyncCapabilitiesSchema.parse(value);
  if (parsed.maxPageBytes !== 1_048_576 || parsed.maxBatchItems < 1 || parsed.maxBatchItems > 100 || parsed.maxBatchBytes < 1_048_576 || parsed.maxBatchBytes > 4_194_304 || parsed.maxResponseBytes < 1_048_576 || parsed.maxResponseBytes > 4_194_304 || parsed.maxPageItems < 1 || parsed.maxPageItems > 200 || parsed.maxChangeCount !== 5_000 || parsed.maxConfirmationBytes < 1_048_576 || parsed.maxConfirmationBytes > 4_194_304 || parsed.maxClientSpacePages !== 5_000 || parsed.maxClientManifestBytes !== 4_194_304 || parsed.maxClientTotalBodyBytes !== 104_857_600 || parsed.pushSessionTtlSeconds < 900 || parsed.pushSessionTtlSeconds > 86_400) throw new TypeError("Capabilities exceed protocol v1 hard bounds");
  return parsed;
}

const UuidSchema = z.string().uuid();
export const ExchangeResponseSchema = z.object({ protocolVersion: z.literal("1"), serverInstanceId: UuidSchema, credentialId: UuidSchema, credentialStatus: z.literal("provisional"), provisionalExpiresAt: z.string(), user: z.object({ id: z.string(), displayName: z.string() }), capabilities: SyncCapabilitiesSchema }).passthrough();
export const SessionResponseSchema = z.object({ protocolVersion: z.literal("1"), serverInstanceId: UuidSchema, credentialId: UuidSchema, deviceId: UuidSchema, deviceName: z.string(), vaultId: UuidSchema, createdAt: z.string(), lastUsedAt: z.string(), credentialStatus: z.enum(["provisional", "active"]), provisionalExpiresAt: z.string().nullable(), user: z.object({ id: z.string(), displayName: z.string() }), capabilities: SyncCapabilitiesSchema }).passthrough();
export const FinalizeResultSchema = z.object({ status: z.enum(["published", "noop"]), revision: z.string(), sequence: z.number().int(), publishedAt: z.string().nullable(), revisionContentHash: z.string(), pageCount: DecimalCountSchema, revisionManifestByteLength: DecimalByteCountSchema, revisionBodyBytes: DecimalByteCountSchema, changeSetId: z.string().nullable() }).passthrough();
export const CreatePushSessionResponseSchema = z.object({ sessionId: z.string(), status: z.enum(["uploading", "ready_to_finalize", "published", "aborted", "expired"]), expiresAt: z.string(), capabilities: SyncCapabilitiesSchema, result: FinalizeResultSchema.nullable() }).passthrough();
export const PushSessionStatusResponseSchema = z.object({ sessionId: z.string(), status: z.enum(["uploading", "ready_to_finalize", "published", "aborted", "expired"]), expiresAt: z.string(), receivedBatchIndexes: z.array(z.number().int().nonnegative()), result: FinalizeResultSchema.nullable() }).passthrough();
export const PushReceiptSchema = z.object({ receipt: z.string() }).passthrough();

export const RevisionHeadResponseSchema = z.object({
  protocolVersion: z.literal("1"), spaceId: z.string(), revision: z.string(), sequence: z.number().int(),
  revisionContentHash: z.string(), pageCount: DecimalCountSchema, revisionManifestByteLength: DecimalByteCountSchema,
  revisionBodyBytes: DecimalByteCountSchema, publishedAt: z.string().nullable()
}).passthrough();

const PortablePathSchema = z.string().transform((value, context) => {
  try { return validatePortablePath(value).path; }
  catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Path is not portable" }); return z.NEVER; }
});
const SyncPageSchema = z.object({ pageId: z.string(), path: PortablePathSchema, title: z.string(), body: z.string(), contentHash: z.string(), updatedAt: z.string() }).passthrough();
export const SnapshotPageSchema = z.object({
  protocolVersion: z.literal("1"), spaceId: z.string(), revision: z.string(), sequence: z.number().int(), revisionContentHash: z.string(),
  pageCount: DecimalCountSchema, revisionManifestByteLength: DecimalByteCountSchema, revisionBodyBytes: DecimalByteCountSchema,
  items: z.array(SyncPageSchema), nextCursor: z.string().nullable()
}).passthrough();
export const DeltaPageSchema = z.object({
  protocolVersion: z.literal("1"), spaceId: z.string(), fromRevision: z.string(), toRevision: z.string(), toSequence: z.number().int(), toRevisionContentHash: z.string(),
  toPageCount: DecimalCountSchema, toRevisionManifestByteLength: DecimalByteCountSchema, toRevisionBodyBytes: DecimalByteCountSchema,
  items: z.array(z.union([z.object({ operation: z.literal("upsert"), page: SyncPageSchema }), z.object({ operation: z.literal("archive"), pageId: z.string(), previousPath: z.string() })])), nextCursor: z.string().nullable()
}).passthrough();
