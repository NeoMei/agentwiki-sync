import {
  CreateTreePushSessionResponseV3Schema,
  TreeFinalizePushResponseV3Schema,
} from "@neomei/agentwiki-sync-protocol";

import { AgentWikiClient } from "../src/agentwiki/client";
import { V2TreeRemote } from "../src/agentwiki/v2-tree-remote";
import { V3TreeRemote } from "../src/agentwiki/v3-tree-remote";
import {
  LocalImageUpgradeEntry,
  type LocalImageUpgradeAuthority,
} from "../src/application/local-image-upgrade-entry";
import { ProtocolNegotiator } from "../src/application/protocol-negotiator";
import type { SpaceMapping } from "../src/application/sync-coordinator";
import type { ControlStorePort } from "../src/ports/control-store";
import type { HttpPort, HttpResponse } from "../src/ports/http";
import type { VaultPort } from "../src/ports/vault";
import { ProtocolSelectionRepository } from "../src/storage/protocol-selection";
import { TreeBaselineRepository } from "../src/storage/tree-baseline";

export type LostUpgradeResponse = "create" | "finalize";

export interface DroppedUpgradeResponse {
  kind: LostUpgradeResponse;
  path: string;
  requestBody: unknown;
  responseStatus: number;
  responseBody: unknown;
  sessionId: string;
}

export interface LocalImageUpgradeRecoveryCase {
  serverOrigin: string;
  http: HttpPort;
  control: ControlStorePort;
  vault: VaultPort;
  controlRoot: string;
  mapping: SpaceMapping;
  authority: LocalImageUpgradeAuthority;
}

export interface LocalImageUpgradeRecoveryEvidence {
  kind: LostUpgradeResponse;
  operationId: string;
  sessionId: string;
  sourceRevision: string;
  publishedRevision: string;
  terminalPhase: "complete";
  verifiedPublicationRevision: string;
  baselineRevision: string;
  beforeSequence: number;
  afterSequence: number;
  createCount: number;
  finalizeCount: number;
  idempotencyKeys: string[];
  createSessionIds: string[];
}

export class SuccessfulUpgradeResponseLossHttp implements HttpPort {
  dropped: DroppedUpgradeResponse | null = null;
  readonly successfulMutations: DroppedUpgradeResponse[] = [];
  private armed = true;

  constructor(
    private readonly delegate: HttpPort,
    readonly target: LostUpgradeResponse,
  ) {}

  async request(
    request: Parameters<HttpPort["request"]>[0],
  ): Promise<HttpResponse> {
    const response = await this.delegate.request(request);
    if (request.method !== "POST") return response;
    const { pathname } = new URL(request.url);
    const create = pathname.match(
      /^\/api\/sync\/v3\/spaces\/[^/]+\/push-sessions$/u,
    );
    const finalize = pathname.match(
      /^\/api\/sync\/v3\/spaces\/[^/]+\/push-sessions\/([^/]+)\/finalize$/u,
    );
    const kind: LostUpgradeResponse | null = create
      ? "create"
      : finalize
        ? "finalize"
        : null;
    if (!kind) return response;
    if (response.status < 200 || response.status >= 300) return response;
    const parsed =
      kind === "create"
        ? CreateTreePushSessionResponseV3Schema.parse(response.json)
        : TreeFinalizePushResponseV3Schema.parse(response.json);
    const sessionId =
      kind === "create"
        ? (parsed as { sessionId: string }).sessionId
        : decodeURIComponent(finalize![1]!);
    const observed: DroppedUpgradeResponse = {
      kind,
      path: pathname,
      requestBody: structuredClone(request.body),
      responseStatus: response.status,
      responseBody: structuredClone(response.json),
      sessionId,
    };
    this.successfulMutations.push(observed);
    if (!this.armed || kind !== this.target) return response;
    this.armed = false;
    this.dropped = observed;
    throw new Error(
      kind === "create"
        ? "U7_CREATE_SUCCESS_RESPONSE_LOST"
        : "U7_FINALIZE_SUCCESS_RESPONSE_LOST",
    );
  }
}

