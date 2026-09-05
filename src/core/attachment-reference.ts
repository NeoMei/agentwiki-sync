import { FlatAttachmentPathSchema } from "@neomei/agentwiki-sync-protocol";

export type AttachmentReferenceClassification =
  "local" | "legacy" | "page_embed" | "external" | "invalid";

export interface AttachmentReference {
  syntax: "obsidian" | "markdown";
  classification: AttachmentReferenceClassification;
  target: string;
  targetStart: number;
  targetEnd: number;
  resolvedPath?: string;
  reason?: string;
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === "\\";
    cursor -= 1
  )
    slashCount += 1;
  return slashCount % 2 === 1;
}

function mark(mask: Uint8Array, start: number, end: number): void {
  mask.fill(1, start, end);
}

type FenceContainerToken =
  { kind: "quote" } | { kind: "list"; contentIndent: number };

function quotePrefixEnd(line: string, start: number): number | null {
  const match = line.slice(start).match(/^ {0,3}>[ \t]?/u);
  return match ? start + match[0].length : null;
}

function listMarker(
  line: string,
  start: number,
): { end: number; contentIndent: number } | null {
  const match = line
    .slice(start)
    .match(/^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+)/u);
  if (!match) return null;
  const beforeWhitespace = match[1]!.length + match[2]!.length;
  let paddingLength = 0;
  let contentIndent = beforeWhitespace;
  for (const character of match[3]!) {
    const nextIndent =
      character === "\t"
        ? contentIndent + 4 - (contentIndent % 4)
        : contentIndent + 1;
    if (nextIndent - beforeWhitespace > 4) break;
    contentIndent = nextIndent;
    paddingLength += 1;
  }
  if (paddingLength < match[3]!.length) {
    paddingLength = 1;
    contentIndent =
      match[3]![0] === "\t"
        ? beforeWhitespace + 4 - (beforeWhitespace % 4)
        : beforeWhitespace + 1;
  }
  return {
    end: start + match[1]!.length + match[2]!.length + paddingLength,
    contentIndent,
  };
}

function listContinuationEnd(
  line: string,
  start: number,
  requiredIndent: number,
): number | null {
  let cursor = start;
  let width = 0;
  while (cursor < line.length && width < requiredIndent) {
    if (line[cursor] === " ") width += 1;
    else if (line[cursor] === "\t") width += 4 - (width % 4);
    else break;
    cursor += 1;
  }
  return width >= requiredIndent ? cursor : null;
}

function containerTokenEnd(
  line: string,
  start: number,
  token: FenceContainerToken,
): number | null {
  return token.kind === "quote"
    ? quotePrefixEnd(line, start)
    : listContinuationEnd(line, start, token.contentIndent);
}

function lineContainer(
  line: string,
  inheritedListContainer: readonly FenceContainerToken[],
): { content: string; container: FenceContainerToken[] } {
  let cursor = 0;
  const container: FenceContainerToken[] = [];
  for (const token of inheritedListContainer) {
    const end = containerTokenEnd(line, cursor, token);
    if (end === null) break;
    container.push(token);
    cursor = end;
  }
  for (;;) {
    const quoteEnd = quotePrefixEnd(line, cursor);
    if (quoteEnd !== null) {
      container.push({ kind: "quote" });
      cursor = quoteEnd;
      continue;
    }
    const list = listMarker(line, cursor);
    if (list !== null) {
      container.push({ kind: "list", contentIndent: list.contentIndent });
      cursor = list.end;
      continue;
    }
    break;
  }
  return { content: line.slice(cursor), container };
}

function inheritedListContainer(
  container: readonly FenceContainerToken[],
): FenceContainerToken[] {
  let lastList = -1;
  for (let index = 0; index < container.length; index += 1)
    if (container[index]?.kind === "list") lastList = index;
  return lastList < 0 ? [] : container.slice(0, lastList + 1);
}

function activeFenceContent(
  line: string,
  container: readonly FenceContainerToken[],
): { inside: boolean; content: string } {
  if (line.trim().length === 0) return { inside: true, content: "" };
  let cursor = 0;
  for (const token of container) {
    const end = containerTokenEnd(line, cursor, token);
    if (end === null) return { inside: false, content: line };
    cursor = end;
  }
  return { inside: true, content: line.slice(cursor) };
}

