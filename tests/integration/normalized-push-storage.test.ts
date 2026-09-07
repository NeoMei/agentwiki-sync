import { describe, expect, it } from "vitest";
import {
  isNormalizedPushJournal,
  sealNormalizedPushPlan,
  isNormalizedPushLocalBinding,
  type NormalizedPushLocalBinding,
} from "../../src/application/normalized-push-plan";
import {
  makeNormalizedPlanInput,
  makeNormalizedFixture,
  NORMALIZED_ROOT,
  makeLocalOnlyFixture,
  completeLocalOnly,
  makeV3Journal,
  envelopeFor,
} from "../fakes/normalized-push-fixture";
import { sha256Hex } from "../../src/agentwiki/protocol";
import { NormalizedPushRepository } from "../../src/storage/normalized-push";
import {
  PushJournalRouter,
  readPushProtocolRequirement,
} from "../../src/storage/push-journal-router";
import { normalizedPushPaths } from "../../src/application/normalized-push-plan";
import {
  TreePushServiceV3,
  isTreePushJournalV3,
} from "../../src/application/tree-push-service-v3";
import {
  treeCapabilitiesHashV3,
  treeConfirmationHashV3,
} from "@neomei/agentwiki-sync-protocol";
import {
  TreeTransaction,
  type TreeTransactionJournal,
} from "../../src/application/tree-transaction";
import type { TreePushJournalV3 } from "../../src/application/tree-push-service-v3";
import type { MutableControlEnvelope } from "../../src/storage/envelope";
import { MemoryVault } from "../fakes/memory-vault";

