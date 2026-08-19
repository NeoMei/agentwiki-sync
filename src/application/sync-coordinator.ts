import {
  portablePathKey,
  validatePortableDirectory,
} from "../core/portable-path";

export interface SpaceMapping {
  spaceId: string;
  rootPath: string;
  status: "pending" | "active";
}

export class SyncTargetSelection {
  private readonly ids: Set<string>;
  current: string;
  constructor(targetIds: string[], initialId: string) {
    this.ids = new Set(targetIds);
    if (!this.ids.has(initialId)) throw new Error("同步空间不存在");
    this.current = initialId;
  }
  select(spaceId: string): void {
    if (!this.ids.has(spaceId)) throw new Error("同步空间不存在");
    this.current = spaceId;
  }
}

export class OperationLock {
  private readonly active = new Set<string>();
  acquire(spaceId: string): () => void {
    if (this.active.has(spaceId))
      throw new Error(`Space ${spaceId} 已有活跃操作`);
    this.active.add(spaceId);
    return () => this.active.delete(spaceId);
  }
}

export function validateMappings(mappings: SpaceMapping[]): void {
  const spaceIds = new Set<string>();
  for (const mapping of mappings) {
    if (!mapping.spaceId.trim()) throw new Error("无效的映射身份或根");
    if (spaceIds.has(mapping.spaceId))
      throw new Error(`Space ${mapping.spaceId} 已映射`);
    spaceIds.add(mapping.spaceId);
    mapping.rootPath = validatePortableDirectory(mapping.rootPath).path;
  }
  for (let left = 0; left < mappings.length; left += 1)
    for (let right = left + 1; right < mappings.length; right += 1) {
      const a = `${portablePathKey(mappings[left]!.rootPath)}/`;
      const b = `${portablePathKey(mappings[right]!.rootPath)}/`;
      if (a.startsWith(b) || b.startsWith(a)) throw new Error("映射根路径重叠");
    }
}

export function selectMappingForPath(
  mappings: SpaceMapping[],
  path: string,
): SpaceMapping | null {
  const key = portablePathKey(path);
  return (
    mappings.find(
      (mapping) =>
        key === portablePathKey(mapping.rootPath) ||
        key.startsWith(`${portablePathKey(mapping.rootPath)}/`),
    ) ?? null
  );
}

export function resolveMapping(
  mappings: SpaceMapping[],
  activePath: string,
  requestedSpaceId?: string,
): SpaceMapping | null {
  if (requestedSpaceId)
    return (
      mappings.find((mapping) => mapping.spaceId === requestedSpaceId) ?? null
    );
  return selectMappingForPath(mappings, activePath) ?? mappings[0] ?? null;
}

export function unmappedSpaces<T extends { spaceId: string }>(
  spaces: T[],
  mappings: Array<{ spaceId: string }>,
): T[] {
  const mapped = new Set(mappings.map((mapping) => mapping.spaceId));
  return spaces.filter((space) => !mapped.has(space.spaceId));
}

export function removeMapping(
  mappings: SpaceMapping[],
  spaceId: string,
  gate: {
    activeTransaction: boolean;
    localClean: boolean;
    remoteAtBase: boolean;
  },
): SpaceMapping[] {
  const mapping = mappings.find((item) => item.spaceId === spaceId);
  if (!mapping) throw new Error("映射未找到");
  if (gate.activeTransaction) throw new Error("映射有活跃事务");
  if (mapping.status === "active" && (!gate.localClean || !gate.remoteAtBase))
    throw new Error("活跃映射必须在干净且与远端同步后才能移除");
  return mappings.filter((item) => item.spaceId !== spaceId);
}

export async function yieldToUi(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}
