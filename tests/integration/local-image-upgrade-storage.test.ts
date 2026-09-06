import { TREE_SYNC_V3_HARD_LIMITS } from "@neomei/agentwiki-sync-protocol";
import { describe, expect, it } from "vitest";

import {
  isTreePushJournalV3,
  type TreePushJournalV3,
} from "../../src/application/tree-push-service-v3";
import {
  isTreeTransactionJournal,
  type TreeTransactionJournal,
} from "../../src/application/tree-transaction";
import { canonicalBytes, sha256Hex } from "../../src/agentwiki/protocol";
import type { ControlStorePort } from "../../src/ports/control-store";
import { MutableControlRepository } from "../../src/storage/envelope";
import {
  inspectLocalImageUpgrade,
  LocalImageUpgradeRepository,
  UpgradeIntentSchema,
  type UpgradeBinding,
  type UpgradeIntent,
} from "../../src/storage/local-image-upgrade";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { V3_CAPABILITIES } from "../fakes/fake-tree-remote";

const ROOT = ".agentwiki/devices/d-device/spaces/s-space";
const OPERATION_ID = "upgrade-operation";
const OPERATION_ROOT = `${ROOT}/local-image-upgrade/${OPERATION_ID}`;
const JOURNAL = `${ROOT}/local-image-upgrade/journal.json`;
const LOCAL_JOURNAL = `${OPERATION_ROOT}/local/journal.json`;
const HASHES = {
  source: "1".repeat(64),
  baseline: "2".repeat(64),
  projected: "3".repeat(64),
  capabilities: "4".repeat(64),
  confirmation: "5".repeat(64),
  candidate: "6".repeat(64),
  plan: "7".repeat(64),
  authorization: "8".repeat(64),
};

const binding: UpgradeBinding = {
  operationId: OPERATION_ID,
  serverInstanceId: "server-instance",
  spaceId: "space",
  deviceId: "device",
  credentialId: "credential",
  mappingRootKey: "mapping-root",
};

function makeIntent(overrides: Partial<UpgradeIntent> = {}): UpgradeIntent {
  return {
    schemaVersion: 1,
    binding: { ...binding },
    sourceRevision: "source-revision",
    sourceV2RevisionHash: HASHES.source,
    oldBaselineEvidenceHash: HASHES.baseline,
    projectedV3BaseHash: HASHES.projected,
    capabilitiesHash: HASHES.capabilities,
    confirmationHash: HASHES.confirmation,
    candidateHash: HASHES.candidate,
    localPlanHash: HASHES.plan,
    authorizationHash: HASHES.authorization,
    payloadPaths: [`${OPERATION_ROOT}/payload/page.md`],
    pushOperationId: OPERATION_ID,
    localTransactionId: "local-transaction",
    phase: "confirmed",
    verifiedPublication: null,
    ...overrides,
  };
}

async function envelope(
  payload: unknown,
  writeGeneration = 1,
): Promise<string> {
  return JSON.stringify({
    envelopeSchemaVersion: 1,
    writeGeneration,
    payloadHash: await sha256Hex(canonicalBytes(payload)),
    payload,
  });
}

function repository(store: ControlStorePort, owned = binding) {
  return new LocalImageUpgradeRepository(store, ROOT, owned);
}

async function forceIntent(
  store: ControlStorePort,
  intent: UpgradeIntent,
): Promise<void> {
  await new MutableControlRepository(
    store,
    JOURNAL,
    (value): value is UpgradeIntent =>
      UpgradeIntentSchema.safeParse(value).success,
  ).write(intent);
}

