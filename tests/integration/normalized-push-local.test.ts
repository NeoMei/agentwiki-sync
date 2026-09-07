import { expect, it } from "vitest";
import { makeNormalizedLocalFixture } from "../fakes/normalized-push-fixture";
import { NormalizedPushLocalCommitter } from "../../src/application/normalized-push-local";
import { normalizedPushPaths } from "../../src/application/normalized-push-plan";
import { MutableControlRepository } from "../../src/storage/envelope";
import { isV3PullControlAfterState } from "../../src/application/tree-local-apply-v3";
import { isNormalizedPushLocalBinding } from "../../src/application/normalized-push-plan";
import { TreeTransaction } from "../../src/application/tree-transaction";
import { canonicalBytes, sha256Hex } from "../../src/agentwiki/protocol";
import { scanLocalTree } from "../../src/core/tree-scan";
import { FakeTreeRemoteV3 } from "../fakes/fake-tree-remote";
import { emptyTreeIdentityState } from "../../src/storage/tree-identities";
import { envelopeFor } from "../fakes/normalized-push-fixture";
import { contentHash } from "../../src/agentwiki/protocol";
import {
  desiredV3Identities,
  applyV3ControlAfter,
} from "../../src/application/tree-local-apply-v3";

type Fixture = Awaited<ReturnType<typeof makeNormalizedLocalFixture>>;
const paths = (f: Fixture) =>
  normalizedPushPaths(f.controlRoot, f.journal.binding.operationId);
const rebuild = (f: Fixture) => new NormalizedPushLocalCommitter(f);

it("preserves an edit after precondition read and before the actual Page write", async () => {
  const f = await makeNormalizedLocalFixture();
  let editArrived = false;
  f.control.onTextWrite = (path) => {
    if (editArrived || !path.endsWith("/local/journal.json.next")) return;
    const value = JSON.parse(f.control.files.get(path)!) as {
      payload: { state: string };
    };
    if (value.payload.state !== "applying") return;
    f.vault.onRead = (pagePath) => {
      if (pagePath !== "Wiki/pages/note.md") return;
      f.vault.onRead = undefined;
      editArrived = true;
      f.vault.seedMarkdown(pagePath, "edit after precondition read");
    };
  };
  await expect(f.local.apply(f.journal, f.target)).rejects.toThrow("AMBIGUOUS");
  expect(editArrived).toBe(true);
  expect(f.vault.text("Wiki/pages/note.md")).toBe(
    "edit after precondition read",
  );
  expect(
    (
      await new TreeTransaction(
        f.vault,
        f.control,
        paths(f).localRoot,
      ).inspect()
    )?.state,
  ).toBe("ambiguous");
  expect((await f.baseline.inspectJournal())?.transactionId).toBe(
    "source-pull",
  );
  expect((await f.identities.read())?.payload).toEqual(f.journal.identities);
  await expect(rebuild(f).assertComplete(f.journal)).rejects.toThrow();
});

it("preserves an edit between rollback classification and actual Page restoration", async () => {
  const f = await makeNormalizedLocalFixture({ secondPage: true });
  f.vault.failAfterOperations = 2;
  await expect(f.local.apply(f.journal, f.target)).rejects.toThrow();
  f.vault.failAfterOperations = null;
  let reads = 0;
  f.vault.onRead = (path) => {
    if (path !== "Wiki/pages/note.md" || ++reads !== 2) return;
    f.vault.onRead = undefined;
    f.vault.seedMarkdown(path, "edit after rollback classification");
  };
  await expect(rebuild(f).rollbackUncommitted(f.journal)).rejects.toThrow(
    "AMBIGUOUS",
  );
  expect(f.vault.text("Wiki/pages/note.md")).toBe(
    "edit after rollback classification",
  );
  expect(
    (
      await new TreeTransaction(
        f.vault,
        f.control,
        paths(f).localRoot,
      ).inspect()
    )?.state,
  ).toBe("ambiguous");
  expect((await f.baseline.inspectJournal())?.transactionId).toBe(
    "source-pull",
  );
  await expect(rebuild(f).assertComplete(f.journal)).rejects.toThrow();
});

