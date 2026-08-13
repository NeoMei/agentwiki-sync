import { diff3Merge } from "node-diff3";
import { sha256Hex } from "../agentwiki/protocol";

export interface StructuredConflict {
  conflictId: string;
  base: string;
  local: string;
  remote: string;
  wholeDocument: boolean;
}

export function mergeField<T>(base: T, local: T, remote: T): { value: T; conflict: boolean } {
  if (Object.is(local, remote)) return { value: local, conflict: false };
  if (Object.is(local, base)) return { value: remote, conflict: false };
  if (Object.is(remote, base)) return { value: local, conflict: false };
  return { value: local, conflict: true };
}

function lineCount(text: string): number {
  let count = 1;
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) count += 1;
  return count;
}

async function conflict(pageId: string, base: string, local: string, remote: string, wholeDocument: boolean): Promise<StructuredConflict> {
  const conflictId = await sha256Hex(new TextEncoder().encode(`${pageId}\0${base}\0${local}\0${remote}`));
  return { conflictId, base, local, remote, wholeDocument };
}

export async function mergeBody(base: string, local: string, remote: string, pageId: string): Promise<{ body: string; conflicts: StructuredConflict[] }> {
  const direct = mergeField(base, local, remote);
  if (!direct.conflict) return { body: direct.value, conflicts: [] };
  if ([base, local, remote].some((text) => lineCount(text) > 10_000)) return { body: local, conflicts: [await conflict(pageId, base, local, remote, true)] };
  const baseLines = base.split("\n");
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");
  const regions = diff3Merge(localLines, baseLines, remoteLines, { excludeFalseConflicts: true });
  const output: string[] = [];
  const conflicts: StructuredConflict[] = [];
  for (const region of regions) {
    if (region.ok) output.push(...region.ok);
    else if (region.conflict) {
      const baseText = region.conflict.o.join("\n");
      const localText = region.conflict.a.join("\n");
      const remoteText = region.conflict.b.join("\n");
      conflicts.push(await conflict(pageId, baseText, localText, remoteText, false));
      output.push(...region.conflict.a);
    }
  }
  return { body: output.join("\n"), conflicts };
}
