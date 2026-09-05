import { describe, expect, it } from "vitest";
import { canonicalBytes, sha256Hex } from "../../src/agentwiki/protocol";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { MutableControlRepository } from "../../src/storage/envelope";
import {
  selectCurrentPointer,
  pointerSwapDecision,
  type CurrentPointerPayload,
  type TransactionGate,
} from "../../src/storage/pointer";
import {
  detachAttachment,
  emptyTreeIdentityStateV2,
  upgradeTreeIdentityState,
  validateTreeIdentityState,
} from "../../src/storage/tree-identities";

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

  it("refuses pointer CAS when an unrelated higher candidate appeared", () => {
    const oldPointer: CurrentPointerPayload = {
      schemaVersion: 1,
      active: true,
      generationId: "old",
      manifestHash: "a",
    };
    const foreignPointer: CurrentPointerPayload = {
      schemaVersion: 1,
      active: true,
      generationId: "foreign",
      manifestHash: "b",
    };
    expect(() =>
      pointerSwapDecision(
        [
          { writeGeneration: 1, payload: oldPointer },
          { writeGeneration: 2, payload: foreignPointer },
        ],
        { writeGeneration: 1, generationId: "old" },
        "new",
      ),
    ).toThrow(/pointer.*changed/i);
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

  it("does not silently use an older candidate beside a future payload schema", async () => {
    const store = new MemoryControlStore();
    const repo = new MutableControlRepository(
      store,
      "state.json",
      (value): value is { schemaVersion: 1; name: string } =>
        !!value &&
        typeof value === "object" &&
        (value as { schemaVersion?: number }).schemaVersion === 1 &&
        typeof (value as { name?: unknown }).name === "string",
    );
    await repo.write({ schemaVersion: 1, name: "old" });
    const future = {
      envelopeSchemaVersion: 1,
      writeGeneration: 2,
      payloadHash: "untrusted",
      payload: { schemaVersion: 2, name: "future" },
    };
    await store.write("state.json.next", JSON.stringify(future));
    await expect(repo.read()).rejects.toThrow(/未来|schema|版本/i);
    expect(await store.read("state.json.next")).not.toBeNull();
  });

  it("blocks a valid future payload candidate and retains it", async () => {
    const store = new MemoryControlStore();
    const repo = new MutableControlRepository(
      store,
      "state.json",
      (value): value is { schemaVersion: 1; name: string } =>
        !!value &&
        typeof value === "object" &&
        (value as { schemaVersion?: number }).schemaVersion === 1 &&
        typeof (value as { name?: unknown }).name === "string",
    );
    await repo.write({ schemaVersion: 1, name: "old" });
    const payload = { schemaVersion: 2, name: "future" };
    const future = {
      envelopeSchemaVersion: 1,
      writeGeneration: 2,
      payloadHash: await sha256Hex(canonicalBytes(payload)),
      payload,
    };
    await store.write("state.json.next", JSON.stringify(future));
    await expect(repo.read()).rejects.toThrow(/未来|版本/);
    expect(await store.read("state.json.next")).toBe(JSON.stringify(future));
  });
});

describe("tree attachment identities", () => {
  it("upgrades schema 1 without inventing attachment ownership", () => {
    const state = upgradeTreeIdentityState({
      schemaVersion: 1,
      folders: {},
      pendingFolders: {},
      pendingPages: {},
    });
    expect(state).toEqual({
      schemaVersion: 2,
      folders: {},
      pendingFolders: {},
      pendingPages: {},
      attachments: {},
      pendingAttachments: {},
    });
  });

  it("keeps a detached identity inactive without owning the file", () => {
    const identityState = emptyTreeIdentityStateV2();
    identityState.attachments.a1 = {
      attachmentId: "a1",
      path: "assets/a.png",
      pathKey: "assets/a.png",
      baseContentHash: "a".repeat(64),
      active: true,
    };
    identityState.pendingAttachments.a1 = {
      attachmentId: "a1",
      path: "assets/a.png",
      pathKey: "assets/a.png",
      contentHash: "a".repeat(64),
    };
    const state = detachAttachment(identityState, "a1");
    expect(state.attachments.a1?.active).toBe(false);
    expect(state.pendingAttachments.a1).toBeUndefined();
  });

  it("strictly rejects future and shallow invalid schema 2 identity state", () => {
    expect(() => validateTreeIdentityState({ schemaVersion: 3 })).toThrow(
      "Unknown tree identity schema version",
    );
    expect(() =>
      validateTreeIdentityState({
        ...emptyTreeIdentityStateV2(),
        attachments: {
          wrong: {
            attachmentId: "a1",
            path: "../a.png",
            pathKey: "wrong",
            baseContentHash: "bad",
            active: true,
          },
        },
      }),
    ).toThrow(/Invalid tree attachment identity/);
  });
});