it("writes canonical bytes before claiming local completion", async () => {
  const f = await makeNormalizedLocalFixture();
  await f.local.apply(f.journal, f.target);
  const bytes = await f.vault.read("Wiki/pages/note.md");
  expect(new TextDecoder().decode(bytes!)).toBe("![A](../assets/photo.png)");
  await expect(f.local.assertComplete(f.journal)).resolves.toBeUndefined();
  expect(await f.baseline.inspectJournal()).toEqual({
    transactionId: "tx-1",
    kind: "push",
    phase: "committed",
  });
  const identities = (await f.identities.read())!.payload;
  expect(identities).toMatchObject({
    schemaVersion: 2,
    attachments: { "image-1": { active: true, path: "assets/photo.png" } },
  });
  expect(f.journal.identities.attachments).toEqual({});
});

it("freezes actual identity after-state before the first Vault CAS", async () => {
  const f = await makeNormalizedLocalFixture();
  const original = f.vault.compareAndSwap.bind(f.vault);
  let writes = 0;
  f.vault.compareAndSwap = async (...args) => {
    const binding = await new MutableControlRepository(
      f.control,
      paths(f).controlAfterBindingPath,
      isNormalizedPushLocalBinding,
    ).read();
    const after = await new MutableControlRepository(
      f.control,
      paths(f).controlAfterPath,
      isV3PullControlAfterState,
    ).read();
    expect(binding?.payload).toMatchObject({
      operationId: "op-1",
      transactionId: "tx-1",
      targetRevision: "rev-1",
      localPlanHash: f.journal.localPlanHash,
    });
    expect(after?.payload).toMatchObject({
      phase: "pending",
      identities: { attachments: { "image-1": { active: true } } },
    });
    expect(binding?.payload.identitiesHash).toBe(
      await sha256Hex(canonicalBytes(after!.payload.identities)),
    );
    writes++;
    return original(...args);
  };
  await f.local.apply(f.journal, f.target);
  expect(writes).toBe(1);
});

for (const body of ["late edit", "![A](../assets/photo.png)"]) {
  it(`retains pre-prepare edits without adopting coincident canonical bytes: ${body}`, async () => {
    const f = await makeNormalizedLocalFixture();
    f.vault.seedMarkdown("Wiki/pages/note.md", body);
    await expect(f.local.apply(f.journal, f.target)).rejects.toThrow(
      "STALE_PULL_PREVIEW",
    );
    expect(f.vault.text("Wiki/pages/note.md")).toBe(body);
    expect((await f.baseline.inspectJournal())?.transactionId).toBe(
      "source-pull",
    );
    expect(await f.control.read(paths(f).completionPath)).toBeNull();
    await expect(rebuild(f).assertComplete(f.journal)).rejects.toThrow();
  });
}

// Interrupt real persistence, before/after each semantic durability boundary.
// Rebuild the committer on the same ports, leaving real transaction/baseline engines intact.
const boundaries = [
  ["tree prepared", "/local/journal.json.next", "state", "prepared"],
  ["binding", "/control-after-binding.json.next", "schemaVersion", 1],
  ["control after pending", "/control-after.json.next", "phase", "pending"],
  ["first page written", "/local/journal.json.next", "nextOperation", 1],
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
  ["identities written", "/tree-identities.json.next", "schemaVersion", 2],
  ["control after applied", "/control-after.json.next", "phase", "applied"],
  ["tree committed", "/local/journal.json.next", "state", "committed"],
  ["completion", "/completion.json.next", "transactionId", "tx-1"],
] as const;

