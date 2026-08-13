import { diff3Merge } from "node-diff3";
import { sha256Hex } from "../agentwiki/protocol";

export interface StructuredConflict {
  conflictId: string;
  pageId: string;
  field: "path" | "title" | "body" | "archive" | "delete";
  base: string;
  local: string;
  remote: string;
  wholeDocument: boolean;
}

export function mergeField<T>(
  base: T,
  local: T,
  remote: T,
): { value: T; conflict: boolean } {
  if (Object.is(local, remote)) return { value: local, conflict: false };
  if (Object.is(local, base)) return { value: remote, conflict: false };
  if (Object.is(remote, base)) return { value: local, conflict: false };
  return { value: local, conflict: true };
}

function lineCount(text: string): number {
  let count = 1;
  for (let index = 0; index < text.length; index += 1)
    if (text.charCodeAt(index) === 10) count += 1;
  return count;
}

async function conflict(
  pageId: string,
  base: string,
  local: string,
  remote: string,
  wholeDocument: boolean,
): Promise<StructuredConflict> {
  const conflictId = await sha256Hex(
    new TextEncoder().encode(`${pageId}\0${base}\0${local}\0${remote}`),
  );
  return {
    conflictId,
    pageId,
    field: "body",
    base,
    local,
    remote,
    wholeDocument,
  };
}

export async function mergeBody(
  base: string,
  local: string,
  remote: string,
  pageId: string,
): Promise<{ body: string; conflicts: StructuredConflict[] }> {
  const direct = mergeField(base, local, remote);
  if (!direct.conflict) return { body: direct.value, conflicts: [] };
  if ([base, local, remote].some((text) => lineCount(text) > 10_000))
    return {
      body: local,
      conflicts: [await conflict(pageId, base, local, remote, true)],
    };
  const baseLines = base.split("\n");
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");
  const regions = diff3Merge(localLines, baseLines, remoteLines, {
    excludeFalseConflicts: true,
  });
  const localOutput: string[] = [];
  const remoteOutput: string[] = [];
  let hasConflict = false;
  for (const region of regions) {
    if (region.ok) {
      localOutput.push(...region.ok);
      remoteOutput.push(...region.ok);
    } else if (region.conflict) {
      hasConflict = true;
      localOutput.push(...region.conflict.a);
      remoteOutput.push(...region.conflict.b);
    }
  }
  const localBody = localOutput.join("\n");
  if (!hasConflict) return { body: localBody, conflicts: [] };
  const remoteBody = remoteOutput.join("\n");
  return {
    body: localBody,
    conflicts: [await conflict(pageId, base, localBody, remoteBody, true)],
  };
}
