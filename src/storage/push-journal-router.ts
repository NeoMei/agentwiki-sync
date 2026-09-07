import { canonicalBytes, sha256Hex } from "../agentwiki/protocol";
import {
  assertNormalizedPlan,
  isNormalizedPushJournal,
  normalizedPlan,
  normalizedPushPaths,
  type NormalizedPushJournal,
} from "../application/normalized-push-plan";
import {
  isTreePushJournalV3,
  type TreePushJournalV3,
} from "../application/tree-push-service-v3";
import { opaqueFileKey } from "../core/identity-key";
import type { ControlStorePort } from "../ports/control-store";
import {
  MutableControlRepository,
  type MutableControlEnvelope,
  type TypeGuard,
} from "./envelope";
import {
  assertNormalizedEvidence,
  NormalizedPushRepository,
} from "./normalized-push";

export type JournalPort<T> = Pick<
  MutableControlRepository<T>,
  "read" | "write" | "clear"
>;
type Journal = TreePushJournalV3 | NormalizedPushJournal;
const guard = (value: unknown): value is Journal =>
  isTreePushJournalV3(value) || isNormalizedPushJournal(value);
const queues = new Map<string, Promise<void>>();
/** Serializes all adapters addressing the same control root, including distinct views. */
export async function withPushJournalLock<T>(
  root: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(root) ?? Promise.resolve();
  const result = previous.then(work, work);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(root, tail);
  void tail.then(() => {
    if (queues.get(root) === tail) queues.delete(root);
  });
  return result;
}
export async function strictPushEnvelopeRead<T>(
  store: ControlStorePort,
  path: string,
  accepts: TypeGuard<T>,
  validate?: (payload: T) => void | Promise<void>,
): Promise<MutableControlEnvelope<T> | null> {
  const raws = await Promise.all(
    [path, `${path}.prev`, `${path}.next`].map((p) => store.read(p)),
  );
  const candidates = await new MutableControlRepository(
    store,
    path,
    accepts,
  ).candidates();
  if (raws.filter((r) => r !== null).length !== candidates.length)
    throw new Error("Push control evidence is corrupt");
  for (const raw of raws)
    if (raw !== null) {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (
        Object.keys(value).some(
          (k) =>
            ![
              "envelopeSchemaVersion",
              "writeGeneration",
              "payloadHash",
              "payload",
            ].includes(k),
        )
      )
        throw new Error("Unknown envelope field");
    }
  const generations = new Map<number, string>();
  for (const c of candidates) {
    await validate?.(c.payload);
    if (
      generations.has(c.writeGeneration) &&
      generations.get(c.writeGeneration) !== c.payloadHash
    )
      throw new Error("Push control evidence is forked");
    generations.set(c.writeGeneration, c.payloadHash);
  }
  return (
    candidates.sort((a, b) => b.writeGeneration - a.writeGeneration)[0] ?? null
  );
}
function owner(j: Journal): string {
  return j.schemaVersion === 4
    ? `4:${j.binding.operationId}`
    : `3:${j.idempotencyKey}`;
}
function assertSameRootOwner(a: Journal, b: Journal): void {
  const space = (j: Journal) =>
    j.schemaVersion === 4 ? j.binding.spaceId : j.spaceId;
  if (space(a) !== space(b)) throw new Error("Foreign Push root ownership");
  if (a.schemaVersion === 4 && b.schemaVersion === 4) {
    const { operationId: _a, ...left } = a.binding;
    const { operationId: _b, ...right } = b.binding;
    if (
      new TextDecoder().decode(canonicalBytes(left)) !==
      new TextDecoder().decode(canonicalBytes(right))
    )
      throw new Error("Foreign normalized root ownership");
  }
  if (
    a.schemaVersion === 3 &&
    b.schemaVersion === 3 &&
    a.idempotencyKey === b.idempotencyKey
  ) {
    const frozen = (j: TreePushJournalV3) => ({
      spaceId: j.spaceId,
      baseRevision: j.baseRevision,
      idempotencyKey: j.idempotencyKey,
      confirmationHash: j.confirmationHash,
      capabilitiesHash: j.capabilitiesHash,
      capabilities: j.capabilities,
      credentialIdAtCreation: j.credentialIdAtCreation,
      changes: j.changes,
      blobRequirements: j.blobRequirements,
      totalBodyBytes: j.totalBodyBytes,
      attachmentCount: j.attachmentCount,
      transferBlobBytes: j.transferBlobBytes,
    });
    if (
      new TextDecoder().decode(canonicalBytes(frozen(a))) !==
      new TextDecoder().decode(canonicalBytes(frozen(b)))
    )
      throw new Error("Frozen v3 operation changed");
  }
}
export function assertTerminalV3(j: TreePushJournalV3): void {
  if (
    (j.remoteState === "published" &&
      j.result?.status === "published" &&
      j.localCommitPhase === "verified") ||
    (j.remoteState === "superseded" &&
      j.result === null &&
      j.localCommitPhase === "not_started")
  )
    return;
  throw new Error("Existing Push is not terminal");
}
const transitions: Record<
  NormalizedPushJournal["phase"],
  NormalizedPushJournal["phase"][]
