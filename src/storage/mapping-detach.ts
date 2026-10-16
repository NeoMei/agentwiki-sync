import type { SpaceMapping } from "../application/sync-coordinator";
import { validatePortableDirectory } from "../core/portable-path";
import { idFileKey } from "../core/identity-key";
import type { ControlStorePort } from "../ports/control-store";
import { MutableControlRepository } from "./envelope";

export async function mappingControlRoot(
  deviceId: string,
  spaceId: string,
): Promise<string> {
  return `.agentwiki/devices/d-${await idFileKey(deviceId)}/spaces/s-${await idFileKey(spaceId)}`;
}
interface DetachIntent {
  schemaVersion: 1;
  deviceId: string;
  spaceId: string;
  rootPath: string;
  archiveId: string;
}
function isDetachIntent(value: unknown): value is DetachIntent {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<DetachIntent>;
  try {
    return (
      item.schemaVersion === 1 &&
      typeof item.deviceId === "string" &&
      typeof item.spaceId === "string" &&
      typeof item.rootPath === "string" &&
      validatePortableDirectory(item.rootPath).path === item.rootPath &&
      typeof item.archiveId === "string" &&
      /^\d+-[a-f0-9-]{36}$/u.test(item.archiveId)
    );
  } catch {
    return false;
  }
}

/** A write-ahead intent; persisted Vault mappings decide rollback versus commit. */
export class MappingDetachRepository {
  private readonly journal: MutableControlRepository<DetachIntent>;
  constructor(
    local: ControlStorePort,
    private readonly control: ControlStorePort,
    private readonly exists: (path: string) => Promise<boolean>,
  ) {
    this.journal = new MutableControlRepository(
      local,
      "mapping-detach.json",
      isDetachIntent,
      [1],
    );
  }
  async assertIdle(spaceId: string): Promise<void> {
    if ((await this.journal.read())?.payload.spaceId === spaceId)
      throw new Error("MAPPING_DETACH_RECOVERY_REQUIRED");
  }
  private async paths(intent: DetachIntent) {
    const source = await mappingControlRoot(intent.deviceId, intent.spaceId);
    const deviceRoot = source.slice(0, source.lastIndexOf("/spaces/"));
    return {
      source,
      target: `${deviceRoot}/detached/${intent.archiveId}-s-${await idFileKey(intent.spaceId)}`,
    };
  }
  async begin(mapping: SpaceMapping, deviceId: string): Promise<void> {
    if (await this.journal.read())
      throw new Error("MAPPING_DETACH_RECOVERY_REQUIRED");
    const intent: DetachIntent = {
      schemaVersion: 1,
      deviceId,
      spaceId: mapping.spaceId,
      rootPath: mapping.rootPath,
      archiveId: `${Date.now()}-${crypto.randomUUID()}`,
    };
    const { source, target } = await this.paths(intent);
    if (!(await this.exists(source))) return;
    if (await this.exists(target))
      throw new Error("MAPPING_DETACH_RECOVERY_REQUIRED");
    await this.journal.write(intent);
    await this.control.rename(source, target);
    if ((await this.exists(source)) || !(await this.exists(target)))
      throw new Error("MAPPING_DETACH_RECOVERY_REQUIRED");
  }
  async recover(
    mappings: SpaceMapping[],
    deviceId: string | undefined,
  ): Promise<void> {
    const intent = (await this.journal.read())?.payload;
    if (!intent) return;
    if (intent.deviceId !== deviceId)
      throw new Error("MAPPING_DETACH_RECOVERY_REQUIRED");
    const mapping = mappings.find((entry) => entry.spaceId === intent.spaceId);
    if (mapping && mapping.rootPath !== intent.rootPath)
      throw new Error("MAPPING_DETACH_RECOVERY_REQUIRED");
    const { source, target } = await this.paths(intent);
    const [sourceExists, targetExists] = await Promise.all([
      this.exists(source),
      this.exists(target),
    ]);
    if (sourceExists === targetExists || (!mapping && sourceExists))
      throw new Error("MAPPING_DETACH_RECOVERY_REQUIRED");
    if (mapping && targetExists) {
      await this.control.rename(target, source);
      if (!(await this.exists(source)) || (await this.exists(target)))
        throw new Error("MAPPING_DETACH_RECOVERY_REQUIRED");
    }
    await this.journal.clear();
  }
}
