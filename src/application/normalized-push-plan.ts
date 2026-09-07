import { z } from "zod";
import {
  FlatAttachmentPathSchema,
  pathKey,
  validatePortableMarkdownPath,
  validatePortableDirectoryPath,
} from "@neomei/agentwiki-sync-protocol";
import { canonicalBytes, sha256Hex } from "../agentwiki/protocol";
import type { LocalImageNormalization } from "../core/local-image-normalization";
import type { LocalTreeScanV3 } from "../core/tree-scan";
import {
  validateTreeIdentityState,
  type TreeIdentityStateV2,
} from "../storage/tree-identities";

export interface NormalizedPushBinding {
  operationId: string;
  serverOrigin: string;
  serverInstanceId: string;
  spaceId: string;
  deviceId: string;
  credentialId: string;
  vaultId: string;
  mappingRootKey: string;
}
export interface NormalizedPageWrite {
  kind: "write_page";
  pageId: string;
  path: string;
  beforeHash: string;
  payloadPath: string;
  contentHash: string;
  byteLength: number;
}
export interface NormalizedPushPlan {
  schemaVersion: 4;
  protocolVersion: "3";
  mode: "remote_push" | "local_only";
  binding: NormalizedPushBinding;
  sourceRevision: string;
  sourceTreeHash: string;
  capabilitiesHash: string;
  wireConfirmationHash: string;
  candidateHash: string;
  localPlanHash: string;
  authorizationHash: string;
  localTransactionId: string;
  localPlan: NormalizedPageWrite[];
  normalizations: LocalImageNormalization[];
  rawPathStates: LocalTreeScanV3["rawPathStates"];
  identities: TreeIdentityStateV2;
  scanEpoch: number;
}
export interface NormalizedPushCompletion {
  transactionId: string;
  targetRevision: string;
  targetTreeHash: string;
  identitiesHash: string;
  localPlanHash: string;
}
export interface NormalizedPushJournal extends NormalizedPushPlan {
  phase:
    | "confirmed"
    | "remote_pending"
    | "local_pending"
    | "complete"
    | "superseded";
  verifiedTarget: { revision: string; revisionContentHash: string } | null;
  completion: NormalizedPushCompletion | null;
}
export type NormalizedPushPlanInput = Omit<
  NormalizedPushPlan,
  "schemaVersion" | "protocolVersion" | "localPlanHash" | "authorizationHash"
>;
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const safePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !/[\u0000-\u001f]/u.test(p) &&
      p.split("/").every((v) => v && v !== "." && v !== ".."),
  );
const pagePath = safePath.refine((p) => {
  try {
    return p.startsWith("pages/") && validatePortableMarkdownPath(p).path === p;
  } catch {
    return false;
  }
});
const statePath = safePath.refine((p) => {
  try {
    return (
      p === "pages" ||
      p === "assets" ||
      FlatAttachmentPathSchema.safeParse(p).success ||
      pagePath.safeParse(p).success ||
      (p.startsWith("pages/") && validatePortableDirectoryPath(p).path === p)
    );
  } catch {
    return false;
  }
});
const finiteSize = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identity = z.custom<TreeIdentityStateV2>((value) => {
  try {
    return validateTreeIdentityState(value).schemaVersion === 2;
  } catch {
    return false;
  }
});
const replacement = z
  .object({
    targetStart: finiteSize,
    targetEnd: finiteSize,
    originalTarget: z.string().min(1),
    canonicalTarget: z.string().min(1),
    attachmentPath: z
      .string()
      .refine((p) => FlatAttachmentPathSchema.safeParse(p).success),
    basenameKey: z.string().min(1),
  })
  .strict()
  .refine(
    (r) =>
      r.targetEnd > r.targetStart &&
      r.targetEnd - r.targetStart === r.originalTarget.length,
  );
const normalization = z
  .object({
    pageId: id,
    pagePath,
    rawHash: hash,
    canonicalContentHash: hash,
    replacements: z.array(replacement).min(1),
  })
  .strict();
