import {
  FlatAttachmentPathSchema,
  pathKey,
} from "@neomei/agentwiki-sync-protocol";

import { contentHash } from "../agentwiki/protocol";
import { parseAttachmentReferences } from "./attachment-reference";
import type { TreeAttachment, TreePageV3 } from "./tree-model";

export interface AttachmentConflict {
  conflictId: string;
  attachmentId: string;
  kind: "content" | "path" | "path_occupied";
  base: TreeAttachment | null;
  local: TreeAttachment | null;
  remote: TreeAttachment | null;
  affectedPageIds: string[];
}

export type AttachmentConflictResolution =
  | { choice: "local" }
  | { choice: "remote" }
  | {
      choice: "keep_both";
      primary: "local" | "remote";
      secondaryAttachmentId: string;
      secondaryPath: string;
      redirectPageIds: string[];
    };

export type AttachmentMergeClassification = {
  kind:
    | "bind"
    | "take_local_version"
    | "take_remote_version"
    | "rename_remote"
    | "rename_local"
    | "merged"
    | "conflict";
  attachment: TreeAttachment;
  conflictKinds: Array<"content" | "path">;
};

export interface AttachmentMergePlan {
  attachments: TreeAttachment[];
  conflicts: AttachmentConflict[];
  detachedAttachmentIds: string[];
  identityAliases: Record<string, string>;
  pageAttachmentRedirects: Record<string, Record<string, string>>;
  /** Which side supplies the bytes for a materialized attachment. */
  sourceByAttachmentId: Record<string, "base" | "local" | "remote">;
}

export interface AttachmentMergeInput {
  base: TreeAttachment[];
  local: TreeAttachment[];
  remote: TreeAttachment[];
  affectedPageIdsByAttachment: Record<string, string[]>;
  resolutions?: Record<string, AttachmentConflictResolution>;
}

export interface AttachmentRewriteBlocker {
  code: "ATTACHMENT_SOURCE_RANGE_MISMATCH" | "ATTACHMENT_REFERENCE_INVALID";
  pageId: string;
  attachmentId?: string;
  targetStart?: number;
  targetEnd?: number;
  detail: string;
}

interface DimensionMerge<T> {
  value: T;
  source: "local" | "remote";
  conflict: boolean;
}