for (const [label, suffix, key, expected] of boundaries)
  for (const moment of ["before", "after"] as const) {
    it(`recovers ${moment} ${label} from durable ports`, async () => {
      const f = await makeNormalizedLocalFixture();
      const original = f.control.write.bind(f.control);
      let interrupted = false;
      f.control.write = async (path, value) => {
        const payload = path.endsWith(suffix)
          ? (JSON.parse(value) as { payload?: Record<string, unknown> }).payload
          : undefined;
        const matches =
          !interrupted && path.endsWith(suffix) && payload?.[key] === expected;
        if (matches) interrupted = true;
        if (matches && moment === "before")
          throw new Error("checkpoint failure");
        await original(path, value);
        if (matches && moment === "after")
          throw new Error("checkpoint failure");
      };
      await expect(f.local.apply(f.journal, f.target)).rejects.toThrow(
        "checkpoint failure",
      );
      expect(interrupted).toBe(true);
      f.control.write = original;
      const result = await rebuild(f).recover(f.journal, f.target);
      expect(result).toMatchObject({
        transactionId: "tx-1",
        targetRevision: "rev-1",
        localPlanHash: f.journal.localPlanHash,
      });
      expect(f.vault.text("Wiki/pages/note.md")).toBe(
        "![A](../assets/photo.png)",
      );
      expect((await f.baseline.inspectJournal())?.phase).toBe("committed");
      await rebuild(f).assertComplete(f.journal);
      const operationCount = f.vault.operations;
      await rebuild(f).recover(f.journal, f.target);
      expect(f.vault.operations).toBe(operationCount);
    });
  }

it("leaves third-party edits ambiguous when rollback cannot prove ownership", async () => {
  const f = await makeNormalizedLocalFixture();
  f.control.onTextWrite = (path) => {
    const raw = f.control.files.get(path);
    if (
      path.endsWith("/local/journal.json.next") &&
      raw &&
      (JSON.parse(raw) as { payload: { nextOperation: number } }).payload
        .nextOperation === 1
    ) {
      f.control.onTextWrite = undefined;
      f.vault.seedMarkdown("Wiki/pages/note.md", "third party");
      throw new Error("crash after write");
    }
  };
  await expect(f.local.apply(f.journal, f.target)).rejects.toThrow(
    "crash after write",
  );
  await expect(rebuild(f).recover(f.journal, f.target)).rejects.toThrow(
    "AMBIGUOUS",
  );
  expect(f.vault.text("Wiki/pages/note.md")).toBe("third party");
  expect((await f.baseline.inspectJournal())?.transactionId).toBe(
    "source-pull",
  );
  const tx = new TreeTransaction(f.vault, f.control, paths(f).localRoot);
  expect((await tx.inspect())?.state).toBe("ambiguous");
});

it("commits the fixed remote publication with an ordinary push baseline", async () => {
  const f = await makeNormalizedLocalFixture({ remotePush: true });
  const result = await f.local.apply(f.journal, f.target);
  expect(result.targetRevision).toBe("rev-2");
  expect((await f.baseline.read()).baseRevision).toBe("rev-2");
  expect(f.vault.text("Wiki/pages/note.md")).toBe("![A](../assets/photo.png)");
  await rebuild(f).assertComplete(f.journal);
});

it("leaves unrelated page edits pending after committing only normalized pages", async () => {
  const f = await makeNormalizedLocalFixture({ otherPage: true });
  f.vault.seedMarkdown("Wiki/pages/other.md", "late unrelated edit");
  await f.local.apply(f.journal, f.target);
  expect(f.vault.text("Wiki/pages/other.md")).toBe("late unrelated edit");
  expect(f.vault.operationLog).toEqual(["cas:Wiki/pages/note.md"]);
  const identities = (await f.identities.read())!.payload;
  const caps = await new FakeTreeRemoteV3().capabilities();
  const scan = await scanLocalTree(f.vault, "Wiki", f.target, identities, {
    ...caps,
    maxFolders: caps.maxClientSpaceFolders,
    maxPages: caps.maxClientSpacePages,
  });
  expect(scan.pages.find((p) => p.pageId === "other")?.body).toBe(
    "late unrelated edit",
  );
  expect(scan.pages.find((p) => p.pageId === "other")?.contentHash).not.toBe(
    f.target.pages.find((p) => p.pageId === "other")?.contentHash,
  );
});

