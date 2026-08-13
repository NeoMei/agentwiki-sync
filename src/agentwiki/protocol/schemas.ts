import { z } from "zod";

export const DecimalCountSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const DecimalByteCountSchema = DecimalCountSchema;
export const SyncCapabilitiesSchema = z.object({
  maxPageBytes: z.number().int(), maxBatchBytes: z.number().int(), maxBatchItems: z.number().int(),
  maxChangeCount: z.number().int(), maxConfirmationBytes: z.number().int(), maxClientSpacePages: z.number().int(),
  maxClientManifestBytes: z.number().int(), maxClientTotalBodyBytes: z.number().int(), maxResponseBytes: z.number().int(),
  maxPageItems: z.number().int(), pushSessionTtlSeconds: z.number().int()
}).passthrough();

export const RevisionHeadResponseSchema = z.object({
  protocolVersion: z.literal("1"), spaceId: z.string(), revision: z.string(), sequence: z.number().int(),
  revisionContentHash: z.string(), pageCount: DecimalCountSchema, revisionManifestByteLength: DecimalByteCountSchema,
  revisionBodyBytes: DecimalByteCountSchema, publishedAt: z.string().nullable()
}).passthrough();
