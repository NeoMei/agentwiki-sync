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