function mergeDimension<T>(
  base: T,
  local: T,
  remote: T,
  equal: (left: T, right: T) => boolean,
): DimensionMerge<T> {
  if (equal(local, remote))
    return { value: local, source: "local", conflict: false };
  if (equal(local, base))
    return { value: remote, source: "remote", conflict: false };
  if (equal(remote, base))
    return { value: local, source: "local", conflict: false };
  return { value: local, source: "local", conflict: true };
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function combinedAttachment(
  attachmentId: string,
  pathSource: TreeAttachment,
  contentSource: TreeAttachment,
): TreeAttachment {
  return {
    ...contentSource,
    attachmentId,
    path: pathSource.path,
    updatedAt:
      contentSource.updatedAt > pathSource.updatedAt
        ? contentSource.updatedAt
        : pathSource.updatedAt,
  };
}

export function classifyAttachmentMerge(
  base: TreeAttachment,
  local: TreeAttachment,
  remote: TreeAttachment,
): AttachmentMergeClassification {
  const path = mergeDimension(base.path, local.path, remote.path, samePath);
  const content = mergeDimension(
    base.contentHash,
    local.contentHash,
    remote.contentHash,
    Object.is,
  );
  const conflictKinds: Array<"content" | "path"> = [];
  if (path.conflict) conflictKinds.push("path");
  if (content.conflict) conflictKinds.push("content");

  const pathSource = path.source === "local" ? local : remote;
  const contentSource = content.source === "local" ? local : remote;
  const attachment = combinedAttachment(
    base.attachmentId,
    pathSource,
    contentSource,
  );
  if (conflictKinds.length > 0)
    return { kind: "conflict", attachment, conflictKinds };

  const localPathChanged = !samePath(local.path, base.path);
  const remotePathChanged = !samePath(remote.path, base.path);
  const localContentChanged = local.contentHash !== base.contentHash;
  const remoteContentChanged = remote.contentHash !== base.contentHash;
  let kind: AttachmentMergeClassification["kind"] = "bind";
  if (
    localPathChanged &&
    !remotePathChanged &&
    !localContentChanged &&
    !remoteContentChanged
  )
    kind = "rename_remote";
  else if (
    remotePathChanged &&
    !localPathChanged &&
    !localContentChanged &&
    !remoteContentChanged
  )
    kind = "rename_local";
  else if (
    localContentChanged &&
    !remoteContentChanged &&
    !localPathChanged &&
    !remotePathChanged
  )
    kind = "take_local_version";
  else if (
    remoteContentChanged &&
    !localContentChanged &&
    !localPathChanged &&
    !remotePathChanged
  )
    kind = "take_remote_version";
  else if (
    localPathChanged ||
    remotePathChanged ||
    localContentChanged ||
    remoteContentChanged
  )
    kind = "merged";
  return { kind, attachment, conflictKinds };
}

function signature(attachment: TreeAttachment): string {
  return `${pathKey(attachment.path)}\0${attachment.contentHash}`;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function conflict(
  attachmentId: string,
  kind: AttachmentConflict["kind"],
  base: TreeAttachment | undefined,
  local: TreeAttachment | undefined,
  remote: TreeAttachment | undefined,
  affectedPageIds: string[],
): AttachmentConflict {
  return {
    conflictId: `attachment:${attachmentId}:${kind}`,
    attachmentId,
    kind,
    base: base ?? null,
    local: local ?? null,
    remote: remote ?? null,
    affectedPageIds,
  };
}

function validateKeepBoth(
  resolution: Extract<AttachmentConflictResolution, { choice: "keep_both" }>,
  attachmentId: string,
  affectedPageIds: string[],
  knownIds: Set<string>,
): string {
  const parsed = FlatAttachmentPathSchema.safeParse(resolution.secondaryPath);
  if (!parsed.success)
    throw new TypeError(
      `ATTACHMENT_PATH_INVALID: ${parsed.error.issues[0]?.message ?? "invalid path"}`,
    );
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      resolution.secondaryAttachmentId,
    ) ||
    resolution.secondaryAttachmentId === attachmentId ||
    knownIds.has(resolution.secondaryAttachmentId)
  )
    throw new TypeError(
      "ATTACHMENT_ID_INVALID: secondary identity must be a new UUID",
    );
  if (
    resolution.redirectPageIds.length === 0 ||
    resolution.redirectPageIds.length >= affectedPageIds.length ||
    sortedUnique(resolution.redirectPageIds).length !==
      resolution.redirectPageIds.length ||
    resolution.redirectPageIds.some(
      (pageId) => !affectedPageIds.includes(pageId),
    )
  )
    throw new TypeError(
      "ATTACHMENT_REDIRECT_INVALID: keep-both requires explicit affected Page redirects",
    );
  return parsed.data;
}

function sourceFor(
  value: TreeAttachment,
  base: TreeAttachment | undefined,
  local: TreeAttachment | undefined,
  remote: TreeAttachment | undefined,
): "base" | "local" | "remote" {
  if (local?.contentHash === value.contentHash) return "local";
  if (remote?.contentHash === value.contentHash) return "remote";
  return base ? "base" : local ? "local" : "remote";
}

