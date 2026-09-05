import type { MutableControlEnvelope } from "./envelope";

export type CurrentPointerPayload =
  | {
      schemaVersion: 1;
      active: true;
      generationId: string;
      manifestHash: string;
    }
  | { schemaVersion: 1; active: false; rollbackTransactionId: string };

export interface TransactionGate {
  state:
    | "prepared"
    | "applying"
    | "rolling_back"
    | "committing"
    | "committed"
    | "failed";
  oldGenerationId: string | null;
  newGenerationId: string;
  newGenerationVerified?: boolean;
}

export interface PointerSwapExpectation {
  writeGeneration: number | null;
  generationId: string | null;
}

export function pointerSwapDecision(
  candidates: Array<
    Pick<
      MutableControlEnvelope<CurrentPointerPayload>,
      "writeGeneration" | "payload"
    >
  >,
  expected: PointerSwapExpectation,
  newGenerationId: string,
): "write" | "already_switched" {
  const highest = [...candidates].sort(
    (left, right) => right.writeGeneration - left.writeGeneration,
  )[0];
  if (
    highest?.payload.active &&
    highest.payload.generationId === newGenerationId
  )
    return "already_switched";
  const actualId = highest?.payload.active
    ? highest.payload.generationId
    : null;
  if (
    (highest?.writeGeneration ?? null) !== expected.writeGeneration ||
    actualId !== expected.generationId
  )
    throw new Error("Tree baseline pointer changed during compare-and-swap");
  return "write";
}

export function selectCurrentPointer(
  candidates: Array<
    Pick<
      MutableControlEnvelope<CurrentPointerPayload>,
      "writeGeneration" | "payload"
    >
  >,
  gate: TransactionGate | null,
): (typeof candidates)[number] | null {
  const ordered = [...candidates].sort(
    (a, b) => b.writeGeneration - a.writeGeneration,
  );
  if (!gate) return ordered[0] ?? null;
  if (gate.state === "failed") return null;
  const expected =
    gate.state === "committed" ||
    (gate.state === "committing" && gate.newGenerationVerified)
      ? gate.newGenerationId
      : gate.oldGenerationId;
  return (
    ordered.find((candidate) =>
      expected === null
        ? !candidate.payload.active
        : candidate.payload.active &&
          candidate.payload.generationId === expected,
    ) ?? null
  );
}

export function isCurrentPointerPayload(
  value: unknown,
): value is CurrentPointerPayload {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { schemaVersion?: number }).schemaVersion !== 1 ||
    typeof (value as { active?: unknown }).active !== "boolean"
  )
    return false;
  const pointer = value as Record<string, unknown>;
  return pointer.active === true
    ? typeof pointer.generationId === "string" &&
        typeof pointer.manifestHash === "string"
    : typeof pointer.rollbackTransactionId === "string";
}
