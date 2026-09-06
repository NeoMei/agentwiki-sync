import { z } from "zod";

import {
  isTreePushJournalV3,
  type TreePushJournalV3,
} from "../application/tree-push-service-v3";
import {
  isTreeTransactionJournal,
  type TreeTransactionJournal,
  type TreeTransactionPathState,
} from "../application/tree-transaction";
import type { ControlStorePort } from "../ports/control-store";
import { MutableControlRepository } from "./envelope";

const HASH = z.string().regex(/^[a-f0-9]{64}$/u);
const PUBLIC_ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const MAPPING_ROOT_KEY = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !/[\u0000-\u001f]/u.test(value) &&
      value
        .split("/")
        .every((part) => part.length > 0 && part !== "." && part !== ".."),
  );
const PRIVATE_CONTROL_ROOT =
  /^\.agentwiki\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const SAFE_CONTROL_PATH =
  /^\.agentwiki\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;

export const UpgradeBindingSchema = z
  .object({
    operationId: PUBLIC_ID,
    serverInstanceId: PUBLIC_ID,
    spaceId: PUBLIC_ID,
    deviceId: PUBLIC_ID,
    credentialId: PUBLIC_ID,
    mappingRootKey: MAPPING_ROOT_KEY,
  })
  .strict();

const VerifiedPublicationSchema = z
  .object({
    revision: PUBLIC_ID,
    revisionContentHash: HASH,
  })
  .strict();

export const UpgradeIntentSchema = z
  .object({
    schemaVersion: z.literal(1),
    binding: UpgradeBindingSchema,
    sourceRevision: PUBLIC_ID,
    sourceV2RevisionHash: HASH,
    oldBaselineEvidenceHash: HASH,
    projectedV3BaseHash: HASH,
    capabilitiesHash: HASH,
    confirmationHash: HASH,
    candidateHash: HASH,
    localPlanHash: HASH,
    authorizationHash: HASH,
    payloadPaths: z.array(
      z
        .string()
        .regex(SAFE_CONTROL_PATH)
        .refine((path) => !path.includes("..") && !path.includes("\\")),
    ),
    pushOperationId: PUBLIC_ID,
    localTransactionId: PUBLIC_ID,
    phase: z.enum([
      "confirmed",
      "remote_pending",
      "local_pending",
      "complete",
      "superseded",
    ]),
    verifiedPublication: VerifiedPublicationSchema.nullable(),
  })
  .strict();

export interface UpgradeBinding {
  operationId: string;
  serverInstanceId: string;
  spaceId: string;
  deviceId: string;
  credentialId: string;
  mappingRootKey: string;
}

export interface UpgradeIntent {
  schemaVersion: 1;
  binding: UpgradeBinding;
  sourceRevision: string;
  sourceV2RevisionHash: string;
  oldBaselineEvidenceHash: string;
  projectedV3BaseHash: string;
  capabilitiesHash: string;
  confirmationHash: string;
  candidateHash: string;
  localPlanHash: string;
  authorizationHash: string;
  payloadPaths: string[];
  pushOperationId: string;
  localTransactionId: string;
  phase:
    | "confirmed"
    | "remote_pending"
    | "local_pending"
    | "complete"
    | "superseded";
  verifiedPublication: null | {
    revision: string;
    revisionContentHash: string;
  };
}

const mutationQueues = new WeakMap<
  ControlStorePort,
  Map<string, Promise<void>>
>();

async function strictEnvelopeRead<T>(
  store: ControlStorePort,
  path: string,
  guard: (value: unknown) => value is T,
): Promise<T | null> {
  const repository = new MutableControlRepository(store, path, guard);
  const rawCandidates = await Promise.all(
    [path, `${path}.prev`, `${path}.next`].map((candidate) =>
      store.read(candidate),
    ),
  );
  const candidates = await repository.candidates();
  if (
    candidates.length !==
    rawCandidates.filter((candidate) => candidate !== null).length
  )
    throw new Error("Local image upgrade control evidence is corrupt");
  candidates.sort(
    (left, right) => right.writeGeneration - left.writeGeneration,
  );
  const highest = candidates[0];
  if (!highest) return null;
  if (
    candidates.some(
      (candidate) =>
        candidate.writeGeneration === highest.writeGeneration &&
        candidate.payloadHash !== highest.payloadHash,
    )
  )
    throw new Error("Local image upgrade control evidence is forked");
  return highest.payload;
}

function sameBinding(left: UpgradeBinding, right: UpgradeBinding): boolean {
  return (
    left.operationId === right.operationId &&
    left.serverInstanceId === right.serverInstanceId &&
    left.spaceId === right.spaceId &&
    left.deviceId === right.deviceId &&
    left.credentialId === right.credentialId &&
    left.mappingRootKey === right.mappingRootKey
  );
}

function withoutProgress(intent: UpgradeIntent): unknown {
  const {
    phase: _phase,
    verifiedPublication: _publication,
    ...frozen
  } = intent;
  return frozen;
}