export function mergeAttachmentsById(
  input: AttachmentMergeInput,
): AttachmentMergePlan {
  const identityAliases: Record<string, string> = {};
  const remoteBySignature = new Map<string, TreeAttachment[]>();
  for (const attachment of input.remote) {
    const items = remoteBySignature.get(signature(attachment)) ?? [];
    items.push(attachment);
    remoteBySignature.set(signature(attachment), items);
  }
  const localSignatureCounts = new Map<string, number>();
  for (const attachment of input.local)
    localSignatureCounts.set(
      signature(attachment),
      (localSignatureCounts.get(signature(attachment)) ?? 0) + 1,
    );
  const baseIds = new Set(input.base.map((item) => item.attachmentId));
  const remoteIds = new Set(input.remote.map((item) => item.attachmentId));
  for (const attachment of input.local) {
    if (
      baseIds.has(attachment.attachmentId) ||
      remoteIds.has(attachment.attachmentId)
    )
      continue;
    const matches = remoteBySignature.get(signature(attachment)) ?? [];
    if (
      matches.length === 1 &&
      localSignatureCounts.get(signature(attachment)) === 1
    )
      identityAliases[attachment.attachmentId] = matches[0]!.attachmentId;
  }

  const canonicalLocal = input.local.map((attachment) => ({
    ...attachment,
    attachmentId:
      identityAliases[attachment.attachmentId] ?? attachment.attachmentId,
  }));
  const byBase = new Map(input.base.map((item) => [item.attachmentId, item]));
  const byLocal = new Map(
    canonicalLocal.map((item) => [item.attachmentId, item]),
  );
  const byRemote = new Map(
    input.remote.map((item) => [item.attachmentId, item]),
  );
  const affected = new Map<string, string[]>();
  for (const [rawId, pageIds] of Object.entries(
    input.affectedPageIdsByAttachment,
  )) {
    const id = identityAliases[rawId] ?? rawId;
    affected.set(id, sortedUnique([...(affected.get(id) ?? []), ...pageIds]));
  }

  const knownIds = new Set([
    ...byBase.keys(),
    ...byLocal.keys(),
    ...byRemote.keys(),
  ]);
  const attachments: TreeAttachment[] = [];
  const conflicts: AttachmentConflict[] = [];
  const detachedAttachmentIds: string[] = [];
  const pageAttachmentRedirects: Record<string, Record<string, string>> = {};
  const sourceByAttachmentId: Record<string, "base" | "local" | "remote"> = {};

  for (const id of [...knownIds].sort()) {
    const base = byBase.get(id);
    const local = byLocal.get(id);
    const remote = byRemote.get(id);
    const affectedPageIds = affected.get(id) ?? [];
    if (affectedPageIds.length === 0) {
      if (base) detachedAttachmentIds.push(id);
      continue;
    }

    if (!base || !local || !remote) {
      const value = local ?? remote ?? base;
      if (!value) continue;
      attachments.push({ ...value, attachmentId: id });
      sourceByAttachmentId[id] = local ? "local" : remote ? "remote" : "base";
      continue;
    }

    const classified = classifyAttachmentMerge(base, local, remote);
    const idConflicts = classified.conflictKinds.map((kind) =>
      conflict(id, kind, base, local, remote, affectedPageIds),
    );
    const keepBothEntry = idConflicts
      .map((item) => [item, input.resolutions?.[item.conflictId]] as const)
      .find((entry) => entry[1]?.choice === "keep_both");
    if (keepBothEntry?.[1]?.choice === "keep_both") {
      const resolution = keepBothEntry[1];
      const secondaryPath = validateKeepBoth(
        resolution,
        id,
        affectedPageIds,
        knownIds,
      );
      const primary = resolution.primary === "local" ? local : remote;
      const secondary = resolution.primary === "local" ? remote : local;
      if (samePath(primary.path, secondaryPath)) {
        conflicts.push(
          conflict(id, "path_occupied", base, local, remote, affectedPageIds),
        );
        conflicts.push(...idConflicts);
        attachments.push(classified.attachment);
        sourceByAttachmentId[id] = sourceFor(
          classified.attachment,
          base,
          local,
          remote,
        );
        continue;
      }
      attachments.push({ ...primary, attachmentId: id });
      attachments.push({
        ...secondary,
        attachmentId: resolution.secondaryAttachmentId,
        path: secondaryPath,
      });
      sourceByAttachmentId[id] = resolution.primary;
      sourceByAttachmentId[resolution.secondaryAttachmentId] =
        resolution.primary === "local" ? "remote" : "local";
      for (const pageId of resolution.redirectPageIds)
        (pageAttachmentRedirects[pageId] ??= {})[id] =
          resolution.secondaryAttachmentId;
      continue;
    }

    let value = classified.attachment;
    let pathSource: TreeAttachment = samePath(value.path, remote.path)
      ? remote
      : local;
    let contentSource: TreeAttachment =
      value.contentHash === remote.contentHash ? remote : local;
    const occupiedResolution =
      input.resolutions?.[`attachment:${id}:path_occupied`];
    if (
      occupiedResolution?.choice === "local" ||
      occupiedResolution?.choice === "remote"
    )
      pathSource = occupiedResolution.choice === "local" ? local : remote;
    for (const item of idConflicts) {
      const resolution = input.resolutions?.[item.conflictId];
      if (!resolution) {
        conflicts.push(item);
        continue;
      }
      if (resolution.choice === "keep_both") continue;
      const selected = resolution.choice === "local" ? local : remote;
      if (item.kind === "path") pathSource = selected;
      else contentSource = selected;
    }
    value = combinedAttachment(id, pathSource, contentSource);
    attachments.push(value);
    sourceByAttachmentId[id] = sourceFor(value, base, local, remote);
  }

  const byPath = new Map<string, TreeAttachment[]>();
  for (const item of attachments) {
    const items = byPath.get(pathKey(item.path)) ?? [];
    items.push(item);
    byPath.set(pathKey(item.path), items);
  }
  for (const items of byPath.values()) {
    if (new Set(items.map((item) => item.attachmentId)).size < 2) continue;
    for (const item of items) {
      if (
        conflicts.some(
          (entry) =>
            entry.attachmentId === item.attachmentId &&
            entry.kind === "path_occupied",
        )
      )
        continue;
      conflicts.push(
        conflict(
          item.attachmentId,
          "path_occupied",
          byBase.get(item.attachmentId),
          byLocal.get(item.attachmentId),
          byRemote.get(item.attachmentId),
          affected.get(item.attachmentId) ?? [],
        ),
      );
    }
  }
  const finalById = new Map(
    attachments.map((item) => [item.attachmentId, item]),
  );
  for (const item of attachments) {
    const occupiedByDetachedIdentity = [
      ...input.base,
      ...canonicalLocal,
      ...input.remote,
    ].some((candidate) => {
      if (
        candidate.attachmentId === item.attachmentId ||
        pathKey(candidate.path) !== pathKey(item.path)
      )
        return false;
      const finalCandidate = finalById.get(candidate.attachmentId);
      return (
        !finalCandidate || pathKey(finalCandidate.path) === pathKey(item.path)
      );
    });
    if (
      occupiedByDetachedIdentity &&
      !conflicts.some(
        (entry) =>
          entry.attachmentId === item.attachmentId &&
          entry.kind === "path_occupied",
      )
    )
      conflicts.push(
        conflict(
          item.attachmentId,
          "path_occupied",
          byBase.get(item.attachmentId),
          byLocal.get(item.attachmentId),
          byRemote.get(item.attachmentId),
          affected.get(item.attachmentId) ?? [],
        ),
      );
  }

  attachments.sort((left, right) => {
    const keyDelta = pathKey(left.path).localeCompare(pathKey(right.path));
    return keyDelta || left.attachmentId.localeCompare(right.attachmentId);
  });
  conflicts.sort((left, right) =>
    left.conflictId.localeCompare(right.conflictId),
  );
  return {
    attachments,
    conflicts,
    detachedAttachmentIds: detachedAttachmentIds.sort(),
    identityAliases,
    pageAttachmentRedirects,
    sourceByAttachmentId,
  };
}