> = {
  confirmed: ["confirmed", "remote_pending", "local_pending", "superseded"],
  remote_pending: ["remote_pending", "local_pending", "superseded"],
  local_pending: ["local_pending", "complete", "superseded"],
  complete: ["complete"],
  superseded: ["superseded"],
};
function canReach(
  from: NormalizedPushJournal["phase"],
  to: NormalizedPushJournal["phase"],
): boolean {
  const seen = new Set<NormalizedPushJournal["phase"]>();
  const pending = [from];
  while (pending.length) {
    const phase = pending.pop()!;
    if (phase === to) return true;
    if (seen.has(phase)) continue;
    seen.add(phase);
    pending.push(...transitions[phase]);
  }
  return false;
}
export class PushJournalRouter {
  private readonly path: string;
  private readonly repository: MutableControlRepository<Journal>;
  constructor(
    private readonly store: ControlStorePort,
    private readonly controlRoot: string,
  ) {
    normalizedPushPaths(controlRoot, "validation");
    this.path = `${controlRoot}/push/journal.json`;
    this.repository = new MutableControlRepository(store, this.path, guard);
  }
  private async terminal(j: Journal): Promise<void> {
    if (j.schemaVersion === 3) assertTerminalV3(j);
    else {
      if (j.phase !== "complete" && j.phase !== "superseded")
        throw new Error("Normalized push is pending");
      await assertNormalizedEvidence(this.store, this.controlRoot, j);
    }
  }
  private async retain(
    envelope: MutableControlEnvelope<Journal>,
  ): Promise<void> {
    const j = envelope.payload;
    await this.terminal(j);
    const path =
      j.schemaVersion === 4
        ? `${normalizedPushPaths(this.controlRoot, j.binding.operationId).operationRoot}/terminal.json`
        : `${this.controlRoot}/push/operations/history-${await opaqueFileKey(j.idempotencyKey)}/terminal.json`;
    const raw = JSON.stringify(envelope);
    const existing = await this.store.read(path);
    if (existing !== null && existing !== raw)
      throw new Error("Terminal history mismatch");
    if (existing === null) await this.store.write(path, raw);
    if ((await this.store.read(path)) !== raw)
      throw new Error("Terminal history not durable");
  }
  async read(): Promise<MutableControlEnvelope<Journal> | null> {
    const highest = await strictPushEnvelopeRead(this.store, this.path, guard);
    const candidates = (await this.repository.candidates()).sort(
      (a, b) => a.writeGeneration - b.writeGeneration,
    );
    for (let i = 0; i < candidates.length; i++) {
      const j = candidates[i]!.payload;
      const next = candidates[i + 1]?.payload;
      if (next) assertSameRootOwner(j, next);
      if (j.schemaVersion === 4) {
        await assertNormalizedPlan(normalizedPlan(j));
        if (!next || owner(j) !== owner(next))
          await assertNormalizedEvidence(this.store, this.controlRoot, j);
      }
      if (next && owner(j) !== owner(next)) await this.terminal(j);
      if (
        next?.schemaVersion === 4 &&
        j.schemaVersion === 4 &&
        owner(j) === owner(next) &&
        (await sha256Hex(canonicalBytes(normalizedPlan(j)))) !==
          (await sha256Hex(canonicalBytes(normalizedPlan(next))))
      )
        throw new Error("Frozen operation changed");
      if (
        next?.schemaVersion === 4 &&
        j.schemaVersion === 4 &&
        owner(j) === owner(next) &&
        !canReach(j.phase, next.phase)
      )
        throw new Error("Normalized phase regressed");
    }
    return highest;
  }
  async writeParent(journal: NormalizedPushJournal): Promise<void> {
    return withPushJournalLock(this.controlRoot, async () => {
      if (!isNormalizedPushJournal(journal))
        throw new Error("Invalid normalized journal");
      const existing = await this.read();
      if (existing) assertSameRootOwner(existing.payload, journal);
      if (existing && owner(existing.payload) === owner(journal)) {
        const old = existing.payload as NormalizedPushJournal;
        if (
          !transitions[old.phase].includes(journal.phase) ||
          (await sha256Hex(canonicalBytes(normalizedPlan(old)))) !==
            (await sha256Hex(canonicalBytes(normalizedPlan(journal))))
        )
          throw new Error("Frozen normalized operation changed");
      } else {
        if (journal.phase !== "confirmed")
          throw new Error("New normalized operation must start confirmed");
        if (existing) await this.retain(existing);
      }
      await assertNormalizedEvidence(this.store, this.controlRoot, journal);
      if (journal.phase !== "complete" && journal.phase !== "superseded")
        await new NormalizedPushRepository(
          this.store,
          this.controlRoot,
        ).loadConfirmed(journal);
      if (existing?.payloadHash === (await sha256Hex(canonicalBytes(journal))))
        return;
      await this.repository.write(structuredClone(journal));
    });
  }
  v3Port(): JournalPort<TreePushJournalV3> {
    let observed: string | null | undefined;
    let ownedId: string | null = null;
    const token = (e: MutableControlEnvelope<Journal> | null) =>
      e ? `${e.writeGeneration}:${e.payloadHash}` : null;
    return {
      read: () =>
        withPushJournalLock(this.controlRoot, async () => {
          const current = await this.read();
          observed = token(current);
          if (current?.payload.schemaVersion === 4) {
            await this.retain(current);
            ownedId = null;
            return null;
          }
          ownedId = current?.payload.idempotencyKey ?? null;
          return current as MutableControlEnvelope<TreePushJournalV3> | null;
        }),
      write: (journal) =>
        withPushJournalLock(this.controlRoot, async () => {
          if (!isTreePushJournalV3(journal))
            throw new Error("Invalid v3 journal");
          const current = await this.read();
          if (observed === undefined || observed !== token(current))
            throw new Error("Push journal changed since read");
          if (current) assertSameRootOwner(current.payload, journal);
          if (current && owner(current.payload) !== owner(journal))
            await this.retain(current);
          const written = await this.repository.write(structuredClone(journal));
          observed = token(written);
          ownedId = journal.idempotencyKey;
          return written as MutableControlEnvelope<TreePushJournalV3>;
        }),
      clear: () =>
        withPushJournalLock(this.controlRoot, async () => {
          const current = await this.read();
          if (!current) return;
          if (
            observed !== token(current) ||
            current.payload.schemaVersion !== 3 ||
            current.payload.idempotencyKey !== ownedId ||
            current.payload.result !== null ||
            current.payload.localCommitPhase !== "not_started" ||
            !["not_created", "superseded"].includes(
              current.payload.remoteState,
            ) ||
            (current.payload.remoteState === "not_created" &&
              current.payload.sessionId !== null)
          )
            throw new Error("Cannot clear unowned or pending Push");
          for (const candidate of await this.repository.candidates())
            if (owner(candidate.payload) !== owner(current.payload))
              await this.retain(candidate);
          await this.repository.clear();
          observed = null;
          ownedId = null;
        }),
    };
  }
}