function sameFrozenIntent(left: UpgradeIntent, right: UpgradeIntent): boolean {
  return (
    JSON.stringify(withoutProgress(left)) ===
    JSON.stringify(withoutProgress(right))
  );
}

function assertPrivateRoot(root: string): void {
  if (
    !PRIVATE_CONTROL_ROOT.test(root) ||
    root.includes("..") ||
    root.includes("\\")
  )
    throw new TypeError("Local image upgrade requires a private control root");
}

function isUpgradeIntent(value: unknown): value is UpgradeIntent {
  return UpgradeIntentSchema.safeParse(value).success;
}

function hasValidTransactionPathState(
  state: TreeTransactionPathState,
): boolean {
  if (state.kind === "file")
    return state.hash !== null && /^[a-f0-9]{64}$/u.test(state.hash);
  return (
    (state.kind === "directory" || state.kind === "missing") &&
    state.hash === null
  );
}

const allowedTransitions: Record<
  UpgradeIntent["phase"],
  UpgradeIntent["phase"][]
> = {
  confirmed: ["confirmed", "remote_pending", "superseded"],
  remote_pending: ["remote_pending", "local_pending", "superseded"],
  local_pending: ["local_pending", "complete"],
  complete: ["complete"],
  superseded: ["superseded"],
};

export class LocalImageUpgradeRepository {
  private readonly journal: MutableControlRepository<UpgradeIntent>;
  private readonly upgradeRoot: string;
  private readonly operationRoot: string;

  constructor(
    private readonly store: ControlStorePort,
    private readonly root: string,
    private readonly binding: UpgradeBinding,
  ) {
    assertPrivateRoot(root);
    this.binding = UpgradeBindingSchema.parse(binding);
    this.upgradeRoot = `${root}/local-image-upgrade`;
    this.operationRoot = `${this.upgradeRoot}/${this.binding.operationId}`;
    this.journal = new MutableControlRepository(
      store,
      `${this.upgradeRoot}/journal.json`,
      isUpgradeIntent,
    );
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    let queues = mutationQueues.get(this.store);
    if (!queues) {
      queues = new Map();
      mutationQueues.set(this.store, queues);
    }
    const previous = queues.get(this.upgradeRoot) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    queues.set(this.upgradeRoot, tail);
    void tail.then(() => {
      if (queues?.get(this.upgradeRoot) === tail)
        queues.delete(this.upgradeRoot);
    });
    return result;
  }

  private assertOwned(intent: UpgradeIntent): void {
    if (!sameBinding(intent.binding, this.binding))
      throw new Error("Local image upgrade binding mismatch");
    if (intent.pushOperationId !== intent.binding.operationId)
      throw new Error("Local image upgrade child operation mismatch");
    const payloadRoot = `${this.operationRoot}/payload/`;
    if (
      new Set(intent.payloadPaths).size !== intent.payloadPaths.length ||
      intent.payloadPaths.some(
        (path) =>
          !path.startsWith(payloadRoot) ||
          path.length === payloadRoot.length ||
          path.includes("//") ||
          path.includes("..") ||
          path.includes("\\"),
      )
    )
      throw new Error("Local image upgrade payload path is not owned");
    const requiresPublication =
      intent.phase === "local_pending" || intent.phase === "complete";
    if (requiresPublication !== (intent.verifiedPublication !== null))
      throw new Error("Local image upgrade publication evidence mismatch");
  }

  private async readPush(): Promise<TreePushJournalV3 | null> {
    return strictEnvelopeRead(
      this.store,
      `${this.operationRoot}/push/journal.json`,
      isTreePushJournalV3,
    );
  }

  private async readLocal(): Promise<TreeTransactionJournal | null> {
    return strictEnvelopeRead(
      this.store,
      `${this.operationRoot}/local/journal.json`,
      isTreeTransactionJournal,
    );
  }

  private assertPushOwnership(
    intent: UpgradeIntent,
    push: TreePushJournalV3,
  ): void {
    if (
      push.spaceId !== intent.binding.spaceId ||
      push.baseRevision !== intent.sourceRevision ||
      push.idempotencyKey !== intent.pushOperationId ||
      push.confirmationHash !== intent.confirmationHash ||
      push.capabilitiesHash !== intent.capabilitiesHash ||
      push.credentialIdAtCreation !== intent.binding.credentialId
    )
      throw new Error("Local image upgrade Push ownership mismatch");
  }

  private assertPublication(
    intent: UpgradeIntent,
    push: TreePushJournalV3,
  ): void {
    this.assertPushOwnership(intent, push);
    const publication = intent.verifiedPublication;
    if (
      push.remoteState !== "published" ||
      push.result === null ||
      push.result.status !== "published" ||
      publication === null ||
      push.result.revision !== publication.revision ||
      push.result.revisionContentHash !== publication.revisionContentHash ||
      push.result.revisionContentHash !== intent.candidateHash
    )
      throw new Error("Local image upgrade publication is not authoritative");
  }