describe("LocalImageUpgradeRepository strict ownership", () => {
  it("round-trips a strict intent through the real control store and inspects it without an operation id", async () => {
    const store = new MemoryControlStore();
    const intent = makeIntent();

    await repository(store).write(intent);

    expect(
      await new LocalImageUpgradeRepository(store, ROOT, binding).read(),
    ).toEqual(intent);
    const { operationId: _operationId, ...inspectionBinding } = binding;
    expect(
      await inspectLocalImageUpgrade(store, ROOT, inspectionBinding),
    ).toEqual(intent);
  });

  it("preserves a portable Unicode mapping-root identity", async () => {
    const store = new MemoryControlStore();
    const unicodeBinding = {
      ...binding,
      mappingRootKey: "\u77e5\u8bc6\u5e93/\u9879\u76ee",
    };
    const intent = makeIntent({ binding: unicodeBinding });

    await repository(store, unicodeBinding).write(intent);

    expect(await repository(store, unicodeBinding).read()).toEqual(intent);
  });

  it.each([
    ["server", { ...binding, serverInstanceId: "other-server" }],
    ["Space", { ...binding, spaceId: "other-space" }],
    ["device", { ...binding, deviceId: "other-device" }],
    ["credential", { ...binding, credentialId: "other-credential" }],
    ["mapping root", { ...binding, mappingRootKey: "other-root" }],
  ])("fails closed for a mismatched %s binding", async (_name, wrong) => {
    const store = new MemoryControlStore();
    await repository(store).write(makeIntent());

    await expect(repository(store, wrong).read()).rejects.toThrow(/binding/i);
  });

  it("rejects extra fields, future versions, and parent-child operation mismatches", async () => {
    const store = new MemoryControlStore();
    const forbiddenFields = [
      { body: "raw markdown" },
      { authorization: "Bearer secret" },
      { signedUrl: "https://example.invalid/signed" },
      { blob: [137, 80, 78, 71] },
    ];
    const future = {
      ...makeIntent(),
      schemaVersion: 2,
    } as unknown as UpgradeIntent;
    const wrongChild = { ...makeIntent(), pushOperationId: "other-operation" };

    for (const fields of forbiddenFields)
      await expect(
        repository(store).write({
          ...makeIntent(),
          ...fields,
        }),
      ).rejects.toThrow();
    await expect(
      repository(store).write({
        ...makeIntent(),
        binding: { ...binding, token: "secret" },
      } as UpgradeIntent),
    ).rejects.toThrow();
    await expect(
      repository(store).write({
        ...makeIntent({
          phase: "complete",
          verifiedPublication: {
            revision: "published-revision",
            revisionContentHash: HASHES.candidate,
            receipt: "copied remote result",
          } as UpgradeIntent["verifiedPublication"],
        }),
      }),
    ).rejects.toThrow();
    await expect(repository(store).write(future)).rejects.toThrow();
    await expect(repository(store).write(wrongChild)).rejects.toThrow(
      /operation/i,
    );
    expect(await store.read(JOURNAL)).toBeNull();
  });

  it.each([
    "/Users/example/Vault/page.md",
    "../other/body.md",
    `${OPERATION_ROOT}\\payload\\page.md`,
    `${ROOT}/local-image-upgrade/other-operation/payload/page.md`,
    `${OPERATION_ROOT}/push/journal.json`,
    `${OPERATION_ROOT}/local/journal.json`,
  ])("rejects an unowned payload path: %s", async (path) => {
    const store = new MemoryControlStore();
    const unrelatedPath = `${ROOT}/local-image-upgrade/other-operation/payload/keep.md`;
    await store.write(unrelatedPath, "unrelated contents");

    await expect(
      repository(store).write(makeIntent({ payloadPaths: [path] })),
    ).rejects.toThrow(/payload/i);
    expect(await store.read(unrelatedPath)).toBe("unrelated contents");
  });

  it("refuses a second operation while the current Space operation is pending", async () => {
    const store = new MemoryControlStore();
    const current = makeIntent();
    await repository(store).write(current);
    await writePushJournal(store, current, {
      remoteState: "uploading_changes",
      result: null,
      localCommitPhase: "not_started",
    });
    await repository(store).write(makeIntent({ phase: "remote_pending" }));
    const nextBinding = { ...binding, operationId: "next-operation" };
    const nextIntent = makeIntent({
      binding: nextBinding,
      pushOperationId: nextBinding.operationId,
      payloadPaths: [
        `${ROOT}/local-image-upgrade/${nextBinding.operationId}/payload/page.md`,
      ],
    });

    await expect(
      repository(store, nextBinding).write(nextIntent),
    ).rejects.toThrow(/pending|operation/i);
    expect((await repository(store).read())?.binding.operationId).toBe(
      OPERATION_ID,
    );
  });

  it("serializes competing first writes so only one pending operation wins", async () => {
    const store = new MemoryControlStore();
    const otherBinding = { ...binding, operationId: "other-operation" };
    const otherIntent = makeIntent({
      binding: otherBinding,
      pushOperationId: otherBinding.operationId,
      payloadPaths: [
        `${ROOT}/local-image-upgrade/${otherBinding.operationId}/payload/page.md`,
      ],
    });

    const results = await Promise.allSettled([
      repository(store).write(makeIntent()),
      repository(store, otherBinding).write(otherIntent),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  it("does not adopt an orphan child journal as a first remote-pending parent", async () => {
    const store = new MemoryControlStore();
    const intent = makeIntent({ phase: "remote_pending" });
    await writePushJournal(store, intent, {
      remoteState: "uploading_changes",
      result: null,
      localCommitPhase: "not_started",
    });

    await expect(repository(store).write(intent)).rejects.toThrow(
      /start confirmed/i,
    );
    expect(await store.read(JOURNAL)).toBeNull();
  });

  it("fails closed instead of using an older valid candidate over a corrupt or future higher generation", async () => {
    const store = new MemoryControlStore();
    const valid = makeIntent();
    await store.write(`${JOURNAL}.prev`, await envelope(valid, 1));
    await store.write(
      JOURNAL,
      await envelope({ ...valid, schemaVersion: 2 }, 2),
    );

    await expect(repository(store).read()).rejects.toThrow(
      /future|payload|version|\u672a\u77e5|\u7248\u672c/i,
    );

    const damaged = JSON.parse((await store.read(JOURNAL))!) as {
      payloadHash: string;
    };
    damaged.payloadHash = "0".repeat(64);
    await store.write(JOURNAL, JSON.stringify(damaged));
    await expect(repository(store).read()).rejects.toThrow();

    await store.write(JOURNAL, "{broken");
    await expect(repository(store).read()).rejects.toThrow(/corrupt/i);
  });
});

class BoundaryFailureStore extends MemoryControlStore {
  private mutationIndex = 0;
  constructor(private readonly failAfterMutation: number) {
    super();
  }
  private boundary(): void {
    this.mutationIndex += 1;
    if (this.mutationIndex === this.failAfterMutation)
      throw new Error(`power loss after mutation ${this.mutationIndex}`);
  }
  override async write(path: string, value: string): Promise<void> {
    await super.write(path, value);
    this.boundary();
  }
  override async rename(from: string, to: string): Promise<void> {
    await super.rename(from, to);
    this.boundary();
  }
  armAfterExistingState(): void {
    this.mutationIndex = 0;
  }
}

describe("LocalImageUpgradeRepository envelope recovery", () => {
  it.each([1, 2, 3])(
    "rebuilds after interruption at envelope write/rename boundary %s",
    async (boundary) => {
      const store = new BoundaryFailureStore(Number.MAX_SAFE_INTEGER);
      const intent = makeIntent();
      await repository(store).write(intent);
      await writePushJournal(store, intent, {
        remoteState: "uploading_changes",
        result: null,
        localCommitPhase: "not_started",
      });
      store.armAfterExistingState();
      Object.assign(store, { failAfterMutation: boundary });
      const updated = makeIntent({ phase: "remote_pending" });

      await expect(repository(store).write(updated)).rejects.toThrow(
        /power loss/,
      );

      expect(await repository(store).read()).toEqual(updated);
    },
  );
});

async function writePushJournal(
  store: ControlStorePort,
  intent: UpgradeIntent,
  overrides: Partial<TreePushJournalV3> = {},
): Promise<void> {
  const result = {
    protocolVersion: "3" as const,
    status: "published" as const,
    revision: "published-revision",
    sequence: 2,
    revisionContentHash: intent.candidateHash,
    folderCount: "0",
    pageCount: "1",
    attachmentCount: "1",
    revisionManifestByteLength: "1",
    revisionBodyBytes: "1",
    revisionAttachmentBytes: "1",
    publishedAt: "2026-09-06T00:00:00.000Z",
    changeSetId: null,
  };
  const journal: TreePushJournalV3 = {
    schemaVersion: 3,
    protocolVersion: "3",
    spaceId: intent.binding.spaceId,
    baseRevision: intent.sourceRevision,
    idempotencyKey: intent.pushOperationId,
    confirmationHash: intent.confirmationHash,
    capabilitiesHash: intent.capabilitiesHash,
    capabilities: {
      ...V3_CAPABILITIES,
      ...TREE_SYNC_V3_HARD_LIMITS,
    },
    changes: [],
    requiredBlobs: {},
    blobRequirements: [],
    totalBodyBytes: 0,
    attachmentCount: 0,
    transferBlobBytes: 0,
    sessionId: "session",
    credentialIdAtCreation: intent.binding.credentialId,
    remoteState: "published",
    result,
    localCommitPhase: "verified",
    ...overrides,
  };
  await new MutableControlRepository(
    store,
    `${OPERATION_ROOT}/push/journal.json`,
    isTreePushJournalV3,
  ).write(journal);
}

async function writeLocalJournal(
  store: ControlStorePort,
  intent: UpgradeIntent,
  overrides: Partial<TreeTransactionJournal> = {},
): Promise<void> {
  const journal: TreeTransactionJournal = {
    schemaVersion: 3,
    transactionId: intent.localTransactionId,
    baseRevision: intent.sourceRevision,
    targetRevision:
      intent.verifiedPublication?.revision ?? "published-revision",
    targetTreeHash:
      intent.verifiedPublication?.revisionContentHash ?? intent.candidateHash,
    state: "committed",
    nextOperation: 0,
    operations: [],
    deferCommit: true,
    ...overrides,
  };
  await new MutableControlRepository(
    store,
    `${OPERATION_ROOT}/local/journal.json`,
    isTreeTransactionJournal,
  ).write(journal);
}

async function forceSupersededIntent(
  store: ControlStorePort,
  intent = makeIntent({ phase: "superseded" }),
): Promise<UpgradeIntent> {
  await writePushJournal(store, intent, {
    remoteState: "superseded",
    result: null,
    sessionId: null,
    localCommitPhase: "not_started",
  });
  await forceIntent(store, intent);
  return intent;
}

const LOCAL_TRANSACTION_STATES = [
  "prepared",
  "applying",
  "applied",
  "verified",
  "committed",
  "rolling_back",
  "rolled_back",
  "ambiguous",
] as const satisfies readonly TreeTransactionJournal["state"][];

describe("LocalImageUpgradeRepository superseded local-child exclusion", () => {
  it.each(LOCAL_TRANSACTION_STATES)(
    "fails closed on read when a superseded intent has a %s local child",
    async (state) => {
      const store = new MemoryControlStore();
      const intent = makeIntent({ phase: "superseded" });
      await writeLocalJournal(store, intent, { state });
      await forceSupersededIntent(store, intent);

      await expect(repository(store).read()).rejects.toThrow(
        /local|transaction/i,
      );
      expect(await store.read(LOCAL_JOURNAL)).not.toBeNull();
    },
  );

  it.each([
    [
      "corrupt",
      async (store: ControlStorePort) => store.write(LOCAL_JOURNAL, "{broken"),
    ],
    [
      "misowned",
      async (store: ControlStorePort, intent: UpgradeIntent) =>
        writeLocalJournal(store, intent, {
          state: "rolled_back",
          transactionId: "other-transaction",
          baseRevision: "other-base",
          targetRevision: "other-target",
          targetTreeHash: "9".repeat(64),
        }),
    ],
  ])(
    "fails closed on read when a superseded intent has a %s local child",
    async (_name, writeChild) => {
      const store = new MemoryControlStore();
      const intent = makeIntent({ phase: "superseded" });
      await writeChild(store, intent);
      await forceSupersededIntent(store, intent);

      await expect(repository(store).read()).rejects.toThrow();
      expect(await store.read(LOCAL_JOURNAL)).not.toBeNull();
    },
  );

  it("blocks a superseded write when any local child is present", async () => {
    const store = new MemoryControlStore();
    const intent = makeIntent({ phase: "superseded" });
    await repository(store).write(makeIntent());
    await writePushJournal(store, intent, {
      remoteState: "superseded",
      result: null,
      sessionId: null,
      localCommitPhase: "not_started",
    });
    await writeLocalJournal(store, intent, { state: "rolled_back" });

    await expect(repository(store).write(intent)).rejects.toThrow(
      /local|transaction/i,
    );
    expect((await repository(store).read())?.phase).toBe("confirmed");
  });

  it("blocks replacement while a superseded operation has any local child", async () => {
    const store = new MemoryControlStore();
    const intent = await forceSupersededIntent(store);
    await writeLocalJournal(store, intent, { state: "rolled_back" });
    const nextBinding = { ...binding, operationId: "next-operation" };
    const nextIntent = makeIntent({
      binding: nextBinding,
      pushOperationId: nextBinding.operationId,
      payloadPaths: [
        `${ROOT}/local-image-upgrade/${nextBinding.operationId}/payload/page.md`,
      ],
    });

    await expect(
      repository(store, nextBinding).write(nextIntent),
    ).rejects.toThrow(/local|transaction/i);
    expect(await store.read(LOCAL_JOURNAL)).not.toBeNull();
    await store.remove(LOCAL_JOURNAL);
    expect((await repository(store).read())?.binding.operationId).toBe(
      OPERATION_ID,
    );
  });

  it("blocks cleanup and preserves all evidence when any local child is present", async () => {
    const store = new MemoryControlStore();
    const intent = await forceSupersededIntent(store);
    await writeLocalJournal(store, intent, { state: "rolled_back" });
    await store.write(intent.payloadPaths[0]!, "private payload");

    await expect(repository(store).cleanupCompleted()).rejects.toThrow(
      /local|transaction/i,
    );
    expect(await store.read(intent.payloadPaths[0]!)).toBe("private payload");
    expect(await store.read(JOURNAL)).not.toBeNull();
    expect(await store.read(LOCAL_JOURNAL)).not.toBeNull();
  });
});

describe("LocalImageUpgradeRepository terminal cleanup", () => {
  it("removes only declared payloads after matching authoritative complete child journals", async () => {
    const store = new MemoryControlStore();
    const intent = makeIntent({
      phase: "complete",
      verifiedPublication: {
        revision: "published-revision",
        revisionContentHash: HASHES.candidate,
      },
    });
    await repository(store).write(makeIntent());
    await writePushJournal(store, intent);
    await repository(store).write({
      ...intent,
      phase: "remote_pending",
      verifiedPublication: null,
    });
    await repository(store).write({ ...intent, phase: "local_pending" });
    await writeLocalJournal(store, intent);
    await repository(store).write(intent);
    await store.write(intent.payloadPaths[0]!, "private payload");
    const undeclared = `${OPERATION_ROOT}/payload/keep.md`;
    await store.write(undeclared, "keep");

    await repository(store).cleanupCompleted();

    expect(await store.read(intent.payloadPaths[0]!)).toBeNull();
    expect(await store.read(undeclared)).toBe("keep");
    expect(await repository(store).read()).toEqual(intent);
    expect(
      await store.read(`${OPERATION_ROOT}/push/journal.json`),
    ).not.toBeNull();
    expect(
      await store.read(`${OPERATION_ROOT}/local/journal.json`),
    ).not.toBeNull();
  });

  it.each([
    [
      "pending parent",
      { phase: "remote_pending" as const },
      "pending-push",
      null,
    ],
    ["missing push", { phase: "complete" as const }, null, "local"],
    ["missing local", { phase: "complete" as const }, "push", null],
    ["wrong candidate", { phase: "complete" as const }, "wrong-push", "local"],
    ["noop result", { phase: "complete" as const }, "noop-push", "local"],
    ["pending local", { phase: "complete" as const }, "push", "pending-local"],
  ])(
    "preserves evidence when terminal cleanup is not authoritative: %s",
    async (_name, parent, pushState, localState) => {
      const store = new MemoryControlStore();
      const intent = makeIntent({
        ...parent,
        verifiedPublication:
          parent.phase === "complete"
            ? {
                revision: "published-revision",
                revisionContentHash: HASHES.candidate,
              }
            : null,
      });
      await store.write(intent.payloadPaths[0]!, "private payload");
      if (pushState)
        await writePushJournal(
          store,
          intent,
          pushState === "wrong-push" || pushState === "noop-push"
            ? {
                result: {
                  protocolVersion: "3",
                  status: pushState === "noop-push" ? "noop" : "published",
                  revision: "published-revision",
                  sequence: 2,
                  revisionContentHash:
                    pushState === "noop-push"
                      ? HASHES.candidate
                      : "9".repeat(64),
                  folderCount: "0",
                  pageCount: "1",
                  attachmentCount: "1",
                  revisionManifestByteLength: "1",
                  revisionBodyBytes: "1",
                  revisionAttachmentBytes: "1",
                  publishedAt: "2026-09-06T00:00:00.000Z",
                  changeSetId: null,
                },
              }
            : pushState === "pending-push"
              ? {
                  remoteState: "uploading_changes",
                  result: null,
                  localCommitPhase: "not_started",
                }
              : {},
        );
      if (localState)
        await writeLocalJournal(
          store,
          intent,
          localState === "pending-local" ? { state: "applying" } : {},
        );

      if (parent.phase === "complete") await forceIntent(store, intent);
      else {
        await repository(store).write(makeIntent());
        await repository(store).write(intent);
      }
      if (parent.phase === "complete") {
        await expect(repository(store).cleanupCompleted()).rejects.toThrow();
      } else await repository(store).cleanupCompleted();
      expect(await store.read(intent.payloadPaths[0]!)).toBe("private payload");
    },
  );

  it("allows authoritative superseded cleanup without a local child and rejects corrupt nested child evidence", async () => {
    const store = new MemoryControlStore();
    const intent = makeIntent({ phase: "superseded" });
    await repository(store).write(makeIntent());
    await writePushJournal(store, intent, {
      remoteState: "superseded",
      result: null,
      sessionId: null,
      localCommitPhase: "not_started",
    });
    await repository(store).write(intent);
    await store.write(intent.payloadPaths[0]!, "private payload");

    await repository(store).cleanupCompleted();
    expect(await store.read(intent.payloadPaths[0]!)).toBeNull();

    await store.write(intent.payloadPaths[0]!, "restored payload");
    const childPath = `${OPERATION_ROOT}/push/journal.json`;
    const child = JSON.parse((await store.read(childPath))!) as {
      payload: { capabilities: { allowedMimeTypes: string[] } };
      payloadHash: string;
    };
    child.payload.capabilities.allowedMimeTypes = ["text/plain"];
    child.payloadHash = await sha256Hex(canonicalBytes(child.payload));
    await store.write(childPath, JSON.stringify(child));

    await expect(repository(store).cleanupCompleted()).rejects.toThrow();
    expect(await store.read(intent.payloadPaths[0]!)).toBe("restored payload");
  });
});