const planShape = {
  schemaVersion: z.literal(4),
  protocolVersion: z.literal("3"),
  mode: z.enum(["remote_push", "local_only"]),
  binding: z
    .object({
      operationId: id,
      serverOrigin: z.string().refine((value) => {
        try {
          const u = new URL(value);
          return (
            ["http:", "https:"].includes(u.protocol) &&
            u.origin === value &&
            !u.username &&
            !u.password
          );
        } catch {
          return false;
        }
      }),
      serverInstanceId: id,
      spaceId: id,
      deviceId: id,
      credentialId: id,
      vaultId: id,
      mappingRootKey: safePath,
    })
    .strict(),
  sourceRevision: id,
  sourceTreeHash: hash,
  capabilitiesHash: hash,
  wireConfirmationHash: hash,
  candidateHash: hash,
  localPlanHash: hash,
  authorizationHash: hash,
  localTransactionId: id,
  localPlan: z
    .array(
      z
        .object({
          kind: z.literal("write_page"),
          pageId: id,
          path: pagePath,
          beforeHash: hash,
          payloadPath: safePath.refine((p) => /^\.agentwiki\//u.test(p)),
          contentHash: hash,
          byteLength: finiteSize,
        })
        .strict(),
    )
    .min(1),
  normalizations: z.array(normalization).min(1),
  rawPathStates: z.record(
    statePath,
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("file"), hash }).strict(),
      z
        .object({ kind: z.enum(["directory", "missing"]), hash: z.null() })
        .strict(),
    ]),
  ),
  identities: identity,
  scanEpoch: finiteSize,
};
function consistent(plan: NormalizedPushPlan): boolean {
  const paths = plan.localPlan.map((p) => pathKey(p.path));
  if (
    new Set(paths).size !== paths.length ||
    new Set(plan.localPlan.map((p) => p.pageId)).size !== paths.length ||
    new Set(plan.localPlan.map((p) => p.payloadPath)).size !== paths.length ||
    paths.some((p) =>
      paths.some((other) => p !== other && p.startsWith(`${other}/`)),
    ) ||
    plan.normalizations.length !== paths.length
  )
    return false;
  if (
    new Set(Object.keys(plan.rawPathStates).map(pathKey)).size !==
    Object.keys(plan.rawPathStates).length
  )
    return false;
  return plan.localPlan.every((p, index) => {
    const n = plan.normalizations[index];
    return (
      !!n &&
      n.pagePath === p.path &&
      n.pageId === p.pageId &&
      n.rawHash === p.beforeHash &&
      n.canonicalContentHash === p.contentHash &&
      plan.rawPathStates[p.path]?.kind === "file" &&
      plan.rawPathStates[p.path]?.hash === p.beforeHash &&
      (index === 0 || plan.localPlan[index - 1]!.path < p.path) &&
      n.replacements.every(
        (r, i) => i === 0 || n.replacements[i - 1]!.targetEnd <= r.targetStart,
      )
    );
  });
}
export const NormalizedPushCompletionSchema = z
  .object({
    transactionId: id,
    targetRevision: id,
    targetTreeHash: hash,
    identitiesHash: hash,
    localPlanHash: hash,
  })
  .strict();
const planSchema = z.object(planShape).strict().refine(consistent);
const journalSchema = z
  .object({
    ...planShape,
    phase: z.enum([
      "confirmed",
      "remote_pending",
      "local_pending",
      "complete",
      "superseded",
    ]),
    verifiedTarget: z
      .object({ revision: id, revisionContentHash: hash })
      .strict()
      .nullable(),
    completion: NormalizedPushCompletionSchema.nullable(),
  })
  .strict()
  .refine(consistent)
  .refine((j) => {
    const targeted = j.phase === "local_pending" || j.phase === "complete";
    const cancelledLocal = j.mode === "local_only" && j.phase === "superseded";
    return (
      !(j.mode === "local_only" && j.phase === "remote_pending") &&
      (cancelledLocal || targeted === (j.verifiedTarget !== null)) &&
      (j.phase === "complete") === (j.completion !== null) &&
      (!j.verifiedTarget ||
        j.verifiedTarget.revisionContentHash === j.candidateHash) &&
      (j.mode !== "local_only" ||
        (j.candidateHash === j.sourceTreeHash &&
          (!j.verifiedTarget ||
            j.verifiedTarget.revision === j.sourceRevision)))
    );
  });
export function isNormalizedPushJournal(
  value: unknown,
): value is NormalizedPushJournal {
  return journalSchema.safeParse(value).success;
}
export function normalizedPlan(
  journal: NormalizedPushJournal,
): NormalizedPushPlan {
  const {
    phase: _phase,
    verifiedTarget: _target,
    completion: _completion,
    ...plan
  } = journal;
  return plan;
}
export async function sealNormalizedPushPlan(
  input: NormalizedPushPlanInput,
): Promise<NormalizedPushPlan> {
  const localPlanHash = await sha256Hex(
    canonicalBytes({
      localPlan: input.localPlan,
      normalizations: input.normalizations,
      rawPathStates: input.rawPathStates,
      identities: input.identities,
      scanEpoch: input.scanEpoch,
    }),
  );
  const authorizationHash = await sha256Hex(
    canonicalBytes({ ...input, localPlanHash }),
  );
  return planSchema.parse({
    ...input,
    schemaVersion: 4,
    protocolVersion: "3",
    localPlanHash,
    authorizationHash,
  });
}
export async function assertNormalizedPlan(
  plan: NormalizedPushPlan,
): Promise<void> {
  planSchema.parse(plan);
  const {
    schemaVersion: _schema,
    protocolVersion: _protocol,
    localPlanHash: _local,
    authorizationHash: _authorization,
    ...input
  } = plan;
  const sealed = await sealNormalizedPushPlan(input);
  if (
    sealed.localPlanHash !== plan.localPlanHash ||
    sealed.authorizationHash !== plan.authorizationHash
  )
    throw new Error("Normalized plan authorization mismatch");
}
export function normalizedPushPaths(controlRoot: string, operationId: string) {
  id.parse(operationId);
  if (
    !/^\.agentwiki\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u.test(
      controlRoot,
    ) ||
    controlRoot.split("/").some((p) => p === "." || p === "..")
  )
    throw new Error("Normalized push requires private control root");
  const operationRoot = `${controlRoot}/push/operations/${operationId}`;
  return {
    operationRoot,
    remoteRoot: `${operationRoot}/remote`,
    localRoot: `${operationRoot}/local`,
    payloadRoot: `${operationRoot}/payload`,
    controlAfterPath: `${operationRoot}/control-after.json`,
    completionPath: `${operationRoot}/completion.json`,
  };
}
