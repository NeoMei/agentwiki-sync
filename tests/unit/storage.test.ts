import { describe, expect, it } from "vitest";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { MutableControlRepository } from "../../src/storage/envelope";
import {
  selectCurrentPointer,
  type CurrentPointerPayload,
  type TransactionGate,
} from "../../src/storage/pointer";

describe("crash-safe control storage", () => {
  it("recovers the highest valid envelope and freezes same-generation forks", async () => {
    const store = new MemoryControlStore();
    const repo = new MutableControlRepository(
      store,
      "config.json",
      (value): value is { schemaVersion: 1; name: string } =>
        typeof value === "object" &&
        value !== null &&
        (value as { schemaVersion?: number }).schemaVersion === 1 &&
        typeof (value as { name?: unknown }).name === "string",
    );
    await repo.write({ schemaVersion: 1, name: "one" });
    await repo.write({ schemaVersion: 1, name: "two" });
    expect((await repo.read())?.payload.name).toBe("two");
    await store.write(
      "config.json.next",
      (await store.read("config.json.prev")) ?? "",
    );
    await expect(repo.read()).resolves.toBeDefined();
  });

  it("does not activate a new pointer before the journal allows it", () => {
    const oldPointer: CurrentPointerPayload = {
      schemaVersion: 1,
      active: true,
      generationId: "old",
      manifestHash: "a",
    };
    const newPointer: CurrentPointerPayload = {
      schemaVersion: 1,
      active: true,
      generationId: "new",
      manifestHash: "b",
    };
    const candidates = [
      { writeGeneration: 1, payload: oldPointer },
      { writeGeneration: 2, payload: newPointer },
    ];
    const applying: TransactionGate = {
      state: "applying",
      oldGenerationId: "old",
      newGenerationId: "new",
    };
    expect(selectCurrentPointer(candidates, applying)?.payload).toEqual(
      oldPointer,
    );
    expect(
      selectCurrentPointer(candidates, { ...applying, state: "committed" })
        ?.payload,
    ).toEqual(newPointer);
  });

  it("freezes unknown or wholly corrupt envelope candidates instead of treating them as absent", async () => {
    const store = new MemoryControlStore();
    const repo = new MutableControlRepository(
      store,
      "state.json",
      (value): value is { schemaVersion: 1 } =>
        !!value &&
        typeof value === "object" &&
        (value as { schemaVersion?: number }).schemaVersion === 1,
    );
    await store.write(
      "state.json",
      JSON.stringify({ envelopeSchemaVersion: 2 }),
    );
    await expect(repo.read()).rejects.toThrow(/不支持的/);
    await store.write("state.json", "not-json");
    await expect(repo.read()).rejects.toThrow(/损坏/);
  });
});