  private assertLocalOwnership(
    intent: UpgradeIntent,
    local: TreeTransactionJournal,
  ): void {
    if (
      local.schemaVersion !== 3 ||
      local.transactionId !== intent.localTransactionId ||
      local.baseRevision !== intent.sourceRevision ||
      local.targetRevision !== intent.verifiedPublication?.revision ||
      local.targetTreeHash !== intent.candidateHash ||
      local.operations.some((operation) =>
        operation.paths.some(
          (path) =>
            !hasValidTransactionPathState(path.before) ||
            !hasValidTransactionPathState(path.after),
        ),
      )
    )
      throw new Error("Local image upgrade transaction ownership mismatch");
  }

  private async assertPhaseEvidence(intent: UpgradeIntent): Promise<void> {
    if (intent.phase === "confirmed") return;
    const push = await this.readPush();
    if (!push) throw new Error("Local image upgrade Push journal is missing");
    this.assertPushOwnership(intent, push);
    if (intent.phase === "remote_pending") return;
    if (intent.phase === "superseded") {
      if (
        push.remoteState !== "superseded" ||
        push.result !== null ||
        push.localCommitPhase !== "not_started"
      )
        throw new Error(
          "Local image upgrade supersession is not authoritative",
        );
      const local = await this.readLocal();
      if (local)
        throw new Error(
          "Superseded upgrade has an inconsistent local transaction",
        );
      return;
    }
    this.assertPublication(intent, push);
    if (intent.phase === "complete") {
      if (push.localCommitPhase !== "verified")
        throw new Error("Local image upgrade Push is not locally verified");
      const local = await this.readLocal();
      if (!local) throw new Error("Local image upgrade transaction is missing");
      this.assertLocalOwnership(intent, local);
      if (local.state !== "committed")
        throw new Error("Local image upgrade transaction is not committed");
    }
  }

  async read(): Promise<UpgradeIntent | null> {
    const intent = await strictEnvelopeRead(
      this.store,
      `${this.upgradeRoot}/journal.json`,
      isUpgradeIntent,
    );
    if (!intent) return null;
    this.assertOwned(intent);
    await this.assertPhaseEvidence(intent);
    return structuredClone(intent);
  }

  async write(intent: UpgradeIntent): Promise<void> {
    return this.exclusive(async () => {
      const parsed = UpgradeIntentSchema.parse(intent);
      this.assertOwned(parsed);
      const existing = await strictEnvelopeRead(
        this.store,
        `${this.upgradeRoot}/journal.json`,
        isUpgradeIntent,
      );
      if (existing) {
        if (
          existing.binding.operationId !== parsed.binding.operationId &&
          existing.phase !== "complete" &&
          existing.phase !== "superseded"
        )
          throw new Error("A local image upgrade operation is already pending");
        if (existing.binding.operationId !== parsed.binding.operationId) {
          const owner = new LocalImageUpgradeRepository(
            this.store,
            this.root,
            existing.binding,
          );
          owner.assertOwned(existing);
          await owner.assertPhaseEvidence(existing);
        }
        if (existing.binding.operationId === parsed.binding.operationId) {
          if (!sameFrozenIntent(existing, parsed))
            throw new Error("Local image upgrade operation evidence changed");
          if (!allowedTransitions[existing.phase].includes(parsed.phase))
            throw new Error("Invalid local image upgrade phase transition");
        }
      } else if (parsed.phase !== "confirmed")
        throw new Error("A local image upgrade operation must start confirmed");
      await this.assertPhaseEvidence(parsed);
      await this.journal.write(structuredClone(parsed));
    });
  }

  async cleanupCompleted(): Promise<void> {
    return this.exclusive(async () => {
      const intent = await this.read();
      if (
        !intent ||
        (intent.phase !== "complete" && intent.phase !== "superseded")
      )
        return;
      await this.assertPhaseEvidence(intent);
      for (const path of intent.payloadPaths) await this.store.remove(path);
    });
  }
}

export async function inspectLocalImageUpgrade(
  store: ControlStorePort,
  root: string,
  binding: Omit<UpgradeBinding, "operationId">,
): Promise<UpgradeIntent | null> {
  assertPrivateRoot(root);
  const inspectedBinding = UpgradeBindingSchema.omit({
    operationId: true,
  }).parse(binding);
  const intent = await strictEnvelopeRead(
    store,
    `${root}/local-image-upgrade/journal.json`,
    isUpgradeIntent,
  );
  if (!intent) return null;
  const { operationId: _operationId, ...persistedBinding } = intent.binding;
  if (
    persistedBinding.serverInstanceId !== inspectedBinding.serverInstanceId ||
    persistedBinding.spaceId !== inspectedBinding.spaceId ||
    persistedBinding.deviceId !== inspectedBinding.deviceId ||
    persistedBinding.credentialId !== inspectedBinding.credentialId ||
    persistedBinding.mappingRootKey !== inspectedBinding.mappingRootKey
  )
    throw new Error("Local image upgrade binding mismatch");
  return new LocalImageUpgradeRepository(store, root, intent.binding).read();
}