for (const count of [1, 2])
  it(`replays original two-page transaction after vault failure at operation ${count}`, async () => {
    const f = await makeNormalizedLocalFixture({ secondPage: true });
    f.vault.failAfterOperations = count;
    await expect(f.local.apply(f.journal, f.target)).rejects.toThrow(
      "injected vault failure",
    );
    expect((await f.baseline.inspectJournal())?.transactionId).toBe(
      "source-pull",
    );
    f.vault.failAfterOperations = null;
    await rebuild(f).recover(f.journal, f.target);
    for (const path of ["Wiki/pages/note.md", "Wiki/pages/second.md"])
      expect(f.vault.text(path)).toBe("![A](../assets/photo.png)");
    await rebuild(f).assertComplete(f.journal);
  });

it("rolls back its partial write for safe local-only cancellation", async () => {
  const f = await makeNormalizedLocalFixture({ secondPage: true });
  f.vault.failAfterOperations = 2;
  await expect(f.local.apply(f.journal, f.target)).rejects.toThrow(
    "injected vault failure",
  );
  expect(f.vault.text("Wiki/pages/note.md")).toBe("![A](../assets/photo.png)");
  expect(f.vault.text("Wiki/pages/second.md")).toBe("![A](photo.png)");
  f.vault.failAfterOperations = null;
  await rebuild(f).rollbackUncommitted(f.journal);
  expect(f.vault.text("Wiki/pages/note.md")).toBe("![A](photo.png)");
  const tx = new TreeTransaction(f.vault, f.control, paths(f).localRoot);
  expect((await tx.inspect())?.state).toBe("rolled_back");
  expect((await f.baseline.inspectJournal())?.transactionId).toBe(
    "source-pull",
  );
  expect((await f.identities.read())?.payload).toEqual(f.journal.identities);
  const saved = new Map(f.control.files);
  await rebuild(f).rollbackUncommitted(f.journal);
  expect(f.control.files).toEqual(saved);
  await f.repository.write({ ...f.journal, phase: "superseded" });
  expect((await f.repository.read())?.verifiedTarget).toEqual(
    f.journal.verifiedTarget,
  );
});

it("rejects a lower companion candidate with a different frozen identity hash before write", async () => {
  const f = await makeNormalizedLocalFixture();
  f.control.failNextTextWriteAt = `${paths(f).controlAfterPath}.next`;
  await expect(f.local.apply(f.journal, f.target)).rejects.toThrow(
    "injected text write failure",
  );
  const binding = (await new MutableControlRepository(
    f.control,
    paths(f).controlAfterBindingPath,
    isNormalizedPushLocalBinding,
  ).read())!.payload;
  await f.control.write(
    paths(f).controlAfterBindingPath,
    await envelopeFor(binding, 2),
  );
  await f.control.write(
    `${paths(f).controlAfterBindingPath}.prev`,
    await envelopeFor({ ...binding, identitiesHash: "f".repeat(64) }, 1),
  );
  const saved = new Map(f.control.files);
  await expect(rebuild(f).recover(f.journal, f.target)).rejects.toThrow();
  expect(f.vault.text("Wiki/pages/note.md")).toBe("![A](photo.png)");
  expect(f.control.files).toEqual(saved);
});

