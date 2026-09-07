import type { ShortestImageResolution } from "../ports/vault";
import { contentHash, sha256Hex } from "../agentwiki/protocol/hash";
import {
  parseAttachmentReferences,
  parseShortestImageCandidates,
} from "./attachment-reference";
import {
  preserveMarkdownTargetStyle,
  relativeAttachmentPath,
} from "./attachment-target";
import { decodeVaultMarkdown } from "./markdown";

export type ResolveShortestImage = (
  pagePath: string,
  decodedBasename: string,
) => Promise<ShortestImageResolution>;

export interface LocalImageReplacement {
  targetStart: number;
  targetEnd: number;
  originalTarget: string;
  canonicalTarget: string;
  attachmentPath: string;
  basenameKey: string;
}

export interface LocalImageNormalization {
  pageId: string;
  pagePath: string;
  rawHash: string;
  canonicalContentHash: string;
  replacements: LocalImageReplacement[];
}

export async function normalizeLocalImageLinks(input: {
  pageId: string;
  pagePath: string;
  raw: Uint8Array;
  resolve?: ResolveShortestImage;
}): Promise<{ body: string; evidence: LocalImageNormalization | null }> {
  const body = decodeVaultMarkdown(input.raw).normalized;
  if (!input.resolve) return { body, evidence: null };

  const replacements: LocalImageReplacement[] = [];
  for (const candidate of parseShortestImageCandidates(body)) {
    const resolution = await input.resolve(
      input.pagePath,
      candidate.decodedBasename,
    );
    if (resolution.kind !== "resolved") continue;
    const originalTarget = body.slice(
      candidate.targetStart,
      candidate.targetEnd,
    );
    const canonicalTarget = preserveMarkdownTargetStyle(
      originalTarget,
      relativeAttachmentPath(input.pagePath, resolution.attachmentPath),
      body[candidate.targetStart - 1] === "<" &&
        body[candidate.targetEnd] === ">",
    );
    if (canonicalTarget === originalTarget) continue;
    replacements.push({
      targetStart: candidate.targetStart,
      targetEnd: candidate.targetEnd,
      originalTarget,
      canonicalTarget,
      attachmentPath: resolution.attachmentPath,
      basenameKey: resolution.basenameKey,
    });
  }
  if (replacements.length === 0) return { body, evidence: null };

  let rewritten = body;
  for (const replacement of [...replacements].sort(
    (left, right) => right.targetStart - left.targetStart,
  ))
    rewritten =
      rewritten.slice(0, replacement.targetStart) +
      replacement.canonicalTarget +
      rewritten.slice(replacement.targetEnd);

  const reparsed = parseAttachmentReferences(rewritten, input.pagePath);
  let offsetDelta = 0;
  for (const replacement of [...replacements].sort(
    (left, right) => left.targetStart - right.targetStart,
  )) {
    const targetStart = replacement.targetStart + offsetDelta;
    const targetEnd = targetStart + replacement.canonicalTarget.length;
    const reference = reparsed.find(
      (item) =>
        item.targetStart === targetStart && item.targetEnd === targetEnd,
    );
    if (
      reference?.syntax !== "markdown" ||
      reference.classification !== "local" ||
      reference.resolvedPath !== replacement.attachmentPath
    )
      return { body, evidence: null };
    offsetDelta +=
      replacement.canonicalTarget.length - replacement.originalTarget.length;
  }

  return {
    body: rewritten,
    evidence: {
      pageId: input.pageId,
      pagePath: input.pagePath,
      rawHash: await sha256Hex(input.raw),
      canonicalContentHash: await contentHash(rewritten),
      replacements,
    },
  };
}
