import { describe, expect, it } from "vitest";

import {
  envelopeFor,
  makeNormalizedCoordinatorFixture,
} from "../fakes/normalized-push-fixture";
import { normalizedPushPaths } from "../../src/application/normalized-push-plan";
import { NormalizedPushRepository } from "../../src/storage/normalized-push";
import { TreeBaselineRepository } from "../../src/storage/tree-baseline";
import { NORMALIZED_ROOT } from "../fakes/normalized-push-fixture";

describe("NormalizedPushCoordinator", () => {
  it("local-only changes require no publication but do commit the file", async () => {
    const f = await makeNormalizedCoordinatorFixture("local_only");
    const before = await f.remote.head();
    await f.coordinator.confirm(f.plan, f.push, f.candidate);
    expect(
      new TextDecoder().decode((await f.vault.read("Wiki/pages/note.md"))!),
    ).toBe("![A](../assets/photo.png)");
    expect(f.remote.createInputs).toEqual([]);
    expect(f.remote.uploadedChunkIndexes).toEqual([]);
    expect(f.remote.finalizeCalls).toBe(0);
    expect((await f.remote.head()).revision).toBe(before.revision);
    expect(await f.coordinator.inspect()).toMatchObject({
      mode: "local_only",
      phase: "complete",
    });
  });

  it("publishes through the owned child, then commits the same target locally", async () => {
    const f = await makeNormalizedCoordinatorFixture("remote_push");
    await f.coordinator.confirm(f.plan, f.push, f.candidate);

    expect(f.remote.createInputs).toHaveLength(1);
    expect(f.remote.createInputs[0]?.idempotencyKey).toBe(
      f.plan.binding.operationId,
    );
    expect(f.remote.finalizeCalls).toBe(1);
    expect(f.vault.text("Wiki/pages/note.md")).toBe(
      "![A](../assets/photo.png)",
    );
    expect(await f.coordinator.inspect()).toMatchObject({
      mode: "remote_push",
      phase: "complete",
      verifiedTarget: { revision: "rev-push-1" },
    });
    const remoteRoot = normalizedPushPaths(
      NORMALIZED_ROOT,
      f.plan.binding.operationId,
    ).remoteRoot;
    expect(await f.control.read(`${remoteRoot}/journal.json`)).toContain(
      '"localCommitPhase":"verified"',
    );
  });

  it.each(["raw edit", "asset rename", "basename collision"])(
    "recomputes complete local authorization after %s",
    async (change) => {
      const f = await makeNormalizedCoordinatorFixture("local_only");
      if (change === "raw edit")
        f.vault.seedMarkdown("Wiki/pages/note.md", "edited");
      if (change === "asset rename")
        await f.vault.rename(
          "Wiki/assets/photo.png",
          "Wiki/assets/renamed.png",
        );
      if (change === "basename collision")
        f.vault.seedFile("Wiki/archive/photo.png", new Uint8Array([4]));

      await expect(
        f.coordinator.confirm(f.plan, f.push, f.candidate),
      ).rejects.toThrow("NORMALIZED_PUSH_AUTHORIZATION_CHANGED");
      expect(await f.coordinator.inspect()).toBeNull();
      expect(f.remote.createInputs).toEqual([]);
    },
  );

  it("recovers one remote publication after create and finalize responses are lost", async () => {
    const f = await makeNormalizedCoordinatorFixture("remote_push");
    f.remote.loseCreateResponseOnce = true;
    await expect(
      f.coordinator.confirm(f.plan, f.push, f.candidate),
    ).rejects.toThrow("create response lost");
    await f.rebuild().recover();
    await f.rebuild().recover();
    expect(
      new Set(f.remote.createInputs.map((item) => item.idempotencyKey)),
    ).toEqual(new Set([f.plan.binding.operationId]));
    expect(f.remote.finalizeCalls).toBe(1);
    expect(await f.coordinator.inspect()).toMatchObject({ phase: "complete" });
  });

  it("recovers a lost finalize response without republishing", async () => {
    const f = await makeNormalizedCoordinatorFixture("remote_push");
    f.remote.loseFinalizeResponseOnce = true;
    await expect(
      f.coordinator.confirm(f.plan, f.push, f.candidate),
    ).rejects.toThrow("finalize response lost");
    expect(f.remote.createInputs).toHaveLength(1);
    expect(f.remote.finalizeCalls).toBe(1);

    await f.rebuild().recover();
    await f.rebuild().recover();

    expect(f.remote.createInputs).toHaveLength(1);
    expect(f.remote.finalizeCalls).toBe(1);
    expect(await f.coordinator.inspect()).toMatchObject({ phase: "complete" });
  });

  it("keeps complete evidence when payload cleanup is interrupted", async () => {
    const f = await makeNormalizedCoordinatorFixture("local_only");
    const payloadRoot = normalizedPushPaths(
      NORMALIZED_ROOT,
      f.plan.binding.operationId,
    ).payloadRoot;
    f.control.failNextRemoveTreeAt = payloadRoot;
    await expect(
      f.coordinator.confirm(f.plan, f.push, f.candidate),
    ).rejects.toThrow("injected remove tree failure");
    expect(await f.coordinator.inspect()).toMatchObject({ phase: "complete" });

    await f.rebuild().recover();
    expect(await f.control.read(`${payloadRoot}/candidate.json`)).toBeNull();
  });

  it("supersedes confirmed work without inventing a child", async () => {
    const f = await makeNormalizedCoordinatorFixture("local_only");
    await new NormalizedPushRepository(f.control, NORMALIZED_ROOT).stage(
      f.plan,
      f.push,
      f.candidate,
      { "pages/note.md": (await f.vault.read("Wiki/pages/note.md"))! },
    );
    expect(await f.coordinator.inspect()).toMatchObject({ phase: "confirmed" });

    await f.rebuild().cancel();
    expect(await f.coordinator.inspect()).toMatchObject({
      phase: "superseded",
    });
  });

  it.each(["local_only", "remote_push"] as const)(
    "%s keeps the fixed target pending when its exact snapshot cannot be read",
    async (mode) => {
      const f = await makeNormalizedCoordinatorFixture(mode);
      f.remote.failAfterSnapshot = true;
      await expect(
        f.coordinator.confirm(f.plan, f.push, f.candidate),
      ).rejects.toThrow("SNAPSHOT_FINAL_HASH_MISMATCH");
      expect(await f.coordinator.inspect()).toMatchObject({
        phase: mode === "remote_push" ? "remote_pending" : "confirmed",
      });
      expect(f.vault.text("Wiki/pages/note.md")).toBe("![A](photo.png)");

      f.remote.failAfterSnapshot = false;
      await f.rebuild().recover();
      await f.rebuild().recover();
      expect(await f.coordinator.inspect()).toMatchObject({
        phase: "complete",
      });
      expect(f.remote.finalizeCalls).toBe(mode === "remote_push" ? 1 : 0);
    },
  );

  it.each(["local_only", "remote_push"] as const)(
    "%s stops at the actual Page CAS without advancing completion",
    async (mode) => {
      const f = await makeNormalizedCoordinatorFixture(mode);
      f.vault.failAfterOperations = 1;
      await expect(
        f.coordinator.confirm(f.plan, f.push, f.candidate),
      ).rejects.toThrow("injected vault failure");
      expect(f.vault.operations).toBe(1);
      expect(f.vault.operationLog).not.toContain("write:Wiki/pages/note.md");
      expect(f.vault.text("Wiki/pages/note.md")).toBe("![A](photo.png)");
      expect(await f.coordinator.inspect()).toMatchObject({
        phase: "local_pending",
        completion: null,
      });
      const publishedRevision = (await f.remote.head()).revision;

      f.vault.failAfterOperations = null;
      await f.rebuild().recover();
      await f.rebuild().recover();
      expect(f.vault.operationLog).toContain("cas:Wiki/pages/note.md");
      expect(await f.coordinator.inspect()).toMatchObject({
        phase: "complete",
      });
      expect((await f.remote.head()).revision).toBe(publishedRevision);
    },
  );

  it("rolls back an owned local-only Page CAS before superseding", async () => {
    const f = await makeNormalizedCoordinatorFixture("local_only");
    let interrupted = false;
    f.control.onTextWrite = (path) => {
      if (
        !interrupted &&
        path.includes("/local/journal.json") &&
        f.vault.operationLog.includes("cas:Wiki/pages/note.md")
      ) {
        interrupted = true;
        throw new Error("after actual page cas");
      }
    };
    await expect(
      f.coordinator.confirm(f.plan, f.push, f.candidate),
    ).rejects.toThrow("after actual page cas");
    expect(f.vault.text("Wiki/pages/note.md")).toBe(
      "![A](../assets/photo.png)",
    );
    f.control.onTextWrite = undefined;

    await f.rebuild().cancel();
    expect(f.vault.text("Wiki/pages/note.md")).toBe("![A](photo.png)");
    expect(await f.coordinator.inspect()).toMatchObject({
      phase: "superseded",
      verifiedTarget: { revision: "rev-1" },
    });
  });

  it("only supersedes a remote child after abort is authoritative", async () => {
    const f = await makeNormalizedCoordinatorFixture("remote_push");
    f.remote.onUploadBatch = () => {
      throw new Error("batch response lost");
    };
    await expect(
      f.coordinator.confirm(f.plan, f.push, f.candidate),
    ).rejects.toThrow("batch response lost");
    f.remote.onUploadBatch = undefined;

    await f.rebuild().cancel();
    expect(f.remote.abortCalls).toBe(1);
    expect(await f.coordinator.inspect()).toMatchObject({
      phase: "superseded",
    });
  });

  it("does not call a lost Finalize outcome cancelled after publication", async () => {
    const f = await makeNormalizedCoordinatorFixture("remote_push");
    f.remote.loseFinalizeResponseOnce = true;
    await expect(
      f.coordinator.confirm(f.plan, f.push, f.candidate),
    ).rejects.toThrow("finalize response lost");
    await expect(f.rebuild().cancel()).rejects.toThrow(
      "NORMALIZED_PUSH_CANCEL_OUTCOME_UNKNOWN",
    );
    expect(await f.coordinator.inspect()).toMatchObject({
      phase: "remote_pending",
    });
    expect((await f.remote.head()).revision).toBe("rev-push-1");
  });

  it("refuses cancellation after the remote child is published", async () => {
    const f = await makeNormalizedCoordinatorFixture("remote_push");
    f.remote.failAfterSnapshot = true;
    await expect(
      f.coordinator.confirm(f.plan, f.push, f.candidate),
    ).rejects.toThrow("SNAPSHOT_FINAL_HASH_MISMATCH");
    f.remote.failAfterSnapshot = false;

    await expect(f.rebuild().cancel()).rejects.toThrow(
      "已发布的推送无法被替代",
    );
    expect(await f.coordinator.inspect()).toMatchObject({
      phase: "remote_pending",
    });
  });

  it("recovers after the child is locally verified but parent completion was interrupted", async () => {
    const f = await makeNormalizedCoordinatorFixture("remote_push");
    let childVerified = false;
    f.control.onTextWrite = (path) => {
      const raw = f.control.files.get(path);
      if (
        path.includes("/remote/journal.json") &&
        raw?.includes('"localCommitPhase":"verified"')
      )
        childVerified = true;
      if (
        childVerified &&
        path.includes(`${NORMALIZED_ROOT}/push/journal.json`)
      )
        throw new Error("after child markVerified");
    };
    await expect(
      f.coordinator.confirm(f.plan, f.push, f.candidate),
    ).rejects.toThrow("after child markVerified");
    f.control.onTextWrite = undefined;

    await f.rebuild().recover();
    await f.rebuild().recover();
    expect(f.remote.finalizeCalls).toBe(1);
    expect(await f.coordinator.inspect()).toMatchObject({ phase: "complete" });
  });

  it("refuses cancellation after committed completion", async () => {
    const f = await makeNormalizedCoordinatorFixture("local_only");
    await f.coordinator.confirm(f.plan, f.push, f.candidate);
    await expect(f.rebuild().cancel()).rejects.toThrow(
      "NORMALIZED_PUSH_ALREADY_COMPLETE",
    );
  });

  const localBoundaries = [
    ["tree prepared", "/local/journal.json.next", "state", "prepared"],
    ["binding", "/control-after-binding.json.next", "schemaVersion", 1],
    ["control pending", "/control-after.json.next", "phase", "pending"],
    ["page cursor", "/local/journal.json.next", "nextOperation", 1],
    ["tree applied", "/local/journal.json.next", "state", "applied"],
    ["tree verified", "/local/journal.json.next", "state", "verified"],
    [
      "baseline prepared",
      "/tree-v2/baseline-journal.json.next",
      "phase",
      "prepared",
    ],
    [
      "baseline applying",
      "/tree-v2/baseline-journal.json.next",
      "phase",
      "applying",
    ],
    [
      "baseline committing",
      "/tree-v2/baseline-journal.json.next",
      "phase",
      "committing",
    ],
    ["baseline switched", "/tree-v2/current.json.next", "schemaVersion", 1],
    [
      "baseline committed",
      "/tree-v2/baseline-journal.json.next",
      "phase",
      "committed",
    ],
    ["identities", "/tree-identities.json.next", "schemaVersion", 2],
    ["control applied", "/control-after.json.next", "phase", "applied"],
    ["tree committed", "/local/journal.json.next", "state", "committed"],
    ["completion", "/completion.json.next", "transactionId", "tx-1"],
  ] as const;

  for (const mode of ["local_only", "remote_push"] as const)
    for (const [label, suffix, key, expected] of localBoundaries)
      for (const moment of ["before", "after"] as const)
        it(`${mode} recovers twice ${moment} ${label}`, async () => {
          const f = await makeNormalizedCoordinatorFixture(mode);
          const original = f.control.write.bind(f.control);
          let interrupted = false;
          f.control.write = async (path, value) => {
            const payload = path.endsWith(suffix)
              ? (JSON.parse(value) as { payload?: Record<string, unknown> })
                  .payload
              : undefined;
            const matches =
              !interrupted &&
              path.endsWith(suffix) &&
              payload?.[key] === expected;
            if (matches) interrupted = true;
            if (matches && moment === "before")
              throw new Error("coordinator boundary failure");
            await original(path, value);
            if (matches && moment === "after")
              throw new Error("coordinator boundary failure");
          };
          await expect(
            f.coordinator.confirm(f.plan, f.push, f.candidate),
          ).rejects.toThrow("coordinator boundary failure");
          expect(interrupted).toBe(true);
          const revisionAfterFailure = (await f.remote.head()).revision;
          f.control.write = original;

          await f.rebuild().recover();
          await f.rebuild().recover();
          expect(f.vault.text("Wiki/pages/note.md")).toBe(
            "![A](../assets/photo.png)",
          );
          expect(await f.coordinator.inspect()).toMatchObject({
            phase: "complete",
          });
          expect((await f.remote.head()).revision).toBe(revisionAfterFailure);
          expect(
            new Set(f.remote.createInputs.map((item) => item.idempotencyKey)),
          ).toEqual(
            mode === "remote_push"
              ? new Set([f.plan.binding.operationId])
              : new Set(),
          );
          const baseline = new TreeBaselineRepository(
            f.control,
            NORMALIZED_ROOT,
            "space-1",
            "Wiki",
          );
          expect((await baseline.read()).baseRevision).toBe(
            mode === "remote_push" ? "rev-push-1" : "rev-1",
          );
        });

  for (const mode of ["local_only", "remote_push"] as const)
    for (const [label, suffix, key, expected] of [
      ["parent stage", "/push/journal.json.next", "phase", "confirmed"],
      ["local pending", "/push/journal.json.next", "phase", "local_pending"],
      ["parent complete", "/push/journal.json.next", "phase", "complete"],
    ] as const)
      it(`${mode} recovers after ${label} is durable`, async () => {
        const f = await makeNormalizedCoordinatorFixture(mode);
        const original = f.control.write.bind(f.control);
        let interrupted = false;
        f.control.write = async (path, value) => {
          const payload = path.endsWith(suffix)
            ? (JSON.parse(value) as { payload?: Record<string, unknown> })
                .payload
            : undefined;
          const matches =
            !interrupted &&
            path.endsWith(suffix) &&
            payload?.[key] === expected;
          await original(path, value);
          if (matches) {
            interrupted = true;
            throw new Error("parent boundary failure");
          }
        };
        await expect(
          f.coordinator.confirm(f.plan, f.push, f.candidate),
        ).rejects.toThrow("parent boundary failure");
        expect(interrupted).toBe(true);
        f.control.write = original;
        await f.rebuild().recover();
        await f.rebuild().recover();
        expect(await f.coordinator.inspect()).toMatchObject({
          phase: "complete",
        });
        expect(f.remote.finalizeCalls).toBe(mode === "remote_push" ? 1 : 0);
      });

  it("recovers twice after the remote child stage is durable", async () => {
    const f = await makeNormalizedCoordinatorFixture("remote_push");
    const original = f.control.write.bind(f.control);
    let interrupted = false;
    f.control.write = async (path, value) => {
      const payload = path.endsWith("/remote/journal.json.next")
        ? (JSON.parse(value) as { payload?: { remoteState?: string } }).payload
        : undefined;
      await original(path, value);
      if (!interrupted && payload?.remoteState === "not_created") {
        interrupted = true;
        throw new Error("child stage failure");
      }
    };
    await expect(
      f.coordinator.confirm(f.plan, f.push, f.candidate),
    ).rejects.toThrow("child stage failure");
    f.control.write = original;
    await f.rebuild().recover();
    await f.rebuild().recover();
    expect(f.remote.finalizeCalls).toBe(1);
    expect(await f.coordinator.inspect()).toMatchObject({ phase: "complete" });
  });

  it("recovers twice after an accepted batch response is lost", async () => {
    const f = await makeNormalizedCoordinatorFixture("remote_push");
    f.remote.loseUploadBatchResponseOnce = true;
    await expect(
      f.coordinator.confirm(f.plan, f.push, f.candidate),
    ).rejects.toThrow("batch response lost");
    await f.rebuild().recover();
    await f.rebuild().recover();
    expect(f.remote.finalizeCalls).toBe(1);
    expect(f.remote.uploadedBatches).toHaveLength(1);
    expect(
      new Set(f.remote.createInputs.map((item) => item.idempotencyKey)),
    ).toEqual(new Set([f.plan.binding.operationId]));
  });

  it.each(["local_only", "remote_push"] as const)(
    "%s recovers twice after terminal cleanup is interrupted",
    async (mode) => {
      const f = await makeNormalizedCoordinatorFixture(mode);
      const payloadRoot = normalizedPushPaths(
        NORMALIZED_ROOT,
        f.plan.binding.operationId,
      ).payloadRoot;
      f.control.failNextRemoveTreeAt = payloadRoot;
      await expect(
        f.coordinator.confirm(f.plan, f.push, f.candidate),
      ).rejects.toThrow("injected remove tree failure");
      await f.rebuild().recover();
      await f.rebuild().recover();
      expect(await f.control.read(`${payloadRoot}/candidate.json`)).toBeNull();
      expect(await f.coordinator.inspect()).toMatchObject({
        phase: "complete",
      });
    },
  );

  it("treats an empty wire and empty local plan as a caller no-op", async () => {
    const f = await makeNormalizedCoordinatorFixture("local_only");
    await f.coordinator.confirm(
      { ...f.plan, localPlan: [] },
      { ...f.push, changes: [] },
      f.candidate,
    );
    expect(await f.coordinator.inspect()).toBeNull();
    expect(f.vault.text("Wiki/pages/note.md")).toBe("![A](photo.png)");
  });

  it.each(["local_only", "remote_push"] as const)(
    "%s supersedes a confirmed parent with no child",
    async (mode) => {
      const f = await makeNormalizedCoordinatorFixture(mode);
      await new NormalizedPushRepository(f.control, NORMALIZED_ROOT).stage(
        f.plan,
        f.push,
        f.candidate,
        { "pages/note.md": (await f.vault.read("Wiki/pages/note.md"))! },
      );
      await f.rebuild().cancel();
      expect(await f.coordinator.inspect()).toMatchObject({
        phase: "superseded",
      });
      expect(f.remote.createInputs).toEqual([]);
    },
  );

  it("refuses local-only cancellation before its deferred transaction exists", async () => {
    const f = await makeNormalizedCoordinatorFixture("local_only");
    const original = f.control.write.bind(f.control);
    let interrupted = false;
    f.control.write = async (path, value) => {
      const payload = path.endsWith("/push/journal.json.next")
        ? (JSON.parse(value) as { payload?: { phase?: string } }).payload
        : undefined;
      await original(path, value);
      if (!interrupted && payload?.phase === "local_pending") {
        interrupted = true;
        throw new Error("before deferred transaction");
      }
    };
    await expect(
      f.coordinator.confirm(f.plan, f.push, f.candidate),
    ).rejects.toThrow("before deferred transaction");
    f.control.write = original;
    await expect(f.rebuild().cancel()).rejects.toThrow(
      "NORMALIZED_LOCAL_CANCEL_UNSAFE",
    );
    expect(await f.coordinator.inspect()).toMatchObject({
      phase: "local_pending",
      verifiedTarget: { revision: "rev-1" },
    });
  });

  it("keeps remote cancellation pending when session status is network-unknown", async () => {
    const f = await makeNormalizedCoordinatorFixture("remote_push");
    f.remote.onUploadBatch = () => {
      throw new Error("batch response lost");
    };
    await expect(
      f.coordinator.confirm(f.plan, f.push, f.candidate),
    ).rejects.toThrow("batch response lost");
    f.remote.onUploadBatch = undefined;
    f.remote.getSessionFailuresRemaining = 1;
    await expect(f.rebuild().cancel()).rejects.toThrow(
      "NORMALIZED_PUSH_CANCEL_OUTCOME_UNKNOWN",
    );
    expect(await f.coordinator.inspect()).toMatchObject({
      phase: "remote_pending",
    });
  });

  it("blocks cancellation when the retained remote child is foreign", async () => {
    const f = await makeNormalizedCoordinatorFixture("remote_push");
    f.remote.onUploadBatch = () => {
      throw new Error("batch response lost");
    };
    await expect(
      f.coordinator.confirm(f.plan, f.push, f.candidate),
    ).rejects.toThrow("batch response lost");
    const childPath = `${
      normalizedPushPaths(NORMALIZED_ROOT, f.plan.binding.operationId)
        .remoteRoot
    }/journal.json`;
    const current = JSON.parse((await f.control.read(childPath))!) as {
      writeGeneration: number;
      payload: Record<string, unknown>;
    };
    await f.control.write(
      childPath,
      await envelopeFor(
        {
          ...current.payload,
          idempotencyKey: "00000000-0000-4000-8000-000000000099",
        },
        current.writeGeneration + 1,
      ),
    );
    const saved = new Map(f.control.files);
    await expect(f.rebuild().cancel()).rejects.toThrow(
      "Normalized child ownership mismatch",
    );
    expect(f.control.files).toEqual(saved);
  });
});