it("keeps historical completion valid after real later Pull transactions prune its baseline", async () => {
  const f = await makeNormalizedLocalFixture();
  const completion = await f.local.apply(f.journal, f.target);
  const completed = { ...f.journal, phase: "complete" as const, completion };
  await f.repository.write(completed);
  await f.repository.cleanup(completed);
  const originalGeneration = (await f.baseline.read()).generationId;
  let source = f.target;
  for (let index = 2; index <= 5; index++) {
    const body = `later Pull ${index}\n![A](../assets/photo.png)`;
    const target = {
      ...source,
      revision: `rev-${index}`,
      pages: [
        { ...source.pages[0]!, body, contentHash: await contentHash(body) },
      ],
    };
    target.revisionContentHash = await f.baseline.revisionContentHashV3(target);
    const root = `${f.controlRoot}/later-pull-${index}`;
    await f.control.write(`${root}/page.md`, body);
    const tx = new TreeTransaction(f.vault, f.control, root);
    await tx.prepare(
      {
        baseRevision: source.revision,
        targetRevision: target.revision,
        targetTreeHash: target.revisionContentHash,
        deferCommit: true,
        actions: [
          {
            kind: "write_page",
            pageId: "page-1",
            path: "Wiki/pages/note.md",
            bodyPath: `${root}/page.md`,
          },
        ],
        expectedPathStates: {
          "Wiki/pages/note.md": {
            kind: "file",
            hash: await sha256Hex((await f.vault.read("Wiki/pages/note.md"))!),
          },
        },
      },
      `pull-${index}`,
    );
    const after = new MutableControlRepository(
      f.control,
      `${root}/control-after.json`,
      isV3PullControlAfterState,
    );
    await after.write({
      schemaVersion: 2,
      transactionId: `pull-${index}`,
      phase: "pending",
      identities: desiredV3Identities((await f.identities.read())!.payload, {
        revision: target.revision,
        base: source,
        remote: target,
        resolvedFolders: target.folders,
        resolvedPages: target.pages,
        resolvedAttachments: target.attachments,
      }),
    });
    await tx.apply();
    await tx.assertApplied();
    await tx.markVerified();
    await f.baseline.prepare(target, "pull", `pull-${index}`);
    await f.baseline.assertPreparedPull(target, `pull-${index}`);
    await f.baseline.setPhase("applying");
    await f.baseline.recover(`pull-${index}`);
    await applyV3ControlAfter(after, f.identities, `pull-${index}`);
    await tx.markCommitted();
    source = target;
  }
  expect((await f.baseline.read()).baseRevision).toBe("rev-5");
  expect(f.vault.text("Wiki/pages/note.md")).toBe(
    "later Pull 5\n![A](../assets/photo.png)",
  );
  expect(
    [...f.control.files.keys()].some((path) =>
      path.includes(`/generations/${originalGeneration}/`),
    ),
  ).toBe(false);
  f.vault.seedMarkdown("Wiki/pages/note.md", "new user edit after Pull");
  const operations = f.vault.operations;
  await rebuild(f).assertComplete(completed);
  await expect(rebuild(f).recover(completed, f.target)).resolves.toEqual(
    completion,
  );
  await f.repository.cleanup(completed);
  expect(f.vault.operations).toBe(operations);
  expect(f.vault.text("Wiki/pages/note.md")).toBe("new user edit after Pull");
});

it("rejects a fixed target with tampered unrelated body before touching the Vault", async () => {
  const f = await makeNormalizedLocalFixture({ otherPage: true });
  const changed = structuredClone(f.target);
  changed.pages.find((p) => p.pageId === "other")!.body = "tampered";
  await expect(f.local.apply(f.journal, changed)).rejects.toThrow();
  expect(f.vault.operations).toBe(0);
  expect((await f.baseline.inspectJournal())?.transactionId).toBe(
    "source-pull",
  );
});