export async function verifyLocalImageUpgradeResponseLoss(
  input: LocalImageUpgradeRecoveryCase,
  target: LostUpgradeResponse,
): Promise<LocalImageUpgradeRecoveryEvidence> {
  if (new URL(input.serverOrigin).origin !== input.authority.serverOrigin)
    throw new Error("U7_RECOVERY_SERVER_ORIGIN_MISMATCH");
  const http = new SuccessfulUpgradeResponseLossHttp(input.http, target);
  const build = async () => {
    const client = new AgentWikiClient(input.serverOrigin, http, () => null);
    const protocols = new ProtocolNegotiator(
      client,
      new ProtocolSelectionRepository(input.control),
    );
    const entry = await LocalImageUpgradeEntry.create({
      client,
      protocols,
      vault: input.vault,
      control: input.control,
      controlRoot: input.controlRoot,
      mapping: input.mapping,
      authority: input.authority,
    });
    return { client, protocols, entry };
  };

  const initial = await build();
  const v2 = await initial.protocols.selectV2Fresh();
  const before = await new V2TreeRemote(
    initial.client,
    input.mapping.spaceId,
    v2,
  ).head();
  const draft = await initial.entry.prepare();
  if (draft.kind !== "upgrade_draft")
    throw new Error("U7_RECOVERY_INITIAL_BINDING_REQUIRED");
  const preview = await initial.entry.finalizePreview(draft);
  const expectedLoss =
    target === "create"
      ? "U7_CREATE_SUCCESS_RESPONSE_LOST"
      : "U7_FINALIZE_SUCCESS_RESPONSE_LOST";
  let observedLoss: unknown = null;
  try {
    await initial.entry.confirm(preview, preview.authorizationHash);
  } catch (error) {
    observedLoss = error;
  }
  if (!(observedLoss instanceof Error) || observedLoss.message !== expectedLoss)
    throw new Error(
      `U7_EXPECTED_SUCCESS_RESPONSE_LOSS_NOT_OBSERVED:${
        observedLoss instanceof Error
          ? observedLoss.message
          : String(observedLoss)
      }`,
    );

  const restarted = await build();
  const pending = restarted.entry.pendingIntent;
  if (
    !pending ||
    pending.binding.operationId !== preview.binding.operationId ||
    pending.pushOperationId !== preview.binding.operationId ||
    pending.sourceRevision !== before.revision
  )
    throw new Error("U7_RECOVERY_PENDING_BINDING_MISMATCH");
  await restarted.entry.recover();

  const finalRuntime = await build();
  const terminal = finalRuntime.entry.pendingIntent;
  if (terminal?.phase !== "complete" || terminal.verifiedPublication === null)
    throw new Error("U7_RECOVERY_TERMINAL_EVIDENCE_MISSING");
  const baseline = await new TreeBaselineRepository(
    input.control,
    input.controlRoot,
    input.mapping.spaceId,
    input.mapping.rootPath,
  ).readSnapshot();
  if (
    baseline.protocolVersion !== "3" ||
    baseline.revision !== terminal.verifiedPublication.revision ||
    baseline.revisionContentHash !==
      terminal.verifiedPublication.revisionContentHash
  )
    throw new Error("U7_RECOVERY_BASELINE_EVIDENCE_MISMATCH");
  const v3 = await finalRuntime.protocols.selectV3Fresh();
  const after = await new V3TreeRemote(
    finalRuntime.client,
    input.mapping.spaceId,
    v3,
    { sleep: async () => undefined },
  ).head();
  if (
    after.sequence !== before.sequence + 1 ||
    after.revision !== terminal.verifiedPublication.revision ||
    after.revisionContentHash !==
      terminal.verifiedPublication.revisionContentHash
  )
    throw new Error("U7_RECOVERY_REVISION_COUNT_MISMATCH");
  await finalRuntime.entry.recover();
  if (finalRuntime.entry.pendingIntent !== null)
    throw new Error("U7_RECOVERY_REMAINED_PENDING");

  const creates = http.successfulMutations.filter(
    (mutation) => mutation.kind === "create",
  );
  const finalizes = http.successfulMutations.filter(
    (mutation) => mutation.kind === "finalize",
  );
  const idempotencyKeys = creates.map((mutation) => {
    const body = mutation.requestBody;
    const key =
      typeof body === "object" && body !== null && "idempotencyKey" in body
        ? (body as { idempotencyKey?: unknown }).idempotencyKey
        : null;
    if (typeof key !== "string")
      throw new Error("U7_RECOVERY_IDEMPOTENCY_KEY_MISSING");
    return key;
  });
  const createSessionIds = creates.map((mutation) => mutation.sessionId);
  if (
    creates.length !== (target === "create" ? 2 : 1) ||
    finalizes.length !== 1 ||
    idempotencyKeys.some((key) => key !== preview.binding.operationId) ||
    new Set(createSessionIds).size !== 1 ||
    createSessionIds[0] !== http.dropped?.sessionId ||
    finalizes[0]?.sessionId !== createSessionIds[0]
  )
    throw new Error("U7_RECOVERY_REMOTE_OWNERSHIP_MISMATCH");

  return {
    kind: target,
    operationId: preview.binding.operationId,
    sessionId: createSessionIds[0]!,
    sourceRevision: before.revision,
    publishedRevision: after.revision,
    terminalPhase: terminal.phase,
    verifiedPublicationRevision: terminal.verifiedPublication.revision,
    baselineRevision: baseline.revision,
    beforeSequence: before.sequence,
    afterSequence: after.sequence,
    createCount: creates.length,
    finalizeCount: finalizes.length,
    idempotencyKeys,
    createSessionIds,
  };
}
