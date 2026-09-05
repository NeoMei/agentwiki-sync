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
  emptyTreeIdentityState,
  emptyTreeIdentityStateV2,
  TreeIdentityRepository,
  upgradeTreeIdentityState,
  validateTreeIdentityState,
} from "../../src/storage/tree-identities";
import { distinctControlStoreView } from "../fakes/memory-control-store";

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
  it.each([
    ["absent", false, null],
    ["schema 1", true, 1],
  ] as const)(
    "rejects direct schema 2 initialization from %s without changing durable bytes",
    async (_label, initializeSchema1, expectedSchemaVersion) => {
      const store = new MemoryControlStore();
      const path = ".agentwiki/device/tree-identities.json";
      const repository = new TreeIdentityRepository(store, path);
      if (initializeSchema1) await repository.write(emptyTreeIdentityState());
      const durablePaths = [path, `${path}.prev`, `${path}.next`];
      const before = await Promise.all(
        durablePaths.map((candidatePath) => store.read(candidatePath)),
      );

      await expect(
        repository.write(emptyTreeIdentityStateV2()),
      ).rejects.toThrow(
        "Schema 2 identity state requires confirmed activation",
      );

      await expect(
        Promise.all(
          durablePaths.map((candidatePath) => store.read(candidatePath)),
        ),
      ).resolves.toEqual(before);
      const restarted = new TreeIdentityRepository(
        distinctControlStoreView(store),
        path,
      );
      expect((await restarted.read())?.payload.schemaVersion ?? null).toBe(
        expectedSchemaVersion,
      );
    },
  );

  it("persists schema 2 only through explicit confirmed v3 activation and survives restart", async () => {
    const store = new MemoryControlStore();
    const path = ".agentwiki/device/tree-identities.json";
    const repository = new TreeIdentityRepository(store, path);
    await repository.write({
      schemaVersion: 1,
      folders: {},
      pendingFolders: {},
      pendingPages: {},
      attachments: {
        a1: {
          attachmentId: "a1",
          path: "assets/a.png",
          pathKey: "assets/a.png",
          baseContentHash: "a".repeat(64),
          active: true,
        },
      },
      pendingAttachments: {
        a1: {
          attachmentId: "a1",
          path: "assets/a.png",
          pathKey: "assets/a.png",
          contentHash: "a".repeat(64),
        },
      },
    });

    expect((await repository.read())?.payload.schemaVersion).toBe(1);
    const activated = await repository.commitConfirmedV3Activation();
    expect(activated.schemaVersion).toBe(2);
    expect(activated.attachments.a1?.active).toBe(true);
    expect(activated.pendingAttachments.a1?.attachmentId).toBe("a1");

    const restarted = new TreeIdentityRepository(
      distinctControlStoreView(store),
      path,
    );
    const durable = (await restarted.read())?.payload;
    expect(durable?.schemaVersion).toBe(2);
    expect(durable?.attachments?.a1?.active).toBe(true);
    expect(durable?.pendingAttachments?.a1?.attachmentId).toBe("a1");

    const repeatedActivation = await restarted.commitConfirmedV3Activation();
    expect(repeatedActivation).toEqual(durable);
    await restarted.write({
      ...repeatedActivation,
      pendingPages: {
        p1: {
          pageId: "p1",
          path: "pages/edited.md",
          contentHash: "b".repeat(64),
        },
      },
    });
    expect((await restarted.read())?.payload.pendingPages.p1?.path).toBe(
      "pages/edited.md",
    );

    await expect(
      restarted.write({
        schemaVersion: 1,
        folders: {},
        pendingFolders: {},
        pendingPages: {},
      }),
    ).rejects.toThrow("Cannot downgrade confirmed v3 identity state");
    expect((await restarted.read())?.payload.schemaVersion).toBe(2);
  });

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

  it("validates active and pending attachment owners as one identity graph", () => {
    const samePath = "assets/a.png";
    const otherPath = "assets/b.png";
    const active = {
      attachmentId: "a1",
      path: samePath,
      pathKey: samePath,
      baseContentHash: "a".repeat(64),
      active: true,
    };
    const pending = {
      attachmentId: "a1",
      path: samePath,
      pathKey: samePath,
      contentHash: "a".repeat(64),
    };
    expect(() =>
      validateTreeIdentityState({
        ...emptyTreeIdentityStateV2(),
        attachments: { a1: active },
        pendingAttachments: { a1: pending },
      }),
    ).not.toThrow();
    expect(() =>
      validateTreeIdentityState({
        ...emptyTreeIdentityStateV2(),
        attachments: { a1: active },
        pendingAttachments: {
          a2: { ...pending, attachmentId: "a2" },
        },
      }),
    ).toThrow(/attachment identity ownership/i);
    expect(() =>
      validateTreeIdentityState({
        ...emptyTreeIdentityStateV2(),
        attachments: { a1: active },
        pendingAttachments: {
          a1: { ...pending, path: otherPath, pathKey: otherPath },
        },
      }),
    ).toThrow(/attachment identity ownership/i);
  });

  it("keeps inactive hints strict without reserving their paths", () => {
    const path = "assets/a.png";
    const freshId = "00000000-0000-4000-8000-000000000001";
    const inactive = {
      attachmentId: "old-a",
      path,
      pathKey: path,
      baseContentHash: "a".repeat(64),
      active: false,
    };

    expect(() =>
      validateTreeIdentityState({
        ...emptyTreeIdentityStateV2(),
        attachments: {
          "old-a": inactive,
          "old-b": {
            ...inactive,
            attachmentId: "old-b",
            baseContentHash: "b".repeat(64),
          },
          [freshId]: {
            ...inactive,
            attachmentId: freshId,
            baseContentHash: "c".repeat(64),
            active: true,
          },
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateTreeIdentityState({
        ...emptyTreeIdentityStateV2(),
        attachments: {
          "old-a": inactive,
          "old-b": {
            ...inactive,
            attachmentId: "old-b",
            baseContentHash: "b".repeat(64),
          },
        },
        pendingAttachments: {
          [freshId]: {
            attachmentId: freshId,
            path,
            pathKey: path,
            contentHash: "c".repeat(64),
          },
        },
      }),
    ).not.toThrow();
  });
});