for (const state of [
  "absent",
  "verified",
  "committed",
  "foreign",
  "baseline started",
  "control applied",
] as const)
  it(`refuses unsafe cancellation with ${state} evidence`, async () => {
    const f = await makeNormalizedLocalFixture();
    if (state === "committed") await f.local.apply(f.journal, f.target);
    else if (state !== "absent") {
      const stop =
        state === "verified" || state === "baseline started"
          ? `${f.controlRoot}/tree-v2/baseline-journal.json.next`
          : `${paths(f).controlAfterPath}.next`;
      f.control.failNextTextWriteAt = stop;
      await expect(f.local.apply(f.journal, f.target)).rejects.toThrow(
        "injected text write failure",
      );
      if (state === "foreign") {
        const root = `${paths(f).localRoot}/journal.json`;
        const value = JSON.parse((await f.control.read(root))!) as {
          payload: Record<string, unknown>;
        };
        await f.control.write(
          root,
          await envelopeFor({ ...value.payload, transactionId: "other-tx" }),
        );
      }
      if (state === "baseline started")
        await f.baseline.prepare(
          f.target,
          "push",
          f.journal.localTransactionId,
        );
      if (state === "control applied") {
        const binding = (await new MutableControlRepository(
          f.control,
          paths(f).controlAfterBindingPath,
          isNormalizedPushLocalBinding,
        ).read())!.payload;
        const desired = desiredV3Identities(f.journal.identities, {
          revision: "rev-1",
          base: f.target,
          remote: f.target,
          resolvedFolders: f.target.folders,
          resolvedPages: f.target.pages,
          resolvedAttachments: f.target.attachments,
        });
        expect(await sha256Hex(canonicalBytes(desired))).toBe(
          binding.identitiesHash,
        );
        await new MutableControlRepository(
          f.control,
          paths(f).controlAfterPath,
          isV3PullControlAfterState,
        ).write({
          schemaVersion: 2,
          transactionId: "tx-1",
          phase: "applied",
          identities: desired,
        });
      }
    }
    const saved = new Map(f.control.files);
    const body = f.vault.text("Wiki/pages/note.md");
    await expect(rebuild(f).rollbackUncommitted(f.journal)).rejects.toThrow();
    expect(f.control.files).toEqual(saved);
    expect(f.vault.text("Wiki/pages/note.md")).toBe(body);
  });

it("refuses cancellation that would erase a late edit during rollback", async () => {
  const f = await makeNormalizedLocalFixture({ secondPage: true });
  f.vault.failAfterOperations = 2;
  await expect(f.local.apply(f.journal, f.target)).rejects.toThrow();
  f.vault.failAfterOperations = null;
  f.vault.seedMarkdown("Wiki/pages/note.md", "third party after crash");
  await expect(rebuild(f).rollbackUncommitted(f.journal)).rejects.toThrow(
    "AMBIGUOUS",
  );
  expect(f.vault.text("Wiki/pages/note.md")).toBe("third party after crash");
  expect((await f.baseline.inspectJournal())?.transactionId).toBe(
    "source-pull",
  );
  await expect(rebuild(f).rollbackUncommitted(f.journal)).rejects.toThrow();
});

for (const name of ["binding", "control"] as const)
  it(`does not recreate missing ${name} after a verified write`, async () => {
    const f = await makeNormalizedLocalFixture();
    f.control.failNextTextWriteAt = `${f.controlRoot}/tree-v2/baseline-journal.json.next`;
    await expect(f.local.apply(f.journal, f.target)).rejects.toThrow();
    const path =
      name === "binding"
        ? paths(f).controlAfterBindingPath
        : paths(f).controlAfterPath;
    for (const suffix of ["", ".prev", ".next"])
      await f.control.remove(`${path}${suffix}`);
    const saved = new Map(f.control.files);
    await expect(rebuild(f).recover(f.journal, f.target)).rejects.toThrow();
    expect(f.control.files).toEqual(saved);
    expect((await f.baseline.inspectJournal())?.transactionId).toBe(
      "source-pull",
    );
  });

