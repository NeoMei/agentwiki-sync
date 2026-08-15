import { canonicalBytes, sha256Hex } from "../agentwiki/protocol";
import type { ControlStorePort } from "../ports/control-store";

export interface MutableControlEnvelope<T> {
  envelopeSchemaVersion: 1;
  writeGeneration: number;
  payloadHash: string;
  payload: T;
}

export type TypeGuard<T> = (value: unknown) => value is T;

async function parseEnvelope<T>(
  raw: string | null,
  guard: TypeGuard<T>,
): Promise<MutableControlEnvelope<T> | null> {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MutableControlEnvelope<unknown>>;
    if (
      parsed.envelopeSchemaVersion !== 1 ||
      !Number.isSafeInteger(parsed.writeGeneration) ||
      (parsed.writeGeneration ?? 0) < 1 ||
      typeof parsed.payloadHash !== "string" ||
      !guard(parsed.payload)
    )
      return null;
    if (
      (await sha256Hex(canonicalBytes(parsed.payload))) !== parsed.payloadHash
    )
      return null;
    return parsed as MutableControlEnvelope<T>;
  } catch {
    return null;
  }
}

function classifyRaw(
  raw: string | null,
): "absent" | "v1" | "unsupported" | "corrupt" {
  if (raw === null) return "absent";
  try {
    const value = JSON.parse(raw) as { envelopeSchemaVersion?: unknown };
    if (
      typeof value.envelopeSchemaVersion === "number" &&
      value.envelopeSchemaVersion > 1
    )
      return "unsupported";
    return value.envelopeSchemaVersion === 1 ? "v1" : "corrupt";
  } catch {
    return "corrupt";
  }
}

export class MutableControlRepository<T> {
  constructor(
    private readonly store: ControlStorePort,
    private readonly path: string,
    private readonly guard: TypeGuard<T>,
  ) {}

  async candidates(): Promise<MutableControlEnvelope<T>[]> {
    const raws = await Promise.all(
      [this.path, `${this.path}.prev`, `${this.path}.next`].map((path) =>
        this.store.read(path),
      ),
    );
    const classifications = raws.map(classifyRaw);
    if (classifications.includes("unsupported"))
      throw new Error("不支持的控制存储版本");
    const candidates = await Promise.all(
      raws.map((raw) => parseEnvelope(raw, this.guard)),
    );
    if (
      candidates.every((candidate) => candidate === null) &&
      classifications.some((item) => item !== "absent")
    )
      throw new Error("控制存储已损坏");
    return candidates.filter(
      (candidate): candidate is MutableControlEnvelope<T> => candidate !== null,
    );
  }

  async read(): Promise<MutableControlEnvelope<T> | null> {
    const candidates = await this.candidates();
    candidates.sort((a, b) => b.writeGeneration - a.writeGeneration);
    const highest = candidates[0];
    if (!highest) return null;
    const forks = candidates.filter(
      (candidate) =>
        candidate.writeGeneration === highest.writeGeneration &&
        candidate.payloadHash !== highest.payloadHash,
    );
    if (forks.length > 0) throw new Error("控制存储存在分叉");
    return highest;
  }

  async write(payload: T): Promise<MutableControlEnvelope<T>> {
    const candidates = await this.candidates();
    const generation =
      Math.max(0, ...candidates.map((candidate) => candidate.writeGeneration)) +
      1;
    if (!Number.isSafeInteger(generation))
      throw new RangeError("Control generation exhausted");
    const envelope: MutableControlEnvelope<T> = {
      envelopeSchemaVersion: 1,
      writeGeneration: generation,
      payloadHash: await sha256Hex(canonicalBytes(payload)),
      payload,
    };
    await this.store.write(`${this.path}.next`, JSON.stringify(envelope));
    const verified = await parseEnvelope(
      await this.store.read(`${this.path}.next`),
      this.guard,
    );
    if (!verified || verified.payloadHash !== envelope.payloadHash)
      throw new Error("控制写入验证失败");
    await this.store.remove(`${this.path}.prev`);
    if ((await this.store.read(this.path)) !== null)
      await this.store.rename(this.path, `${this.path}.prev`);
    await this.store.rename(`${this.path}.next`, this.path);
    return envelope;
  }

  async clear(): Promise<void> {
    await Promise.all(
      [this.path, `${this.path}.prev`, `${this.path}.next`].map((path) =>
        this.store.remove(path),
      ),
    );
  }
}