describe("normalized push storage", () => {
  it.each([1, 2] as const)(
    "retains schema %s terminal evidence through every forward-writer interruption",
    async (schemaVersion) => {
      for (const boundary of [
        "history",
        "next",
        "main-prev",
        "next-main",
      ] as const)
        for (const after of [false, true]) {
          const f = await makeNormalizedFixture();
          const next = makeV3Journal(f, { idempotencyKey: "new-v3" });
          const old = {
            ...next,
            schemaVersion,
            idempotencyKey: "old-legacy",
            changes: [],
          };
          const rootPath = `${NORMALIZED_ROOT}/push/journal.json`;
          const original = await envelopeFor(old, 12);
          await f.store.write(rootPath, original);
          const write = f.store.write.bind(f.store);
          const rename = f.store.rename.bind(f.store);
          let tripped = false;
          const interrupt = async (
            matches: boolean,
            operation: () => Promise<void>,
          ) => {
            if (!matches || tripped) return operation();
            tripped = true;
            if (after) await operation();
            throw new Error("handoff interruption");
          };
          f.store.write = (path, value) =>
            interrupt(
              boundary === "history"
                ? path.includes(`/history-${schemaVersion}-`)
                : boundary === "next" && path === `${rootPath}.next`,
              () => write(path, value),
            );
          f.store.rename = (from, to) =>
            interrupt(
              boundary === "main-prev"
                ? from === rootPath
                : boundary === "next-main" && from === `${rootPath}.next`,
              () => rename(from, to),
            );
          const port = new PushJournalRouter(f.store, NORMALIZED_ROOT).v3Port();
          await expect(
            (async () => {
              await port.read();
              await port.write(next);
            })(),
          ).rejects.toThrow("handoff interruption");
          expect(tripped).toBe(true);
          f.store.write = write;
          f.store.rename = rename;
          const rebuilt = new PushJournalRouter(
            f.store,
            NORMALIZED_ROOT,
          ).v3Port();
          const resumed = await rebuilt.read();
          if (!resumed) await rebuilt.write(next);
          const current = await new PushJournalRouter(
            f.store,
            NORMALIZED_ROOT,
          ).read();
          expect(current!.payload.schemaVersion).toBe(3);
          expect(current!.writeGeneration).toBe(13);
          expect(
            [...f.store.files.entries()]
              .filter(([path]) => path.includes(`/history-${schemaVersion}-`))
              .map(([, value]) => value),
          ).toEqual([original]);
        }
    },
  );

  it.each([
    "pending",
    "foreign",
    "corrupt",
    "fork",
    "missing-owner",
    "mixed-legacy",
    "backward",
  ])(
    "refuses %s evidence without discarding a legacy owner",
    async (variant) => {
      const f = await makeNormalizedFixture();
      const next = makeV3Journal(f, { idempotencyKey: "new-v3" });
      const old: Record<string, unknown> = {
        ...next,
        schemaVersion: 1,
        idempotencyKey: "legacy",
        changes: [],
      };
      if (variant === "pending") old.remoteState = "uploading";
      if (variant === "missing-owner") delete old.idempotencyKey;
      const path = `${NORMALIZED_ROOT}/push/journal.json`;
      await f.store.write(path, await envelopeFor(old, 5));
      if (variant === "foreign")
        await f.store.write(
          `${path}.prev`,
          await envelopeFor({ ...old, spaceId: "foreign" }, 4),
        );
      if (variant === "corrupt") await f.store.write(`${path}.prev`, "corrupt");
      if (variant === "fork")
        await f.store.write(
          `${path}.next`,
          await envelopeFor({ ...old, idempotencyKey: "fork" }, 5),
        );
      if (variant === "mixed-legacy")
        await f.store.write(
          `${path}.next`,
          await envelopeFor({ ...old, schemaVersion: 2 }, 6),
        );
      if (variant === "backward")
        await f.store.write(`${path}.prev`, await envelopeFor(next, 4));
      const before = [...f.store.files];
      await expect(
        new PushJournalRouter(f.store, NORMALIZED_ROOT).v3Port().read(),
      ).rejects.toThrow();
      expect([...f.store.files]).toEqual(before);
    },
  );

  it("preserves schema2 capability refresh and original credential ownership across retained candidates", async () => {
    const f = await makeNormalizedFixture();
    const template = makeV3Journal(f);
    const old = {
      ...template,
      schemaVersion: 2,
      changes: [],
      remoteState: "uploading",
      credentialIdAtCreation: "rotated-old",
    };
    const latest = {
      ...old,
      capabilities: { ...old.capabilities, maxPageItems: 17 },
      capabilitiesHash: "updated-caps",
      remoteState: "superseded",
      result: null,
      localCommitPhase: "not_started",
    };
    const path = `${NORMALIZED_ROOT}/push/journal.json`;
    await f.store.write(`${path}.prev`, await envelopeFor(old, 4));
    await f.store.write(path, await envelopeFor(latest, 5));
    expect(
      await readPushProtocolRequirement(f.store, NORMALIZED_ROOT, {
        spaceId: old.spaceId,
      }),
    ).toEqual({ schemaVersion: 2, minimumProtocolVersion: "1" });
    expect(
      (await new PushJournalRouter(f.store, NORMALIZED_ROOT).read())!.payload,
    ).toEqual(latest);
    await expect(
      new PushJournalRouter(f.store, NORMALIZED_ROOT).v3Port().read(),
    ).resolves.toBeNull();
  });
  it("binds actual changed after-state identities without rewriting original authorization", async () => {
    const f = await makeLocalOnlyFixture();
    const original = await sealNormalizedPushPlan(f.input);
    const { repo, journal, paths } = await completeLocalOnly(f);
    expect(journal.identities.attachments).toEqual({});
    expect(journal.authorizationHash).toBe(original.authorizationHash);
    const after = JSON.parse(
      (await f.store.read(paths.controlAfterPath))!,
    ) as MutableControlEnvelope<{
      identities: { attachments: Record<string, { active: boolean }> };
    }>;
    expect(after.payload.identities.attachments["image-1"]?.active).toBe(true);
    await repo.cleanup(journal);
    for (let i = 0; i < 2; i++) await repo.assertTerminal(journal);
  });
  it.each([
    "missing",
    "operationId",
    "transactionId",
    "targetRevision",
    "targetTreeHash",
    "localPlanHash",
    "identitiesHash",
    "future",
    "unknown",
    "lower-identities",
  ])(
    "rejects %s local binding after canonical payload cleanup",
    async (variant) => {
      const f = await makeLocalOnlyFixture();
      const { repo, journal, paths } = await completeLocalOnly(f);
      await repo.cleanup(journal);
      const path = paths.controlAfterBindingPath;
      const binding = (
        JSON.parse(
          (await f.store.read(path))!,
        ) as MutableControlEnvelope<NormalizedPushLocalBinding>
      ).payload;
      const changed: Record<string, unknown> = { ...binding };
      if (variant === "missing") await f.store.remove(path);
      else {
        if (variant === "future") changed.schemaVersion = 2;
        else if (variant === "unknown") changed.phase = "complete";
        else if (variant === "lower-identities")
          changed.identitiesHash = journal.localPlanHash;
        else
          changed[variant] = variant.endsWith("Hash")
            ? journal.authorizationHash
            : "foreign";
        if (variant === "lower-identities") {
          await f.store.write(path, await envelopeFor(binding, 2));
          await f.store.write(`${path}.prev`, await envelopeFor(changed, 1));
        } else await f.store.write(path, await envelopeFor(changed, 2));
      }
      const before = [...f.store.files];
      for (let i = 0; i < 2; i++) {
        await expect(repo.assertTerminal(journal)).rejects.toThrow();
        expect([...f.store.files]).toEqual(before);
      }
    },
  );
  it("strictly guards the companion and retains no-child confirmed cancellation", async () => {
    const f = await makeLocalOnlyFixture();
    const plan = await sealNormalizedPushPlan(f.input);
    const repo = new NormalizedPushRepository(f.store, NORMALIZED_ROOT);
    await repo.stage(plan, f.push, f.candidate, f.rawPageBytes);
    const cancelled = {
      ...plan,
      phase: "superseded" as const,
      verifiedTarget: null,
      completion: null,
    };
    for (let i = 0; i < 2; i++) {
      await repo.write(cancelled);
      await repo.assertTerminal(cancelled);
    }
    expect(
      (await new PushJournalRouter(f.store, NORMALIZED_ROOT).read())!
        .writeGeneration,
    ).toBe(2);
    expect(
      isNormalizedPushLocalBinding({
        schemaVersion: 1,
        operationId: "op-1",
        transactionId: "tx-1",
        targetRevision: "rev-1",
        targetTreeHash: plan.candidateHash,
        localPlanHash: plan.localPlanHash,
        identitiesHash: plan.authorizationHash,
      }),
    ).toBe(true);
    expect(
      isNormalizedPushLocalBinding({ schemaVersion: 1, phase: "complete" }),
    ).toBe(false);
  });
  it("cannot supersede local_pending without a rolled-back child, even by dropping the target", async () => {
    const f = await makeLocalOnlyFixture();
    const plan = await sealNormalizedPushPlan(f.input);
    const repo = new NormalizedPushRepository(f.store, NORMALIZED_ROOT);
    await repo.stage(plan, f.push, f.candidate, f.rawPageBytes);
    const pending = {
      ...plan,
      phase: "local_pending" as const,
      verifiedTarget: {
        revision: plan.sourceRevision,
        revisionContentHash: plan.sourceTreeHash,
      },
      completion: null,
    };
    await repo.write(pending);
    const before = [...f.store.files];
    for (const verifiedTarget of [pending.verifiedTarget, null])
      for (let i = 0; i < 2; i++) {
        await expect(
          repo.write({ ...pending, phase: "superseded", verifiedTarget }),
        ).rejects.toThrow();
        expect([...f.store.files]).toEqual(before);
        expect(
          (await new PushJournalRouter(f.store, NORMALIZED_ROOT).read())!
            .writeGeneration,
        ).toBe(2);
      }
  });
  it.each(["local", "remote", "control-after", "completion"])(
    "rejects foreign ownership even in a lower %s child candidate",
    async (kind) => {
      const f = await makeNormalizedFixture();
      const { repo, journal, paths } = await completeLocalOnly(f);
      const root =
        kind === "control-after"
          ? paths.controlAfterPath
          : kind === "completion"
            ? paths.completionPath
            : `${kind === "local" ? paths.localRoot : paths.remoteRoot}/journal.json`;
      const current = JSON.parse(
        (await f.store.read(root))!,
      ) as MutableControlEnvelope<Record<string, unknown>>;
      const changed = {
        ...current.payload,
        [kind === "remote" ? "idempotencyKey" : "transactionId"]: "foreign",
      };
      await f.store.write(
        root,
        await envelopeFor(
          current.payload,
          Math.max(current.writeGeneration, 2),
        ),
      );
      await f.store.write(`${root}.prev`, await envelopeFor(changed, 1));
      for (let i = 0; i < 2; i++)
        await expect(repo.assertTerminal(journal)).rejects.toThrow();
    },
  );
  it("rejects same-id v3 writers changing the frozen source", async () => {
    const f = await makeNormalizedFixture();
    const router = new PushJournalRouter(f.store, NORMALIZED_ROOT);
    const port = router.v3Port();
    await port.read();
    const journal = makeV3Journal(f, { remoteState: "not_created" });
    await port.write(journal);
    const before = [...f.store.files];
    await expect(
      port.write({ ...journal, baseRevision: "foreign-revision" }),
    ).rejects.toThrow();
    expect([...f.store.files]).toEqual(before);
  });
  it("accepts an actually published, locally verified terminal3 before a fresh parent", async () => {
    const f = await makeNormalizedFixture();
    const result = await f.remote.bootstrapConfirmed({
      baseRevision: "rev-1",
      confirmationHash: f.push.confirmationHash,
      userConfirmed: true,
    });
    const router = new PushJournalRouter(f.store, NORMALIZED_ROOT);
    const port = router.v3Port();
    await port.read();
    await port.write(
      makeV3Journal(f, {
        remoteState: "published",
        localCommitPhase: "verified",
        result,
        sessionId: "session-1",
      }),
    );
    await new NormalizedPushRepository(f.store, NORMALIZED_ROOT).stage(
      await sealNormalizedPushPlan(f.input),
      f.push,
      f.candidate,
      f.rawPageBytes,
    );
    for (let i = 0; i < 2; i++)
      expect((await router.read())!.writeGeneration).toBe(2);
  });
  it.each(["completion", "identities", "transaction", "local-only-child"])(
    "fails terminal proof closed for %s corruption",
    async (variant) => {
      const f = await makeLocalOnlyFixture();
      const { repo, journal, paths } = await completeLocalOnly(f);
      await repo.cleanup(journal);
      if (variant === "completion")
        await f.store.write(
          paths.completionPath,
          await envelopeFor(
            { ...journal.completion, localPlanHash: journal.candidateHash },
            2,
          ),
        );
      if (variant === "identities")
        await f.store.remove(paths.controlAfterPath);
      if (variant === "transaction") await f.store.removeTree(paths.localRoot);
      if (variant === "local-only-child")
        await f.store.write(
          `${paths.remoteRoot}/journal.json`,
          await envelopeFor(makeV3Journal(f)),
        );
      const before = [...f.store.files];
      for (let i = 0; i < 2; i++) {
        await expect(repo.assertTerminal(journal)).rejects.toThrow();
        await expect(
          new PushJournalRouter(f.store, NORMALIZED_ROOT).v3Port().read(),
        ).rejects.toThrow();
      }
      expect([...f.store.files]).toEqual(before);
    },
  );
  it.each([1, 6])(
    "rejects unknown schema at generation %i around a valid generation 3",
    async (generation) => {
      const f = await makeNormalizedFixture();
      const repo = new NormalizedPushRepository(f.store, NORMALIZED_ROOT);
      const plan = await sealNormalizedPushPlan(f.input);
      await repo.stage(plan, f.push, f.candidate, f.rawPageBytes);
      const j = (await repo.read())!;
      await f.store.write(
        `${NORMALIZED_ROOT}/push/journal.json`,
        await envelopeFor(j, 3),
      );
      await f.store.write(
        `${NORMALIZED_ROOT}/push/journal.json.prev`,
        await envelopeFor({ ...j, schemaVersion: 6 }, generation),
      );
      for (let i = 0; i < 2; i++) await expect(repo.read()).rejects.toThrow();
    },
  );
  it("permits local-only supersession only after the owned deferred transaction actually rolled back", async () => {
    const f = await makeLocalOnlyFixture();
    const plan = await sealNormalizedPushPlan(f.input);
    const repo = new NormalizedPushRepository(f.store, NORMALIZED_ROOT);
    await repo.stage(plan, f.push, f.candidate, f.rawPageBytes);
    const pending = {
      ...plan,
      phase: "local_pending" as const,
      verifiedTarget: {
        revision: plan.sourceRevision,
        revisionContentHash: plan.sourceTreeHash,
      },
      completion: null,
    };
    await repo.write(pending);
    const paths = normalizedPushPaths(NORMALIZED_ROOT, "op-1");
    const vault = new MemoryVault({ "Wiki/pages/note.md": "![A](photo.png)" });
    const tx = new TreeTransaction(vault, f.store, paths.localRoot);
    await tx.prepare(
      {
        baseRevision: plan.sourceRevision,
        targetRevision: plan.sourceRevision,
        targetTreeHash: plan.sourceTreeHash,
        deferCommit: true,
        actions: [
          {
            kind: "write_page",
            pageId: "page-1",
            path: "Wiki/pages/note.md",
            bodyPath: plan.localPlan[0]!.payloadPath,
          },
        ],
        expectedPathStates: {
          "Wiki/pages/note.md": plan.rawPathStates["pages/note.md"]!,
        },
      },
      plan.localTransactionId,
    );
    const cancelled = { ...pending, phase: "superseded" as const };
    await expect(repo.write(cancelled)).rejects.toThrow();
    await tx.apply();
    await tx.markVerified();
    await expect(repo.write(cancelled)).rejects.toThrow();
    await tx.rollbackVerified();
    for (let i = 0; i < 2; i++) {
      await repo.write(cancelled);
      await repo.assertTerminal(cancelled);
    }
    expect(
      (await new PushJournalRouter(f.store, NORMALIZED_ROOT).read())!
        .writeGeneration,
    ).toBe(3);
    expect(
      new TextDecoder().decode((await vault.read("Wiki/pages/note.md"))!),
    ).toBe("![A](photo.png)");
    expect(await f.store.read(paths.completionPath)).toBeNull();
    expect(await f.store.read(paths.controlAfterPath)).toBeNull();
    const raw = JSON.parse(
      (await f.store.read(`${paths.localRoot}/journal.json`))!,
    ) as MutableControlEnvelope<TreeTransactionJournal>;
    raw.payload.transactionId = "foreign";
    await f.store.write(
      `${paths.localRoot}/journal.json`,
      await envelopeFor(raw.payload, raw.writeGeneration + 1),
    );
    await expect(repo.assertTerminal(cancelled)).rejects.toThrow();
    // A retained terminal must stand on rollback evidence after older parent candidates rotate out.
    raw.payload.transactionId = plan.localTransactionId;
    await f.store.write(
      `${paths.localRoot}/journal.json`,
      await envelopeFor(raw.payload, raw.writeGeneration + 2),
    );
    const router = new PushJournalRouter(f.store, NORMALIZED_ROOT);
    const port = router.v3Port();
    await port.read();
    await port.write(makeV3Journal(f, { idempotencyKey: "after-cancel-1" }));
    await port.write(makeV3Journal(f, { idempotencyKey: "after-cancel-2" }));
    expect((await router.read())!.writeGeneration).toBe(5);
    await repo.assertTerminal(cancelled);
    await f.store.removeTree(paths.localRoot);
    const withoutRollback = [...f.store.files];
    for (let i = 0; i < 2; i++) {
      await expect(repo.assertTerminal(cancelled)).rejects.toThrow();
      expect([...f.store.files]).toEqual(withoutRollback);
    }
  });
  it("refuses a shape-valid new confirmed journal without durable frozen sidecars", async () => {
    const f = await makeNormalizedFixture();
    const plan = await sealNormalizedPushPlan(f.input);
    await expect(
      new NormalizedPushRepository(f.store, NORMALIZED_ROOT).write({
        ...plan,
        phase: "confirmed",
        verifiedTarget: null,
        completion: null,
      }),
    ).rejects.toThrow();
    expect(
      await f.store.read(`${NORMALIZED_ROOT}/push/journal.json`),
    ).toBeNull();
  });
  it("never reuses an operation directory with retained terminal credentials", async () => {
    const f = await makeLocalOnlyFixture();
    const { repo, journal } = await completeLocalOnly(f);
    await repo.cleanup(journal);
    const router = new PushJournalRouter(f.store, NORMALIZED_ROOT);
    const port = router.v3Port();
    await port.read();
    await port.write(makeV3Journal(f, { idempotencyKey: "later-op" }));
    const before = [...f.store.files];
    await expect(
      repo.stage(
        await sealNormalizedPushPlan(f.input),
        f.push,
        f.candidate,
        f.rawPageBytes,
      ),
    ).rejects.toThrow();
    expect([...f.store.files]).toEqual(before);
  });
  it.each(["bom", "utf8", "extra", "raw-total", "canonical"])(
    "rejects %s evidence without durable confirmation",
    async (variant) => {
      const f = await makeLocalOnlyFixture();
      const raw: Record<string, Uint8Array> = { ...f.rawPageBytes };
      if (variant === "bom")
        raw["pages/note.md"] = new Uint8Array([
          239,
          187,
          191,
          ...f.rawPageBytes["pages/note.md"],
        ]);
      if (variant === "utf8") raw["pages/note.md"] = new Uint8Array([255]);
      if (variant === "extra") raw["pages/extra.md"] = new Uint8Array();
      if (variant === "canonical") f.candidate.pages[0]!.body = "tampered body";
      if (variant === "raw-total") {
        raw["pages/other.md"] = new TextEncoder().encode("x".repeat(90));
        f.input.rawPathStates["pages/other.md"] = {
          kind: "file",
          hash: await sha256Hex(raw["pages/other.md"]),
        };
        f.push.capabilities.maxPageBytes = 100;
        f.push.capabilities.maxClientTotalBodyBytes = 100;
        f.push.capabilitiesHash = await treeCapabilitiesHashV3(
          f.push.capabilities,
        );
        f.input.capabilitiesHash = f.push.capabilitiesHash;
        f.push.confirmationHash = await treeConfirmationHashV3({
          protocolVersion: "3",
          spaceId: f.push.spaceId,
          baseRevision: f.push.baseRevision,
          capabilitiesHash: f.push.capabilitiesHash,
          changes: [],
        });
        f.input.wireConfirmationHash = f.push.confirmationHash;
      }
      await expect(
        new NormalizedPushRepository(f.store, NORMALIZED_ROOT).stage(
          await sealNormalizedPushPlan(f.input),
          f.push,
          f.candidate,
          raw,
        ),
      ).rejects.toThrow();
      expect(
        await f.store.read(`${NORMALIZED_ROOT}/push/journal.json`),
      ).toBeNull();
    },
  );
  it("requires matching published child, committed transaction and applied identities for remote completion", async () => {
    const f = await makeNormalizedFixture();
    const { repo, journal, paths } = await completeLocalOnly(f);
    await repo.cleanup(journal);
    for (let i = 0; i < 2; i++) await repo.assertTerminal(journal);
    const childPath = `${paths.remoteRoot}/journal.json`;
    const child = (
      JSON.parse(
        (await f.store.read(childPath))!,
      ) as MutableControlEnvelope<TreePushJournalV3>
    ).payload;
    await f.store.write(
      childPath,
      await envelopeFor({ ...child, idempotencyKey: "foreign-op" }, 4),
    );
    for (let i = 0; i < 2; i++)
      await expect(repo.assertTerminal(journal)).rejects.toThrow("ownership");
  });
  it.each([
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ])(
    "selects terminal3→4→terminal4→3 across candidate placement %j",
    async (a, b, c) => {
      const f = await makeLocalOnlyFixture();
      const router = new PushJournalRouter(f.store, NORMALIZED_ROOT);
      const port = router.v3Port();
      await port.read();
      await port.write(makeV3Journal(f));
      const old3 = (await f.store.read(
        `${NORMALIZED_ROOT}/push/journal.json`,
      ))!;
      const { journal, repo } = await completeLocalOnly(f);
      await repo.cleanup(journal);
      const terminal4 = (await f.store.read(
        `${NORMALIZED_ROOT}/push/journal.json`,
      ))!;
      const next = router.v3Port();
      await next.read();
      await next.write(
        makeV3Journal(f, {
          idempotencyKey: "next-op",
          remoteState: "not_created",
        }),
      );
      const new3 = (await f.store.read(
        `${NORMALIZED_ROOT}/push/journal.json`,
      ))!;
      const candidates = [old3, terminal4, new3];
      const root = `${NORMALIZED_ROOT}/push/journal.json`;
      await f.store.write(root, candidates[a]!);
      await f.store.write(`${root}.prev`, candidates[b]!);
      await f.store.write(`${root}.next`, candidates[c]!);
      const before = [...f.store.files];
      for (let i = 0; i < 2; i++) {
        const read = await router.read();
        expect(read!.writeGeneration).toBe(5);
        expect(read!.payload.schemaVersion).toBe(3);
      }
      expect([...f.store.files]).toEqual(before);
    },
  );
  it.each([
    "unknown",
    "write-kind",
    "duplicate",
    "overlap",
    "hash",
    "infinite",
    "escape",
    "raw-state",
    "replacement",
    "identity",
  ])("rejects strict invalid %s evidence", async (variant) => {
    const input = await makeNormalizedPlanInput();
    const changed = structuredClone(input);
    if (variant === "unknown") Object.assign(changed, { futureField: true });
    if (variant === "write-kind")
      Object.assign(changed.localPlan[0]!, { kind: "trash_page" });
    if (variant === "duplicate")
      changed.localPlan.push(structuredClone(changed.localPlan[0]!));
    if (variant === "overlap") {
      const action = {
        ...changed.localPlan[0]!,
        path: "pages/note.md/child.md",
        pageId: "other",
      };
      changed.localPlan.push(action);
    }
    if (variant === "hash") changed.localPlan[0]!.beforeHash = "wrong";
    if (variant === "infinite") changed.localPlan[0]!.byteLength = Infinity;
    if (variant === "escape")
      changed.localPlan[0]!.path = "pages/../outside.md";
    if (variant === "raw-state")
      changed.rawPathStates["pages/note.md"] = { kind: "file", hash: null };
    if (variant === "replacement")
      changed.normalizations[0]!.replacements[0]!.targetEnd = 0;
    if (variant === "identity")
      Object.assign(changed.identities, { schemaVersion: 1 });
    await expect(sealNormalizedPushPlan(changed)).rejects.toThrow();
  });
  it("rejects candidate tampering during durable stage", async () => {
    const f = await makeNormalizedFixture();
    f.store.onTextWrite = (path) => {
      if (path.endsWith("candidate.json")) f.store.files.set(path, "{}");
    };
    await expect(
      new NormalizedPushRepository(f.store, NORMALIZED_ROOT).stage(
        await sealNormalizedPushPlan(f.input),
        f.push,
        f.candidate,
        f.rawPageBytes,
      ),
    ).rejects.toThrow();
    expect(
      await f.store.read(`${NORMALIZED_ROOT}/push/journal.json`),
    ).toBeNull();
  });
  it("does not let an old terminal4 phase regress under a newer envelope", async () => {
    const f = await makeLocalOnlyFixture();
    const { journal } = await completeLocalOnly(f);
    const changed = { ...journal, phase: "local_pending", completion: null };
    const root = `${NORMALIZED_ROOT}/push/journal.json`;
    await f.store.write(`${root}.next`, await envelopeFor(changed, 4));
    for (let i = 0; i < 2; i++)
      await expect(
        new PushJournalRouter(f.store, NORMALIZED_ROOT).read(),
      ).rejects.toThrow();
  });
  it("rejects child changes whose confirmation no longer matches retained publication", async () => {
    const f = await makeNormalizedFixture();
    const { repo, journal, paths } = await completeLocalOnly(f);
    const root = `${paths.remoteRoot}/journal.json`;
    const child = (
      JSON.parse(
        (await f.store.read(root))!,
      ) as MutableControlEnvelope<TreePushJournalV3>
    ).payload;
    child.changes = [];
    await f.store.write(root, await envelopeFor(child, 4));
    for (let i = 0; i < 2; i++)
      await expect(repo.assertTerminal(journal)).rejects.toThrow();
  });
  it("rejects foreign terminal ownership among otherwise valid generations", async () => {
    const f = await makeNormalizedFixture();
    const repo = new NormalizedPushRepository(f.store, NORMALIZED_ROOT);
    await repo.stage(
      await sealNormalizedPushPlan(f.input),
      f.push,
      f.candidate,
      f.rawPageBytes,
    );
    await f.store.write(
      `${NORMALIZED_ROOT}/push/journal.json.prev`,
      await envelopeFor(makeV3Journal(f, { spaceId: "foreign-space" }), 1),
    );
    const current = JSON.parse(
      (await f.store.read(`${NORMALIZED_ROOT}/push/journal.json`))!,
    ) as MutableControlEnvelope<unknown>;
    current.writeGeneration = 2;
    await f.store.write(
      `${NORMALIZED_ROOT}/push/journal.json`,
      JSON.stringify(current),
    );
    for (let i = 0; i < 2; i++) await expect(repo.read()).rejects.toThrow();
  });
  it.each(["candidate.json", "wire.json", "page"])(
    "detects missing and changed %s sidecars on every load",
    async (name) => {
      const f = await makeNormalizedFixture();
      const plan = await sealNormalizedPushPlan(f.input);
      const repo = new NormalizedPushRepository(f.store, NORMALIZED_ROOT);
      await repo.stage(plan, f.push, f.candidate, f.rawPageBytes);
      const j = (await repo.read())!;
      const path =
        name === "page"
          ? plan.localPlan[0]!.payloadPath
          : `${normalizedPushPaths(NORMALIZED_ROOT, "op-1").payloadRoot}/${name}`;
      await f.store.remove(path);
      for (let i = 0; i < 2; i++)
        await expect(repo.loadConfirmed(j)).rejects.toThrow();
      await f.store.write(path, "{}");
      for (let i = 0; i < 2; i++)
        await expect(repo.loadConfirmed(j)).rejects.toThrow();
    },
  );
  it("keeps legacy 1/2 dispatch and strict3 separate from injected terminal4", async () => {
    const f = await makeLocalOnlyFixture();
    await completeLocalOnly(f);
    const local = {
      readBlob: async () => null,
      revalidateConfirmation: async () => f.push.confirmationHash,
    };
    const strict = new TreePushServiceV3(
      f.remote,
      f.store,
      `${NORMALIZED_ROOT}/push`,
      local,
    );
    await expect(strict.inspect()).rejects.toThrow();
    await expect(strict.resumePending()).rejects.toThrow();
    const compatible = new TreePushServiceV3(
      f.remote,
      f.store,
      `${NORMALIZED_ROOT}/push`,
      local,
      undefined,
      new PushJournalRouter(f.store, NORMALIZED_ROOT).v3Port(),
    );
    expect(await compatible.inspect()).toBeNull();
    await expect(compatible.resumePending()).rejects.toThrow("推送日志缺失");
    for (const version of [1, 2]) {
      const legacy = await makeNormalizedFixture();
      const raw = await envelopeFor({ schemaVersion: version });
      await legacy.store.write(`${NORMALIZED_ROOT}/push/journal.json`, raw);
      await expect(
        new PushJournalRouter(legacy.store, NORMALIZED_ROOT).read(),
      ).rejects.toThrow();
      expect(
        await legacy.store.read(`${NORMALIZED_ROOT}/push/journal.json`),
      ).toBe(raw);
      expect(isTreePushJournalV3({ schemaVersion: version })).toBe(false);
    }
  });
  it.each([".next", "main-renamed"])(
    "recovers a staged parent after interruption at %s without extra generations",
    async (point) => {
      const f = await makeNormalizedFixture();
      const router = new PushJournalRouter(f.store, NORMALIZED_ROOT);
      const port = router.v3Port();
      await port.read();
      await port.write(makeV3Journal(f));
      const journalPath = `${NORMALIZED_ROOT}/push/journal.json`;
      const rename = f.store.rename.bind(f.store);
      let fired = false;
      f.store.rename = async (from, to) => {
        if (
          !fired &&
          ((point === ".next" && from === journalPath) ||
            (point === "main-renamed" && from === `${journalPath}.next`))
        ) {
          fired = true;
          throw new Error("interrupted rename");
        }
        await rename(from, to);
      };
      const repo = new NormalizedPushRepository(f.store, NORMALIZED_ROOT);
      await expect(
        repo.stage(
          await sealNormalizedPushPlan(f.input),
          f.push,
          f.candidate,
          f.rawPageBytes,
        ),
      ).rejects.toThrow("interrupted rename");
      const before = [...f.store.files];
      for (let i = 0; i < 2; i++) {
        expect((await router.read())!.writeGeneration).toBe(2);
        await repo.loadConfirmed((await repo.read())!);
      }
      expect([...f.store.files]).toEqual(before);
    },
  );
  it("detects same-generation forks even below a newer main", async () => {
    const f = await makeNormalizedFixture();
    const repo = new NormalizedPushRepository(f.store, NORMALIZED_ROOT);
    await repo.stage(
      await sealNormalizedPushPlan(f.input),
      f.push,
      f.candidate,
      f.rawPageBytes,
    );
    const j = (await repo.read())!;
    await f.store.write(
      `${NORMALIZED_ROOT}/push/journal.json`,
      await envelopeFor(j, 3),
    );
    await f.store.write(
      `${NORMALIZED_ROOT}/push/journal.json.prev`,
      await envelopeFor(j, 1),
    );
    await f.store.write(
      `${NORMALIZED_ROOT}/push/journal.json.next`,
      await envelopeFor({ ...j, phase: "superseded" }, 1),
    );
    for (let i = 0; i < 2; i++)
      await expect(repo.read()).rejects.toThrow("fork");
  });
  it("bounds actual raw bytes independently from canonical bytes", async () => {
    const f = await makeLocalOnlyFixture();
    const raw = new TextEncoder().encode("![A](photo.png)" + "\r\n".repeat(50));
    const g = await makeNormalizedFixture(new TextDecoder().decode(raw));
    g.push.capabilities.maxPageBytes = 100;
    g.push.capabilitiesHash = await treeCapabilitiesHashV3(g.push.capabilities);
    g.input.capabilitiesHash = g.push.capabilitiesHash;
    g.push.changes = [];
    g.input.mode = "local_only";
    g.input.sourceTreeHash = g.input.candidateHash;
    g.push.confirmationHash = await treeConfirmationHashV3({
      protocolVersion: "3",
      spaceId: g.push.spaceId,
      baseRevision: g.push.baseRevision,
      capabilitiesHash: g.push.capabilitiesHash,
      changes: [],
    });
    g.input.wireConfirmationHash = g.push.confirmationHash;
    await expect(
      new NormalizedPushRepository(g.store, NORMALIZED_ROOT).stage(
        await sealNormalizedPushPlan(g.input),
        g.push,
        g.candidate,
        g.rawPageBytes,
      ),
    ).rejects.toThrow("Raw Page quota");
    expect(f.remote.createInputs).toHaveLength(0);
  });
  it("retains completion through later edits, later baseline, cleanup and repeated replacement", async () => {
    const f = await makeLocalOnlyFixture();
    const { repo, journal, vault } = await completeLocalOnly(f);
    vault.seedMarkdown("Wiki/pages/note.md", "later user edit");
    await f.store.write(
      `${NORMALIZED_ROOT}/tree-v2/current.json`,
      "later Pull baseline",
    );
    for (let i = 0; i < 2; i++) {
      await repo.cleanup(journal);
      await repo.assertTerminal(journal);
    }
    const router = new PushJournalRouter(f.store, NORMALIZED_ROOT);
    const port = router.v3Port();
    expect(await port.read()).toBeNull();
    expect(await port.read()).toBeNull();
    await port.write(
      makeV3Journal(f, {
        idempotencyKey: "new-op",
        remoteState: "not_created",
      }),
    );
    expect((await router.read())!.writeGeneration).toBe(4);
    expect(
      [...f.store.files.keys()].some((p) => p.endsWith("op-1/terminal.json")),
    ).toBe(true);
    expect(
      new TextDecoder().decode(
        (await vault.read("Wiki/pages/note.md")) ?? undefined,
      ),
    ).toBe("later user edit");
    await port.clear();
    await repo.assertTerminal(journal);
  });
  it.each([".prev", ".next", ""])(
    "rejects every corrupt or future candidate at %s including lower generations",
    async (suffix) => {
      const f = await makeNormalizedFixture();
      const repo = new NormalizedPushRepository(f.store, NORMALIZED_ROOT);
      await repo.stage(
        await sealNormalizedPushPlan(f.input),
        f.push,
        f.candidate,
        f.rawPageBytes,
      );
      const path = `${NORMALIZED_ROOT}/push/journal.json${suffix}`;
      for (const bad of ["{", await envelopeFor({ schemaVersion: 7 }, 1)]) {
        await f.store.write(path, bad);
        const before = [...f.store.files];
        for (let i = 0; i < 2; i++) await expect(repo.read()).rejects.toThrow();
        expect([...f.store.files]).toEqual(before);
      }
    },
  );
  it("rejects missing completion even after payload cleanup", async () => {
    const f = await makeLocalOnlyFixture();
    const { repo, journal, paths } = await completeLocalOnly(f);
    await repo.cleanup(journal);
    await f.store.remove(paths.completionPath);
    for (let i = 0; i < 2; i++)
      await expect(repo.assertTerminal(journal)).rejects.toThrow();
  });
  it("refuses replacement of pending 4 and stale competing v3 writer", async () => {
    const f = await makeNormalizedFixture();
    const router = new PushJournalRouter(f.store, NORMALIZED_ROOT);
    const first = router.v3Port();
    const second = router.v3Port();
    await first.read();
    await second.read();
    await first.write(makeV3Journal(f, { remoteState: "not_created" }));
    await expect(
      second.write(makeV3Journal(f, { idempotencyKey: "other" })),
    ).rejects.toThrow();
    await first.clear();
    const repo = new NormalizedPushRepository(f.store, NORMALIZED_ROOT);
    await repo.stage(
      await sealNormalizedPushPlan(f.input),
      f.push,
      f.candidate,
      f.rawPageBytes,
    );
    await expect(router.v3Port().read()).rejects.toThrow();
    await expect(first.clear()).rejects.toThrow();
  });
  it("persists owned payloads before confirmation and reloads twice without writes", async () => {
    const f = await makeNormalizedFixture();
    const plan = await sealNormalizedPushPlan(f.input);
    const repo = new NormalizedPushRepository(f.store, NORMALIZED_ROOT);
    await repo.stage(plan, f.push, f.candidate, f.rawPageBytes);
    await f.store.removeTree(`${NORMALIZED_ROOT}/preview`);
    const before = [...f.store.files];
    for (let i = 0; i < 2; i++) {
      const j = (await repo.read())!;
      expect((await repo.loadConfirmed(j)).candidate.pages[0]!.body).toBe(
        "![A](../assets/photo.png)",
      );
      expect(j.phase).toBe("confirmed");
    }
    expect([...f.store.files]).toEqual(before);
    expect(
      (await new PushJournalRouter(f.store, NORMALIZED_ROOT).read())!
        .writeGeneration,
    ).toBe(1);
  });
  it("refuses missing, changed raw and injected payload paths before any journal", async () => {
    const f = await makeNormalizedFixture();
    const repo = new NormalizedPushRepository(f.store, NORMALIZED_ROOT);
    const plan = await sealNormalizedPushPlan(f.input);
    await expect(repo.stage(plan, f.push, f.candidate, {})).rejects.toThrow();
    await expect(
      repo.stage(plan, f.push, f.candidate, {
        "pages/note.md": new TextEncoder().encode("late edit"),
      }),
    ).rejects.toThrow();
    const bad = structuredClone(f.input);
    bad.localPlan[0]!.payloadPath = ".agentwiki/foreign.md";
    await expect(
      repo.stage(
        await sealNormalizedPushPlan(bad),
        f.push,
        f.candidate,
        f.rawPageBytes,
      ),
    ).rejects.toThrow();
    expect(
      await f.store.read(`${NORMALIZED_ROOT}/push/journal.json`),
    ).toBeNull();
  });
  it("binds original bytes even when canonical wire stays equal", async () => {
    const input = await makeNormalizedPlanInput("![A](photo.png)\n");
    const first = await sealNormalizedPushPlan(input);
    const changed = structuredClone(input);
    const rawHash = await sha256Hex(
      new TextEncoder().encode("![A](photo.png)\r\n"),
    );
    changed.rawPathStates["pages/note.md"]!.hash = rawHash;
    changed.localPlan[0]!.beforeHash = rawHash;
    changed.normalizations[0]!.rawHash = rawHash;
    const second = await sealNormalizedPushPlan(changed);
    expect(second.authorizationHash).not.toBe(first.authorizationHash);
    expect(second.wireConfirmationHash).toBe(first.wireConfirmationHash);
  });
  it("seals a strict confirmed plan and rejects future schema", async () => {
    const plan = await sealNormalizedPushPlan(await makeNormalizedPlanInput());
    const journal = {
      ...plan,
      phase: "confirmed",
      verifiedTarget: null,
      completion: null,
    };
    expect(isNormalizedPushJournal(journal)).toBe(true);
    expect(isNormalizedPushJournal({ ...journal, schemaVersion: 5 })).toBe(
      false,
    );
  });
});