it("rejects changed operation/target and sidecars before recovery writes", async () => {
  const f = await makeNormalizedLocalFixture();
  f.control.failNextTextWriteAt = `${paths(f).controlAfterPath}.next`;
  await expect(f.local.apply(f.journal, f.target)).rejects.toThrow();
  for (const [journal, target] of [
    [{ ...f.journal, localTransactionId: "foreign" }, f.target],
    [f.journal, { ...f.target, revision: "rev-later" }],
    [f.journal, { ...f.target, revisionContentHash: "f".repeat(64) }],
  ] as const)
    await expect(rebuild(f).recover(journal, target)).rejects.toThrow();
  await f.control.write(f.journal.localPlan[0]!.payloadPath, "changed sidecar");
  await expect(rebuild(f).recover(f.journal, f.target)).rejects.toThrow();
  expect(f.vault.operations).toBe(0);
});

it("rejects malformed complete parent instead of borrowing existing completion", async () => {
  const f = await makeNormalizedLocalFixture();
  await f.local.apply(f.journal, f.target);
  await expect(
    rebuild(f).assertComplete({
      ...f.journal,
      phase: "complete",
      completion: null,
    }),
  ).rejects.toThrow();
});

it("rejects a committed journal whose operation cursor is not complete", async () => {
  const f = await makeNormalizedLocalFixture();
  await f.local.apply(f.journal, f.target);
  const path = `${paths(f).localRoot}/journal.json`;
  const saved = JSON.parse((await f.control.read(path))!) as {
    payload: Record<string, unknown>;
    writeGeneration: number;
  };
  await f.control.write(
    path,
    await envelopeFor(
      { ...saved.payload, nextOperation: 0 },
      saved.writeGeneration + 1,
    ),
  );
  await expect(rebuild(f).assertComplete(f.journal)).rejects.toThrow();
});

for (const index of [1, 2])
  it(`recovers a crash after actual page ${index} write in a two-page transaction`, async () => {
    const f = await makeNormalizedLocalFixture({ secondPage: true });
    const original = f.vault.compareAndSwap.bind(f.vault);
    let count = 0;
    f.vault.compareAndSwap = async (...args) => {
      const result = await original(...args);
      if (++count === index) throw new Error("crash after actual write");
      return result;
    };
    await expect(f.local.apply(f.journal, f.target)).rejects.toThrow(
      "crash after actual write",
    );
    f.vault.compareAndSwap = original;
    await rebuild(f).recover(f.journal, f.target);
    expect(f.vault.text("Wiki/pages/note.md")).toBe(
      "![A](../assets/photo.png)",
    );
    expect(f.vault.text("Wiki/pages/second.md")).toBe(
      "![A](../assets/photo.png)",
    );
    await rebuild(f).assertComplete(f.journal);
  });

for (const writeNumber of [1, 2])
  for (const moment of ["before", "after"] as const)
    it(`recovers ${moment} identity activation/desired write ${writeNumber}`, async () => {
      const f = await makeNormalizedLocalFixture();
      const identityPath = `${f.controlRoot}/tree-identities.json`;
      for (const suffix of ["", ".prev", ".next"])
        await f.control.remove(`${identityPath}${suffix}`);
      await f.identities.write(emptyTreeIdentityState());
      const original = f.control.write.bind(f.control);
      let count = 0;
      f.control.write = async (path, value) => {
        const stop = path === `${identityPath}.next` && ++count === writeNumber;
        if (stop && moment === "before") throw new Error("identity checkpoint");
        await original(path, value);
        if (stop && moment === "after") throw new Error("identity checkpoint");
      };
      await expect(f.local.apply(f.journal, f.target)).rejects.toThrow(
        "identity checkpoint",
      );
      f.control.write = original;
      expect((await f.baseline.inspectJournal())?.phase).toBe("committed");
      await rebuild(f).recover(f.journal, f.target);
      expect((await f.identities.read())?.payload).toMatchObject({
        schemaVersion: 2,
        attachments: { "image-1": { active: true } },
      });
      await rebuild(f).assertComplete(f.journal);
    });