function relativeAttachmentPath(
  pagePath: string,
  attachmentPath: string,
): string {
  const from = pagePath.split("/");
  from.pop();
  const to = attachmentPath.split("/");
  let common = 0;
  while (
    common < from.length &&
    common < to.length &&
    from[common] === to[common]
  )
    common += 1;
  return `${"../".repeat(from.length - common)}${to.slice(common).join("/")}`;
}

function preserveMarkdownTargetStyle(
  original: string,
  target: string,
  insideAngles: boolean,
): string {
  if (insideAngles) return target;
  if (/%[0-9a-f]{2}/iu.test(original)) return encodeURI(target);
  if (original.includes("\\")) return target.replace(/[ ()]/gu, "\\$&");
  return /\s/u.test(target) ? encodeURI(target) : target;
}

function referencePath(
  classification: ReturnType<
    typeof parseAttachmentReferences
  >[number]["classification"],
  target: string,
  resolvedPath: string | undefined,
): string | undefined {
  if (classification === "legacy") return `assets/${target}`;
  return classification === "local" ? resolvedPath : undefined;
}

export async function rewriteAttachmentPageReferences(input: {
  page: TreePageV3;
  sourcePath: string;
  sourceAttachments: TreeAttachment[];
  finalPath: string;
  finalAttachments: TreeAttachment[];
  redirects: Record<string, string>;
}): Promise<{ page: TreePageV3; blockers: AttachmentRewriteBlocker[] }> {
  const blockers: AttachmentRewriteBlocker[] = [];
  const sourceByPath = new Map(
    input.sourceAttachments.map((item) => [pathKey(item.path), item]),
  );
  const finalById = new Map(
    input.finalAttachments.map((item) => [item.attachmentId, item]),
  );
  const declared = new Set(input.page.referencedAttachmentIds);
  const seen = new Set<string>();
  const replacements: Array<{
    start: number;
    end: number;
    before: string;
    after: string;
  }> = [];

  for (const reference of parseAttachmentReferences(
    input.page.body,
    input.sourcePath,
  )) {
    const resolved = referencePath(
      reference.classification,
      reference.target,
      reference.resolvedPath,
    );
    if (resolved === undefined) {
      if (reference.classification === "invalid")
        blockers.push({
          code: "ATTACHMENT_REFERENCE_INVALID",
          pageId: input.page.pageId,
          targetStart: reference.targetStart,
          targetEnd: reference.targetEnd,
          detail: reference.reason ?? "invalid attachment reference",
        });
      continue;
    }
    const source = sourceByPath.get(pathKey(resolved));
    const before = input.page.body.slice(
      reference.targetStart,
      reference.targetEnd,
    );
    if (!source || !declared.has(source.attachmentId) || before.length === 0) {
      blockers.push({
        code: "ATTACHMENT_SOURCE_RANGE_MISMATCH",
        pageId: input.page.pageId,
        ...(source ? { attachmentId: source.attachmentId } : {}),
        targetStart: reference.targetStart,
        targetEnd: reference.targetEnd,
        detail:
          "parsed source range does not bind to the Page attachment manifest",
      });
      continue;
    }
    seen.add(source.attachmentId);
    const targetId =
      input.redirects[source.attachmentId] ?? source.attachmentId;
    const target = finalById.get(targetId);
    if (!target) {
      blockers.push({
        code: "ATTACHMENT_SOURCE_RANGE_MISMATCH",
        pageId: input.page.pageId,
        attachmentId: source.attachmentId,
        targetStart: reference.targetStart,
        targetEnd: reference.targetEnd,
        detail:
          "resolved attachment identity is absent from the final candidate",
      });
      continue;
    }
    let after = target.path;
    if (reference.syntax === "markdown")
      after = preserveMarkdownTargetStyle(
        before,
        relativeAttachmentPath(input.finalPath, target.path),
        input.page.body[reference.targetStart - 1] === "<" &&
          input.page.body[reference.targetEnd] === ">",
      );
    else if (
      reference.classification === "legacy" &&
      samePath(source.path, target.path)
    )
      after = before;
    if (after !== before)
      replacements.push({
        start: reference.targetStart,
        end: reference.targetEnd,
        before,
        after,
      });
  }

  for (const attachmentId of declared)
    if (!seen.has(attachmentId))
      blockers.push({
        code: "ATTACHMENT_SOURCE_RANGE_MISMATCH",
        pageId: input.page.pageId,
        attachmentId,
        detail: "Page attachment manifest has no exact parsed source range",
      });

  if (blockers.length > 0) return { page: input.page, blockers };
  let body = input.page.body;
  for (const replacement of replacements.sort(
    (left, right) => right.start - left.start,
  )) {
    if (body.slice(replacement.start, replacement.end) !== replacement.before) {
      blockers.push({
        code: "ATTACHMENT_SOURCE_RANGE_MISMATCH",
        pageId: input.page.pageId,
        targetStart: replacement.start,
        targetEnd: replacement.end,
        detail: "Page body changed after attachment reference parsing",
      });
      return { page: input.page, blockers };
    }
    body = `${body.slice(0, replacement.start)}${replacement.after}${body.slice(replacement.end)}`;
  }

  const referencedAttachmentIds = sortedUnique(
    [...declared].map((id) => input.redirects[id] ?? id),
  );
  return {
    page: {
      ...input.page,
      path: input.finalPath,
      body,
      contentHash: await contentHash(body),
      referencedAttachmentIds,
    },
    blockers,
  };
}