function excludedMask(body: string): Uint8Array {
  const mask = new Uint8Array(body.length);
  for (const match of body.matchAll(/<!--[\s\S]*?(?:-->|$)/gu))
    mark(mask, match.index, match.index + match[0].length);

  let fence: {
    marker: "`" | "~";
    length: number;
    container: FenceContainerToken[];
  } | null = null;
  let listContainer: FenceContainerToken[] = [];
  let offset = 0;
  for (const lineWithBreak of body.match(/[^\n]*(?:\n|$)/gu) ?? []) {
    if (lineWithBreak.length === 0) continue;
    const line = lineWithBreak.endsWith("\n")
      ? lineWithBreak.slice(0, -1)
      : lineWithBreak;
    if (fence) {
      const active = activeFenceContent(line, fence.container);
      if (!active.inside) fence = null;
      else {
        const fenceMatch = active.content.match(/^ {0,3}(`{3,}|~{3,})/u);
        mark(mask, offset, offset + lineWithBreak.length);
        if (
          fenceMatch &&
          fenceMatch[1]![0] === fence.marker &&
          fenceMatch[1]!.length >= fence.length &&
          active.content.slice(fenceMatch[0].length).trim().length === 0
        )
          fence = null;
        offset += lineWithBreak.length;
        continue;
      }
    }
    const opening = lineContainer(line, listContainer);
    if (line.trim().length > 0)
      listContainer = inheritedListContainer(opening.container);
    const fenceMatch = opening.content.match(/^ {0,3}(`{3,}|~{3,})/u);
    if (fenceMatch) {
      fence = {
        marker: fenceMatch[1]![0] as "`" | "~",
        length: fenceMatch[1]!.length,
        container: opening.container,
      };
      mark(mask, offset, offset + lineWithBreak.length);
    } else {
      if (/^(?: {4}|\t)/u.test(opening.content))
        mark(mask, offset, offset + lineWithBreak.length);
    }
    offset += lineWithBreak.length;
  }

  for (let index = 0; index < body.length; index += 1) {
    if (mask[index] || body[index] !== "`" || isEscaped(body, index)) continue;
    let runLength = 1;
    while (body[index + runLength] === "`") runLength += 1;
    const delimiter = "`".repeat(runLength);
    const close = body.indexOf(delimiter, index + runLength);
    if (close < 0) continue;
    mark(mask, index, close + runLength);
    index = close + runLength - 1;
  }
  return mask;
}

function decodeTarget(raw: string): string {
  let unescaped = "";
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === "\\" && index + 1 < raw.length) {
      const next = raw[index + 1]!;
      if (/^[\p{P}\p{S}\s]$/u.test(next)) {
        unescaped += next;
        index += 1;
        continue;
      }
    }
    unescaped += raw[index];
  }
  return decodeURIComponent(unescaped).normalize("NFC");
}

function externalTarget(target: string): boolean {
  return (
    /^(?:https?|ftp):\/\//iu.test(target) ||
    target.startsWith("//") ||
    /^data:/iu.test(target)
  );
}

function resolvePath(
  rawTarget: string,
  pagePath: string,
  syntax: AttachmentReference["syntax"],
): Pick<
  AttachmentReference,
  "classification" | "target" | "resolvedPath" | "reason"
> {
  let target: string;
  try {
    target = decodeTarget(rawTarget);
  } catch {
    return {
      classification: "invalid",
      target: rawTarget,
      reason: "malformed percent encoding",
    };
  }
  if (externalTarget(target)) return { classification: "external", target };
  if (
    target.startsWith("/") ||
    target.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(target) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target)
  )
    return {
      classification: "invalid",
      target,
      reason: "absolute or unsupported URI target",
    };

  if (
    syntax === "obsidian" &&
    !target.includes("/") &&
    /\.(?:png|jpe?g|webp|gif)$/iu.test(target)
  )
    return { classification: "legacy", target };

  if (
    syntax === "obsidian" &&
    !target.startsWith("assets/") &&
    !/\.(?:png|jpe?g|webp|gif)$/iu.test(target)
  )
    return { classification: "page_embed", target };

  let candidate = target;
  if (syntax === "markdown") {
    const stack = pagePath.normalize("NFC").split("/");
    stack.pop();
    for (const segment of target.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        if (stack.length === 0)
          return {
            classification: "invalid",
            target,
            reason: "target escapes the mapping root",
          };
        stack.pop();
      } else stack.push(segment);
    }
    candidate = stack.join("/");
  }

  const parsed = FlatAttachmentPathSchema.safeParse(candidate);
  if (!parsed.success)
    return {
      classification: "invalid",
      target,
      reason: parsed.error.issues[0]?.message ?? "invalid attachment path",
    };
  return { classification: "local", target, resolvedPath: parsed.data };
}

function findUnescaped(text: string, token: string, start: number): number {
  let index = text.indexOf(token, start);
  while (index >= 0 && isEscaped(text, index))
    index = text.indexOf(token, index + 1);
  return index;
}

