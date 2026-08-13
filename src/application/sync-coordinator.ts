import { portablePathKey } from "../core/portable-path";

export interface SpaceMapping { spaceId: string; rootPath: string; status: "pending" | "active" }

export class OperationLock {
  private readonly active = new Set<string>();
  acquire(spaceId: string): () => void {
    if (this.active.has(spaceId)) throw new Error(`Space ${spaceId} already has an active operation`);
    this.active.add(spaceId);
    return () => this.active.delete(spaceId);
  }
}

export function validateMappings(mappings: SpaceMapping[]): void {
  for(const mapping of mappings){if(!mapping.spaceId.trim()||!mapping.rootPath.trim()||mapping.rootPath.startsWith("/")||mapping.rootPath.includes("\\")||mapping.rootPath.split("/").some(part=>!part||part==="."||part===".."))throw new Error("Invalid mapping identity or root");}
  for (let left = 0; left < mappings.length; left += 1) for (let right = left + 1; right < mappings.length; right += 1) {
    const a = `${portablePathKey(mappings[left]!.rootPath)}/`;
    const b = `${portablePathKey(mappings[right]!.rootPath)}/`;
    if (a.startsWith(b) || b.startsWith(a)) throw new Error("Mapping roots overlap");
  }
}

export function selectMappingForPath(mappings: SpaceMapping[], path: string): SpaceMapping | null {
  const key = portablePathKey(path);
  return mappings.find((mapping) => mapping.status === "active" && (key === portablePathKey(mapping.rootPath) || key.startsWith(`${portablePathKey(mapping.rootPath)}/`))) ?? null;
}

export async function yieldToUi(): Promise<void> { await new Promise<void>((resolve) => setTimeout(resolve, 0)); }