function findClosingAltBracket(body: string, start: number): number {
  let depth = 0;
  for (let index = start; index < body.length; index += 1) {
    const character = body[index];
    if (character === "\n" || character === "\r") return -1;
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") depth += 1;
    else if (character === "]") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

function completeTitle(value: string): boolean {
  const input = value.trim();
  if (input.length === 0) return true;
  const open = input[0]!;
  const close = open === "(" ? ")" : open;
  if (open !== '"' && open !== "'" && open !== "(") return false;
  if (input.at(-1) !== close || isEscaped(input, input.length - 1))
    return false;
  let depth = open === "(" ? 1 : 0;
  for (let index = 1; index < input.length - 1; index += 1) {
    if (isEscaped(input, index)) continue;
    if (open === "(" && input[index] === "(") depth += 1;
    if (open === "(" && input[index] === ")") {
      depth -= 1;
      if (depth === 0) return false;
    }
    if (open !== "(" && input[index] === close) return false;
  }
  return open !== "(" || depth === 1;
}

function markdownDestination(
  inner: string,
  absoluteStart: number,
): {
  rawTarget: string;
  targetStart: number;
  targetEnd: number;
  valid: boolean;
} {
  const leading = inner.length - inner.trimStart().length;
  let cursor = leading;
  if (inner[cursor] === "<") {
    const close = findUnescaped(inner, ">", cursor + 1);
    if (close < 0)
      return {
        rawTarget: inner.slice(cursor),
        targetStart: absoluteStart + cursor,
        targetEnd: absoluteStart + inner.length,
        valid: false,
      };
    return {
      rawTarget: inner.slice(cursor + 1, close),
      targetStart: absoluteStart + cursor + 1,
      targetEnd: absoluteStart + close,
      valid: completeTitle(inner.slice(close + 1)),
    };
  }

  const start = cursor;
  let depth = 0;
  for (; cursor < inner.length; cursor += 1) {
    const character = inner[cursor]!;
    if (character === "\\" && cursor + 1 < inner.length) {
      cursor += 1;
      continue;
    }
    if (/\s/u.test(character)) break;
    if (character === "(") depth += 1;
    else if (character === ")" && depth > 0) depth -= 1;
  }
  return {
    rawTarget: inner.slice(start, cursor),
    targetStart: absoluteStart + start,
    targetEnd: absoluteStart + cursor,
    valid: cursor > start && depth === 0 && completeTitle(inner.slice(cursor)),
  };
}

function closingParen(body: string, open: number): number {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  let angle = false;
  for (let index = open + 1; index < body.length; index += 1) {
    const character = body[index]!;
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (angle) {
      if (character === ">") angle = false;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "<") {
      angle = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function parseAttachmentReferences(
  body: string,
  pagePath: string,
): AttachmentReference[] {
  const mask = excludedMask(body);
  const references: AttachmentReference[] = [];
  for (let index = 0; index < body.length; index += 1) {
    if (mask[index] || body[index] !== "!" || isEscaped(body, index)) continue;
    if (body.startsWith("![[", index)) {
      const close = findUnescaped(body, "]]", index + 3);
      if (close < 0) continue;
      const contentStart = index + 3;
      const separator = findUnescaped(body.slice(0, close), "|", contentStart);
      const contentEnd = separator >= 0 ? separator : close;
      const raw = body.slice(contentStart, contentEnd);
      const leading = raw.length - raw.trimStart().length;
      const trailing = raw.length - raw.trimEnd().length;
      const targetStart = contentStart + leading;
      const targetEnd = contentEnd - trailing;
      const rawTarget = body.slice(targetStart, targetEnd);
      references.push({
        syntax: "obsidian",
        targetStart,
        targetEnd,
        ...resolvePath(rawTarget, pagePath, "obsidian"),
      });
      index = close + 1;
      continue;
    }
    if (!body.startsWith("![", index)) continue;
    const altClose = findClosingAltBracket(body, index + 2);
    if (altClose < 0 || body[altClose + 1] !== "(") continue;
    const open = altClose + 1;
    const close = closingParen(body, open);
    if (close < 0) continue;
    const destination = markdownDestination(
      body.slice(open + 1, close),
      open + 1,
    );
    const resolved = resolvePath(destination.rawTarget, pagePath, "markdown");
    references.push({
      syntax: "markdown",
      targetStart: destination.targetStart,
      targetEnd: destination.targetEnd,
      ...(destination.valid
        ? resolved
        : {
            classification: "invalid" as const,
            target: destination.rawTarget,
            reason: "invalid Markdown image destination or title",
          }),
    });
    index = close;
  }
  return references;
}
