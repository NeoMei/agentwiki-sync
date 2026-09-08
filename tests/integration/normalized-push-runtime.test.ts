import { expect, it } from "vitest";
import { makeNormalizedRuntimeFixture } from "../fakes/normalized-push-fixture";
import type { TreeSnapshotSegmentV3 } from "../../src/ports/tree-remote";
import { TreeBaselineRepository } from "../../src/storage/tree-baseline";
import { contentHash } from "../../src/agentwiki/protocol";
import type { PushPreviewV3 } from "../../src/application/sync-runtime";
import type { NormalizedPushPlan } from "../../src/application/normalized-push-plan";
import attachmentConformance from "../fixtures/attachment-reference.conformance.json";

const RUNTIME_ROOT = ".agentwiki/devices/d-device-1/spaces/s-space-1";

it.each(
  attachmentConformance.filter((test) => test.name.startsWith("backtick-")),
)(
  "keeps the referenced image in actual Runtime scanning for $name",
  async ({ body }) => {
    const f = await makeNormalizedRuntimeFixture("local_only");
    f.vault.seedMarkdown("Wiki/pages/note.md", body);
    f.runtime.invalidate();
    f.vault.readPaths.length = 0;
    const preview = await f.runtime.previewPushV3();
    expect(preview.publishable).toBe(true);
    expect(preview.blockers).toEqual([]);
    expect(preview.changes.map((change) => change.operation)).toEqual([
      "upsert_page",
    ]);
    const pageChange = preview.changes.find(
      (change) => change.operation === "upsert_page",
    );
    if (pageChange?.operation !== "upsert_page")
      throw new Error("expected Page change");
    expect(pageChange.page.referencedAttachmentIds).toEqual([
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(f.vault.readPaths).toContain("Wiki/assets/photo.png");
    expect(f.vault.readPaths).not.toContain("Wiki/assets/hidden.png");
  },
);

function requireNormalizedPlan(preview: PushPreviewV3) {
  const plan = preview.normalizedPush?.plan;
  if (!plan) throw new Error("expected normalized Push plan");
  return structuredClone(plan);
}

function baselineFor(
  f: Awaited<ReturnType<typeof makeNormalizedRuntimeFixture>>,
) {
  return new TreeBaselineRepository(f.control, RUNTIME_ROOT, "space-1", "Wiki");
}

async function loseConfirmedParent(
  f: Awaited<ReturnType<typeof makeNormalizedRuntimeFixture>>,
  preview: PushPreviewV3,
) {
  const write = f.control.write.bind(f.control);
  let hit = false;
  f.control.write = async (path, value) => {
    await write(path, value);
    if (
      !hit &&
      path.endsWith("/push/journal.json.next") &&
      (JSON.parse(value) as { payload?: { phase?: string } }).payload?.phase ===
        "confirmed"
    ) {
      hit = true;
      throw new Error("durable confirmed return lost");
    }
  };
  await expect(f.runtime.applyPushV3(preview)).rejects.toThrow(
    "durable confirmed return lost",
  );
  f.control.write = write;
  expect(hit).toBe(true);
}

it("recovers durable confirmed local-only at its fixed revision after head advances, twice, before later Pull", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  f.runtime.invalidate();
  const preview = await f.runtime.previewPushV3();
  const plan = requireNormalizedPlan(preview);
  expect(plan.scanEpoch).toBeGreaterThan(0);
  const original: TreeSnapshotSegmentV3[] = [];
  for await (const segment of f.remote.snapshotPages(plan.sourceRevision))
    original.push(structuredClone(segment));
  await loseConfirmedParent(f, preview);
  const remoteBody = "new remote edit\n![A](../assets/photo.png)";
  const remoteHash = await contentHash(remoteBody);
  await f.remote.seedTree({
    spaceId: "space-1",
    revision: "rev-2",
    folders: original[0]!.folders,
    pages: original[0]!.pages.map((page) => ({
      ...page,
      body: remoteBody,
      contentHash: remoteHash,
    })),
    attachments: original[0]!.attachments,
    blobs: {
      "11111111-1111-4111-8111-111111111111": (await f.vault.read(
        "Wiki/assets/photo.png",
      ))!,
    },
  });
  const snapshots = f.remote.snapshotPages.bind(f.remote);
  f.remote.snapshotPages = async function* (revision) {
    if (revision === plan.sourceRevision) {
      for (const segment of original) yield structuredClone(segment);
      return;
    }
    yield* snapshots(revision);
  };
  expect((await f.remote.head()).revision).toBe("rev-2");
  for (let attempt = 0; attempt < 2; attempt++) await f.rebuild().recover();
  expect(await f.rebuild().inspectNormalizedPush()).toMatchObject({
    ...plan,
    phase: "complete",
    verifiedTarget: {
      revision: "rev-1",
      revisionContentHash: plan.candidateHash,
    },
  });
  expect(f.vault.text("Wiki/pages/note.md")).toBe("![A](../assets/photo.png)");
  expect((await baselineFor(f).read()).baseRevision).toBe("rev-1");
  expect(f.remote.createInputs).toEqual([]);
  expect(f.remote.uploadedBatches).toEqual([]);
  expect(f.remote.uploadedChunkIndexes).toEqual([]);
  expect(f.remote.finalizeCalls).toBe(0);
  const later = f.rebuild();
  await later.applyPullV3(await later.previewPullV3());
  expect(f.vault.text("Wiki/pages/note.md")).toBe(remoteBody);
  expect((await baselineFor(f).read()).baseRevision).toBe("rev-2");
});

it("rejects a forged confirmed-local-only mode without a durable journal even with a live preview", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  const preview = await f.runtime.previewPushV3();
  const plan = preview.normalizedPush!.plan;
  // Invoke the authority boundary directly: a mode flag is not durable authorization.
  const adapter = (
    f.runtime as unknown as {
      normalizedPush: {
        revalidate(plan: NormalizedPushPlan, mode: string): Promise<string>;
      };
    }
  ).normalizedPush;
  await expect(
    adapter.revalidate(plan, "confirmed_local_only"),
  ).rejects.toThrow("NORMALIZED_PUSH_RECOVERY_OWNERSHIP_MISMATCH");
  expect(f.vault.text("Wiki/pages/note.md")).toBe("![A](photo.png)");
  expect(await f.runtime.inspectNormalizedPush()).toBeNull();
  expect(f.remote.createInputs).toEqual([]);
});

it.each(["wrong operation", "wrong plan", "remote mode", "complete phase"])(
  "rejects confirmed-local-only recovery authority with %s",
  async (scenario) => {
    const f = await makeNormalizedRuntimeFixture(
      scenario === "remote mode" ? "remote_push" : "local_only",
    );
    const preview = await f.runtime.previewPushV3();
    const plan = requireNormalizedPlan(preview);
    if (scenario === "complete phase") await f.runtime.applyPushV3(preview);
    else await loseConfirmedParent(f, preview);
    if (scenario === "wrong operation")
      plan.binding.operationId = "00000000-0000-4000-8000-000000000099";
    if (scenario === "wrong plan") plan.scanEpoch++;
    const adapter = (
      f.rebuild() as unknown as {
        normalizedPush: {
          revalidate(plan: NormalizedPushPlan, mode: string): Promise<string>;
        };
      }
    ).normalizedPush;
    await expect(
      adapter.revalidate(plan, "confirmed_local_only"),
    ).rejects.toThrow(
      scenario === "wrong plan"
        ? "NORMALIZED_PUSH_AUTHORIZATION_CHANGED"
        : "NORMALIZED_PUSH_RECOVERY_OWNERSHIP_MISMATCH",
    );
    expect(f.remote.createInputs).toEqual([]);
    expect(f.remote.finalizeCalls).toBe(0);
  },
);

it("rechecks raw local bytes on durable confirmed local-only recovery", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  const preview = await f.runtime.previewPushV3();
  const plan = requireNormalizedPlan(preview);
  await loseConfirmedParent(f, preview);
  f.vault.seedMarkdown("Wiki/pages/note.md", "my late edit\n![A](photo.png)");
  await expect(f.rebuild().recover()).rejects.toThrow(
    "NORMALIZED_PUSH_AUTHORIZATION_CHANGED",
  );
  expect(f.vault.text("Wiki/pages/note.md")).toBe(
    "my late edit\n![A](photo.png)",
  );
  expect(await f.rebuild().inspectNormalizedPush()).toMatchObject({
    ...plan,
    phase: "confirmed",
  });
  expect((await baselineFor(f).read()).baseRevision).toBe("rev-1");
  expect(f.remote.createInputs).toEqual([]);
});

it.each(["local_only", "remote_push"] as const)(
  "retains the fresh confirmation head gate for %s",
  async (mode) => {
    const f = await makeNormalizedRuntimeFixture(mode);
    const preview = await f.runtime.previewPushV3();
    const head = await f.remote.head();
    f.remote.head = async () => ({ ...head, revision: "rev-2" });
    await expect(f.runtime.applyPushV3(preview)).rejects.toThrow("BASE_STALE");
    expect(await f.runtime.inspectNormalizedPush()).toBeNull();
    expect(f.remote.createInputs).toEqual([]);
    expect(f.vault.text("Wiki/pages/note.md")).toBe("![A](photo.png)");
  },
);

it("retains the remote-push confirmed recovery head gate before create", async () => {
  const f = await makeNormalizedRuntimeFixture("remote_push");
  const preview = await f.runtime.previewPushV3();
  await loseConfirmedParent(f, preview);
  const head = await f.remote.head();
  f.remote.head = async () => ({ ...head, revision: "rev-2" });
  await f.rebuild().recover();
  expect(await f.rebuild().inspectNormalizedPush()).toMatchObject({
    phase: "superseded",
  });
  expect(f.remote.createInputs).toEqual([]);
  expect(f.remote.finalizeCalls).toBe(0);
  expect(f.vault.text("Wiki/pages/note.md")).toBe("![A](photo.png)");
});

it.each(["after rename", "before atomic replacement", "no late edit"])(
  "preserves a moved normalized Pull Page edited %s and its old baseline",
  async (boundary) => {
    const f = await makeNormalizedRuntimeFixture("local_only");
    const segments: TreeSnapshotSegmentV3[] = [];
    for await (const segment of f.remote.snapshotPages("rev-1"))
      segments.push(segment);
    const current = segments[0]!;
    await f.remote.seedTree({
      spaceId: "space-1",
      revision: "rev-2",
      folders: current.folders,
      pages: current.pages.map((page) => ({ ...page, path: "pages/moved.md" })),
      attachments: current.attachments,
      blobs: {
        "11111111-1111-4111-8111-111111111111": (await f.vault.read(
          "Wiki/assets/photo.png",
        ))!,
      },
    });
    const preview = await f.runtime.previewPullV3();
    expect(preview.actions.map((action) => action.kind)).toEqual(["move_page"]);
    if (boundary === "no late edit") {
      await f.runtime.applyPullV3(preview);
      await f.rebuild().recover();
      expect(f.vault.text("Wiki/pages/moved.md")).toBe(
        "![A](../assets/photo.png)",
      );
      expect(f.vault.exists("Wiki/pages/note.md")).toBe(false);
      expect((await baselineFor(f).read()).baseRevision).toBe("rev-2");
      return;
    }
    let hit = false;
    if (boundary === "after rename") {
      f.vault.onRename = (_from, to) => {
        if (to === "Wiki/pages/moved.md") {
          hit = true;
          f.vault.seedMarkdown(to, "THIRD PARTY EDIT");
        }
      };
    } else {
      const cas = f.vault.compareAndSwap.bind(f.vault);
      f.vault.compareAndSwap = async (path, expected, replacement) => {
        if (path === "Wiki/pages/moved.md") {
          expect(new TextDecoder().decode(expected!)).toBe("![A](photo.png)");
          expect(await f.vault.read(path)).toEqual(expected);
          hit = true;
          f.vault.seedMarkdown(path, "THIRD PARTY EDIT");
        }
        return cas(path, expected, replacement);
      };
    }
    await expect(f.runtime.applyPullV3(preview)).rejects.toThrow(
      "TREE_TRANSACTION_AMBIGUOUS",
    );
    expect(hit).toBe(true);
    expect(f.vault.text("Wiki/pages/moved.md")).toBe("THIRD PARTY EDIT");
    expect((await baselineFor(f).read()).baseRevision).toBe("rev-1");
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(f.rebuild().recover()).rejects.toThrow(
        "TREE_TRANSACTION_AMBIGUOUS",
      );
    expect(f.vault.text("Wiki/pages/moved.md")).toBe("THIRD PARTY EDIT");
    expect((await baselineFor(f).read()).baseRevision).toBe("rev-1");
    expect(
      [...f.control.files.values()].some((value) =>
        value.includes('"state":"ambiguous"'),
      ),
    ).toBe(true);
  },
);

it("retains confirmed private payload when an invalidated authority closes its original preview", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  const preview = await f.runtime.previewPushV3();
  f.vault.compareAndSwap = async () => {
    throw new Error("interrupted actual CAS");
  };
  await expect(f.runtime.applyPushV3(preview)).rejects.toThrow();
  const before = new Map(f.control.files);
  expect(() =>
    f.runtime.configureNormalizedPush({
      serverOrigin: "https://example.test",
      serverInstanceId: "server-1",
      deviceId: "device-1",
      credentialId: "credential-1",
      vaultId: "different",
    }),
  ).toThrow();
  await expect(f.runtime.discardPushPreviewV3(preview)).rejects.toThrow();
  expect(f.control.files).toEqual(before);
});

it("uses actual v3 limits for the image probe and rejects metadata/read size drift", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  await expect(f.runtime.hasLocalImageCandidate()).resolves.toBe(true);
  f.vault.seedMarkdown("Wiki/pages/note.md", "text only");
  await expect(f.runtime.hasLocalImageCandidate()).resolves.toBe(false);
  const read = f.vault.read.bind(f.vault);
  f.vault.read = async (path) => {
    if (path === "Wiki/pages/note.md")
      f.vault.seedMarkdown(path, "longer text");
    return read(path);
  };
  await expect(f.runtime.hasLocalImageCandidate()).rejects.toThrow(
    "RAW_PAGE_SIZE_CHANGED",
  );
});

it("rejects invalid metadata in the actual Runtime image probe without reading the Page", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  const list = f.vault.listTree.bind(f.vault);
  f.vault.listTree = async function* (root, options) {
    for await (const entry of list(root, options))
      yield entry.kind === "markdown" ? { ...entry, byteLength: -1 } : entry;
  };
  f.vault.readPaths.length = 0;
  await expect(f.runtime.hasLocalImageCandidate()).rejects.toThrow(
    "INVALID_RAW_PAGE_SIZE",
  );
  expect(f.vault.readPaths).toEqual([]);
});

it("repairs and Pulls managed Pages without reading unrelated pages images", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  f.vault.seedFile("Wiki/pages/unmanaged.png", new Uint8Array([1, 2, 3]));
  f.vault.readPaths.length = 0;
  await f.runtime.applyPushV3(await f.runtime.previewPushV3());
  f.vault.seedMarkdown("Wiki/pages/note.md", "![A](photo.png)");
  await f.runtime.applyPullV3(await f.runtime.previewPullV3());
  expect(f.vault.text("Wiki/pages/note.md")).toBe("![A](../assets/photo.png)");
  expect(f.vault.readPaths).not.toContain("Wiki/pages/unmanaged.png");
});

it("rejects a real Pull directory destination occupied by an unmanaged image before reading it", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  const head = await f.remote.head();
  const segments: TreeSnapshotSegmentV3[] = [];
  for await (const segment of f.remote.snapshotPages(head.revision))
    segments.push(segment);
  const current = segments[0]!;
  await f.remote.seedTree({
    spaceId: current.spaceId,
    revision: "new-folder",
    pages: current.pages,
    attachments: current.attachments,
    folders: [
      {
        folderId: "44444444-4444-4444-8444-444444444444",
        parentFolderId: null,
        path: "pages/opaque.png",
        name: "opaque.png",
        sortOrder: 0,
        updatedAt: "2026-09-07T00:00:00.000Z",
      },
    ],
    blobs: {
      [current.attachments[0]!.attachmentId]: (await f.vault.read(
        "Wiki/assets/photo.png",
      ))!,
    },
  });
  f.vault.seedFile("Wiki/pages/opaque.png", new Uint8Array([1, 2, 3]));
  f.vault.readPaths.length = 0;
  f.vault.operationLog.length = 0;
  await expect(f.runtime.previewPullV3()).rejects.toThrow(
    "UNMANAGED_FILE_IN_DIRECTORY_ACTION",
  );
  expect(f.vault.readPaths).not.toContain("Wiki/pages/opaque.png");
  expect(f.vault.operationLog).toEqual([]);
});

it("does not read an unreferenced file when receiving a rename event", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  f.vault.seedFile("Wiki/pages/unused.png", new Uint8Array([1, 2, 3]));
  f.vault.readPaths.length = 0;
  await f.runtime.recordRename(
    "Wiki/pages/old-unused.png",
    "Wiki/pages/unused.png",
  );
  expect(f.vault.readPaths).toEqual([]);
});

it("applies raw quota before reading a moved Page through persisted rename hints", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  await f.vault.rename("Wiki/pages/note.md", "Wiki/pages/moved.md");
  await f.runtime.recordRename("Wiki/pages/note.md", "Wiki/pages/moved.md");
  const caps = await f.remote.capabilities();
  f.vault.seedMarkdown(
    "Wiki/pages/moved.md",
    "x".repeat(caps.maxPageBytes + 1),
  );
  f.vault.readPaths.length = 0;
  await expect(f.runtime.previewPushV3()).rejects.toThrow("SPACE_TOO_LARGE");
  expect(f.vault.readPaths).not.toContain("Wiki/pages/moved.md");
});

it("invalidates bound previews on authority rotation without upgrading incomplete or secret-bearing identities", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  const preview = await f.runtime.previewPushV3();
  const authority = {
    serverOrigin: "https://example.test",
    serverInstanceId: "server-1",
    deviceId: "device-1",
    credentialId: "credential-1",
    vaultId: "vault-1",
  };
  expect(() =>
    f.runtime.configureNormalizedPush({
      ...authority,
      vaultId: undefined,
    } as never),
  ).toThrow();
  expect(() =>
    f.runtime.configureNormalizedPush({
      ...authority,
      secret: "not-allowed",
    } as never),
  ).toThrow();
  expect(() =>
    f.runtime.configureNormalizedPush({
      ...authority,
      vaultId: "different-vault",
    }),
  ).toThrow();
  expect(f.runtime.isPushPreviewCurrent(preview)).toBe(false);
  await expect(f.runtime.applyPushV3(preview)).rejects.toThrow();
  expect(f.remote.createInputs).toEqual([]);
});

it("binds UI freshness to this runtime and unsubscribes invalidation listeners", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  const preview = await f.runtime.previewPushV3();
  expect(f.runtime.isPushPreviewCurrent(preview)).toBe(true);
  expect(f.rebuild().isPushPreviewCurrent(preview)).toBe(false);
  let calls = 0;
  const off = f.runtime.onInvalidate(() => {
    calls += 1;
  });
  f.runtime.invalidate();
  expect(calls).toBe(1);
  expect(f.runtime.isPushPreviewCurrent(preview)).toBe(false);
  off();
  f.runtime.invalidate();
  expect(calls).toBe(1);
  await expect(f.runtime.applyPushV3(preview)).rejects.toThrow();
  expect(f.remote.createInputs).toEqual([]);
});

it("rejects an unconfirmed preview after restart instead of treating it as recovery", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  const preview = await f.runtime.previewPushV3();
  await expect(f.rebuild().applyPushV3(preview)).rejects.toThrow();
  expect(f.remote.createInputs).toEqual([]);
});

it("rejects an event within the confirmation rescan", async () => {
  const f = await makeNormalizedRuntimeFixture("remote_push");
  const preview = await f.runtime.previewPushV3();
  const read = f.vault.read.bind(f.vault);
  f.vault.read = async (path) => {
    if (path === "Wiki/pages/note.md") f.runtime.invalidate();
    return read(path);
  };
  await expect(f.runtime.applyPushV3(preview)).rejects.toThrow();
  expect(f.remote.createInputs).toEqual([]);
});

it("ordinary runtime preview stays read-only and confirmation persists the local repair", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  const before = await f.vault.read("Wiki/pages/note.md");
  const preview = await f.runtime.previewPushV3();
  expect(await f.vault.read("Wiki/pages/note.md")).toEqual(before);
  expect(preview.changes).toEqual([]);
  expect(preview).toMatchObject({
    normalizedPush: {
      plan: {
        localPlan: [
          expect.objectContaining({
            kind: "write_page",
            path: "pages/note.md",
          }),
        ],
      },
    },
  });
  await f.runtime.applyPushV3(preview);
  expect(
    new TextDecoder().decode((await f.vault.read("Wiki/pages/note.md"))!),
  ).toBe("![A](../assets/photo.png)");
  const next = await f.runtime.previewPushV3();
  expect(next.changes).toEqual([]);
  expect(next).toMatchObject({ normalizedPush: null });
  expect(f.remote.finalizeCalls).toBe(0);
});

it("publishes a renamed attachment once then commits the confirmed local repair through the real runtime", async () => {
  const f = await makeNormalizedRuntimeFixture("remote_push");
  const preview = await f.runtime.previewPushV3();
  expect(preview.publishable).toBe(true);
  expect(
    preview.changes.find((change) => change.operation === "upsert_attachment"),
  ).toMatchObject({
    operation: "upsert_attachment",
    attachment: {
      attachmentId: "11111111-1111-4111-8111-111111111111",
      path: "assets/photo.png",
    },
  });
  await f.runtime.applyPushV3(preview);
  expect(
    new TextDecoder().decode((await f.vault.read("Wiki/pages/note.md"))!),
  ).toBe("![A](../assets/photo.png)");
  expect(f.remote.finalizeCalls).toBe(1);
  expect(f.remote.uploadedChunkIndexes).toEqual([]);
  expect((await f.rebuild().previewPushV3()).changes).toEqual([]);
});

it("rejects a late raw edit before any remote write", async () => {
  const f = await makeNormalizedRuntimeFixture("remote_push");
  const preview = await f.runtime.previewPushV3();
  f.vault.seedMarkdown("Wiki/pages/note.md", "![A](photo.png)\nlate edit");
  await expect(f.runtime.applyPushV3(preview)).rejects.toThrow();
  expect(f.remote.createInputs).toEqual([]);
  expect(
    new TextDecoder().decode((await f.vault.read("Wiki/pages/note.md"))!),
  ).toContain("late edit");
});

it.each([false, true])(
  "recovers a published fixed target without head chasing or retransmission (late edit=%s)",
  async (lateEdit) => {
    const f = await makeNormalizedRuntimeFixture("remote_push");
    const preview = await f.runtime.previewPushV3();
    const plan = requireNormalizedPlan(preview);
    const oldBaseline = await baselineFor(f).read();
    f.vault.failAfterOperations = f.vault.operations + 1;
    await expect(f.runtime.applyPushV3(preview)).rejects.toThrow();
    const publishedPending = await f.runtime.inspectNormalizedPush();
    expect(publishedPending).toMatchObject({
      ...plan,
      phase: "local_pending",
      completion: null,
    });
    expect(f.remote.finalizeCalls).toBe(1);
    expect((await baselineFor(f).read()).baseRevision).toBe(
      oldBaseline.baseRevision,
    );
    f.vault.failAfterOperations = null;
    const target = publishedPending!.verifiedTarget!.revision;
    const segments: TreeSnapshotSegmentV3[] = [];
    for await (const segment of f.remote.snapshotPages(target))
      segments.push(segment);
    f.remote.snapshotPages = async function* (revision) {
      expect(revision).toBe(target);
      for (const segment of segments) yield structuredClone(segment);
    };
    f.remote.head = async () => {
      throw new Error("must not chase head after publication");
    };
    if (lateEdit) {
      f.vault.seedMarkdown("Wiki/pages/note.md", "later user edit");
      await expect(f.rebuild().recover()).rejects.toThrow(
        "TREE_TRANSACTION_AMBIGUOUS",
      );
      expect(
        new TextDecoder().decode((await f.vault.read("Wiki/pages/note.md"))!),
      ).toBe("later user edit");
      await expect(f.runtime.cancelNormalizedPush()).rejects.toThrow();
      expect(await f.runtime.inspectNormalizedPush()).toMatchObject({
        ...plan,
        phase: "local_pending",
        completion: null,
        verifiedTarget: publishedPending!.verifiedTarget,
      });
      expect((await baselineFor(f).read()).baseRevision).toBe(
        oldBaseline.baseRevision,
      );
    } else await f.rebuild().recover();
    expect(f.remote.finalizeCalls).toBe(1);
    expect(f.remote.createInputs).toHaveLength(1);
    expect(f.remote.uploadedChunkIndexes).toEqual([]);
  },
);

it("normal Pull retains a real write even when canonical local content equals the fixed remote", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  const preview = await f.runtime.previewPullV3();
  expect(preview.actions).toContainEqual(
    expect.objectContaining({ kind: "write_page", path: "pages/note.md" }),
  );
  await f.runtime.applyPullV3(preview);
  expect(
    new TextDecoder().decode((await f.vault.read("Wiki/pages/note.md"))!),
  ).toBe("![A](../assets/photo.png)");
  expect(f.remote.finalizeCalls).toBe(0);
});

it("recovers an accepted create response loss after a rename with a fresh runtime epoch", async () => {
  const f = await makeNormalizedRuntimeFixture("remote_push");
  f.runtime.invalidate();
  const preview = await f.runtime.previewPushV3();
  const plan = requireNormalizedPlan(preview);
  expect(plan.scanEpoch).toBeGreaterThan(0);
  f.remote.loseCreateResponseOnce = true;
  await expect(f.runtime.applyPushV3(preview)).rejects.toThrow(
    "create response lost",
  );
  expect(await f.runtime.inspectNormalizedPush()).toMatchObject({
    ...plan,
    phase: "remote_pending",
    verifiedTarget: null,
    completion: null,
  });
  expect(f.remote.createInputs).toHaveLength(1);
  expect(f.remote.createInputs[0]?.idempotencyKey).toBe(
    plan.binding.operationId,
  );
  await f.rebuild().recover();
  expect(await f.runtime.inspectNormalizedPush()).toMatchObject({
    ...plan,
    phase: "complete",
    verifiedTarget: { revision: "rev-push-2" },
  });
  expect(
    new Set(f.remote.createInputs.map((input) => input.idempotencyKey)),
  ).toEqual(new Set([plan.binding.operationId]));
  expect(f.remote.createInputs).toHaveLength(2);
  expect(f.remote.finalizeCalls).toBe(1);
  expect(f.remote.uploadedChunkIndexes).toEqual([]);
  expect((await f.remote.head()).revision).toBe("rev-push-2");
  expect(
    new TextDecoder().decode((await f.vault.read("Wiki/pages/note.md"))!),
  ).toBe("![A](../assets/photo.png)");
});

it("keeps a Page edit made strictly after real Finalize returns and never republishes it during recovery", async () => {
  const f = await makeNormalizedRuntimeFixture("remote_push");
  const preview = await f.runtime.previewPushV3();
  const plan = requireNormalizedPlan(preview);
  const oldBaseline = await baselineFor(f).read();
  const finalize = f.remote.finalize.bind(f.remote);
  f.remote.finalize = async (...args) => {
    const result = await finalize(...args);
    f.vault.seedMarkdown("Wiki/pages/note.md", "my late edit");
    return result;
  };

  await expect(f.runtime.applyPushV3(preview)).rejects.toThrow(
    "STALE_PULL_PREVIEW",
  );
  const pending = await f.runtime.inspectNormalizedPush();
  expect(pending).toMatchObject({
    ...plan,
    phase: "local_pending",
    completion: null,
    verifiedTarget: { revision: "rev-push-1" },
  });
  expect(f.vault.text("Wiki/pages/note.md")).toBe("my late edit");
  expect((await baselineFor(f).read()).baseRevision).toBe(
    oldBaseline.baseRevision,
  );
  expect(f.remote.createInputs).toHaveLength(1);
  expect(f.remote.finalizeCalls).toBe(1);
  expect(f.remote.uploadedChunkIndexes).toEqual([]);

  f.remote.finalize = finalize;
  await expect(f.rebuild().recover()).rejects.toThrow("STALE_PULL_PREVIEW");
  expect(await f.runtime.inspectNormalizedPush()).toMatchObject({
    ...plan,
    phase: "local_pending",
    completion: null,
    verifiedTarget: pending!.verifiedTarget,
  });
  expect(f.vault.text("Wiki/pages/note.md")).toBe("my late edit");
  expect((await baselineFor(f).read()).baseRevision).toBe(
    oldBaseline.baseRevision,
  );
  expect(f.remote.createInputs).toHaveLength(1);
  expect(f.remote.finalizeCalls).toBe(1);
  expect(f.remote.uploadedChunkIndexes).toEqual([]);
});

it("recovers the actual Runtime after an accepted batch success response is lost", async () => {
  const f = await makeNormalizedRuntimeFixture("remote_push");
  const preview = await f.runtime.previewPushV3();
  const plan = requireNormalizedPlan(preview);
  f.remote.loseUploadBatchResponseOnce = true;

  await expect(f.runtime.applyPushV3(preview)).rejects.toThrow(
    "batch response lost",
  );
  expect(await f.runtime.inspectNormalizedPush()).toMatchObject({
    ...plan,
    phase: "remote_pending",
    verifiedTarget: null,
    completion: null,
  });
  expect(f.remote.uploadedBatches).toHaveLength(1);
  expect(f.remote.finalizeCalls).toBe(0);

  await f.rebuild().recover();
  expect(await f.runtime.inspectNormalizedPush()).toMatchObject({
    ...plan,
    phase: "complete",
    verifiedTarget: { revision: "rev-push-1" },
  });
  expect(f.remote.createInputs).toHaveLength(1);
  expect(f.remote.createInputs[0]?.idempotencyKey).toBe(
    plan.binding.operationId,
  );
  expect(f.remote.uploadedBatches).toHaveLength(1);
  expect(f.remote.uploadedChunkIndexes).toEqual([]);
  expect(f.remote.finalizeCalls).toBe(1);
  expect((await baselineFor(f).read()).baseRevision).toBe("rev-push-1");
});

it("recovers the actual Runtime after Finalize publishes and only its success response is lost", async () => {
  const f = await makeNormalizedRuntimeFixture("remote_push");
  const preview = await f.runtime.previewPushV3();
  const plan = requireNormalizedPlan(preview);
  f.remote.loseFinalizeResponseOnce = true;

  await expect(f.runtime.applyPushV3(preview)).rejects.toThrow(
    "finalize response lost",
  );
  expect(await f.runtime.inspectNormalizedPush()).toMatchObject({
    ...plan,
    phase: "remote_pending",
    verifiedTarget: null,
    completion: null,
  });
  expect((await f.remote.head()).revision).toBe("rev-push-1");
  expect(f.remote.createInputs).toHaveLength(1);
  expect(f.remote.createInputs[0]?.idempotencyKey).toBe(
    plan.binding.operationId,
  );
  expect(f.remote.finalizeCalls).toBe(1);

  const publishedSegments: TreeSnapshotSegmentV3[] = [];
  for await (const segment of f.remote.snapshotPages("rev-push-1"))
    publishedSegments.push(segment);
  f.remote.snapshotPages = async function* (revision) {
    expect(revision).toBe("rev-push-1");
    for (const segment of publishedSegments) yield structuredClone(segment);
  };
  const head = f.remote.head.bind(f.remote);
  f.remote.head = async () => {
    throw new Error("must not chase a newer head after lost Finalize success");
  };
  await f.rebuild().recover();

  expect(await f.runtime.inspectNormalizedPush()).toMatchObject({
    ...plan,
    phase: "complete",
    verifiedTarget: { revision: "rev-push-1" },
  });
  expect(f.remote.createInputs).toHaveLength(1);
  expect(f.remote.finalizeCalls).toBe(1);
  expect(f.remote.uploadedChunkIndexes).toEqual([]);
  const publishedAttachmentIds = f.remote.uploadedBatches
    .flatMap((batch) => batch.changes)
    .filter((change) => change.operation === "upsert_attachment")
    .map((change) => change.attachment.attachmentId);
  expect(publishedAttachmentIds).toEqual([
    "11111111-1111-4111-8111-111111111111",
  ]);
  expect((await baselineFor(f).read()).baseRevision).toBe("rev-push-1");

  f.remote.head = head;
  const pull = await f.rebuild().previewPullV3();
  expect(pull.actions).toEqual([]);
  await f.rebuild().applyPullV3(pull);
  const nextPush = await f.rebuild().previewPushV3();
  expect(nextPush.changes).toEqual([]);
  expect(nextPush.normalizedPush).toBeNull();
  expect(f.remote.createInputs).toHaveLength(1);
  expect(f.remote.finalizeCalls).toBe(1);
  expect(f.remote.uploadedChunkIndexes).toEqual([]);
});

it("replays the original Runtime plan when the confirmed parent write succeeds but its return is lost", async () => {
  const f = await makeNormalizedRuntimeFixture("remote_push");
  const preview = await f.runtime.previewPushV3();
  const plan = requireNormalizedPlan(preview);
  const write = f.control.write.bind(f.control);
  let lost = false;
  f.control.write = async (path, value) => {
    await write(path, value);
    const payload = path.endsWith("/push/journal.json.next")
      ? (JSON.parse(value) as { payload?: { phase?: string } }).payload
      : undefined;
    if (!lost && payload?.phase === "confirmed") {
      lost = true;
      throw new Error("confirmed parent write response lost");
    }
  };

  await expect(f.runtime.applyPushV3(preview)).rejects.toThrow(
    "confirmed parent write response lost",
  );
  expect(lost).toBe(true);
  expect(await f.runtime.inspectNormalizedPush()).toMatchObject({
    ...plan,
    phase: "confirmed",
  });
  expect(f.remote.createInputs).toEqual([]);
  expect((await baselineFor(f).read()).baseRevision).toBe(plan.sourceRevision);

  f.control.write = write;
  await f.rebuild().recover();
  expect(await f.runtime.inspectNormalizedPush()).toMatchObject({
    ...plan,
    phase: "complete",
  });
  expect(f.remote.createInputs).toHaveLength(1);
  expect(f.remote.createInputs[0]?.idempotencyKey).toBe(
    plan.binding.operationId,
  );
  expect(f.remote.finalizeCalls).toBe(1);
  expect(f.remote.uploadedChunkIndexes).toEqual([]);
});

it("recovers the actual Runtime after the Page CAS succeeds but its return is lost", async () => {
  const f = await makeNormalizedRuntimeFixture("remote_push");
  const preview = await f.runtime.previewPushV3();
  const plan = requireNormalizedPlan(preview);
  const compareAndSwap = f.vault.compareAndSwap.bind(f.vault);
  let lost = false;
  f.vault.compareAndSwap = async (...args) => {
    const result = await compareAndSwap(...args);
    if (!lost) {
      lost = true;
      throw new Error("actual Page CAS response lost");
    }
    return result;
  };

  await expect(f.runtime.applyPushV3(preview)).rejects.toThrow(
    "actual Page CAS response lost",
  );
  expect(lost).toBe(true);
  expect(f.vault.operationLog).toContain("cas:Wiki/pages/note.md");
  expect(f.vault.text("Wiki/pages/note.md")).toBe("![A](../assets/photo.png)");
  expect(await f.runtime.inspectNormalizedPush()).toMatchObject({
    ...plan,
    phase: "local_pending",
    completion: null,
  });
  expect((await baselineFor(f).read()).baseRevision).toBe(plan.sourceRevision);

  f.vault.compareAndSwap = compareAndSwap;
  await f.rebuild().recover();
  expect(await f.runtime.inspectNormalizedPush()).toMatchObject({
    ...plan,
    phase: "complete",
  });
  expect(f.remote.createInputs).toHaveLength(1);
  expect(f.remote.finalizeCalls).toBe(1);
  expect(f.remote.uploadedChunkIndexes).toEqual([]);
  expect((await baselineFor(f).read()).baseRevision).toBe("rev-push-1");
});

it("recovers a local-only repair with zero remote mutations and then Pulls a new head", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  const preview = await f.runtime.previewPushV3();
  const plan = requireNormalizedPlan(preview);
  f.vault.failAfterOperations = f.vault.operations + 1;
  await expect(f.runtime.applyPushV3(preview)).rejects.toThrow(
    "injected vault failure",
  );
  expect(await f.runtime.inspectNormalizedPush()).toMatchObject({
    ...plan,
    mode: "local_only",
    phase: "local_pending",
  });
  const mutationCounts = {
    creates: f.remote.createInputs.length,
    batches: f.remote.uploadedBatches.length,
    chunks: f.remote.uploadedChunkIndexes.length,
    finalizes: f.remote.finalizeCalls,
  };
  await expect(f.rebuild().previewPullV3()).rejects.toThrow(
    "PUSH_RECOVERY_REQUIRED",
  );
  await expect(f.rebuild().previewPushV3()).rejects.toThrow(
    "PUSH_RECOVERY_REQUIRED",
  );

  f.vault.failAfterOperations = null;
  await f.rebuild().recover();
  expect({
    creates: f.remote.createInputs.length,
    batches: f.remote.uploadedBatches.length,
    chunks: f.remote.uploadedChunkIndexes.length,
    finalizes: f.remote.finalizeCalls,
  }).toEqual(mutationCounts);
  expect(mutationCounts).toEqual({
    creates: 0,
    batches: 0,
    chunks: 0,
    finalizes: 0,
  });
  expect(await f.runtime.inspectNormalizedPush()).toMatchObject({
    ...plan,
    phase: "complete",
  });

  const current: TreeSnapshotSegmentV3[] = [];
  for await (const segment of f.remote.snapshotPages(plan.sourceRevision))
    current.push(segment);
  const remoteBody = "remote after local-only\n![A](../assets/photo.png)";
  const remoteHash = await contentHash(remoteBody);
  await f.remote.seedTree({
    spaceId: "space-1",
    revision: "rev-2",
    folders: current[0]!.folders,
    pages: current[0]!.pages.map((page) => ({
      ...page,
      body: remoteBody,
      contentHash: remoteHash,
    })),
    attachments: current[0]!.attachments,
    blobs: {
      "11111111-1111-4111-8111-111111111111": (await f.vault.read(
        "Wiki/assets/photo.png",
      ))!,
    },
  });
  const pull = await f.rebuild().previewPullV3();
  await f.rebuild().applyPullV3(pull);
  expect(f.vault.text("Wiki/pages/note.md")).toBe(remoteBody);
  expect((await baselineFor(f).read()).baseRevision).toBe("rev-2");
  expect((await f.rebuild().previewPushV3()).changes).toEqual([]);
  expect({
    creates: f.remote.createInputs.length,
    batches: f.remote.uploadedBatches.length,
    chunks: f.remote.uploadedChunkIndexes.length,
    finalizes: f.remote.finalizeCalls,
  }).toEqual(mutationCounts);
});

it("hands a terminal schema-4 repair forward to the ordinary schema-3 Push owner", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  await f.runtime.applyPushV3(await f.runtime.previewPushV3());
  expect(await f.runtime.inspectNormalizedPush()).toMatchObject({
    schemaVersion: 4,
    phase: "complete",
  });
  expect(f.remote.finalizeCalls).toBe(0);

  f.vault.seedMarkdown(
    "Wiki/pages/note.md",
    "ordinary edit\n![A](../assets/photo.png)",
  );
  f.runtime.invalidate();
  const ordinary = await f.runtime.previewPushV3();
  expect(ordinary.normalizedPush).toBeNull();
  expect(ordinary.changes).toContainEqual(
    expect.objectContaining({ operation: "upsert_page" }),
  );
  await f.runtime.applyPushV3(ordinary);

  const root = JSON.parse(
    (await f.control.read(`${RUNTIME_ROOT}/push/journal.json`))!,
  ) as {
    payload: {
      schemaVersion: number;
      remoteState: string;
      localCommitPhase: string;
    };
  };
  expect(root.payload).toMatchObject({
    schemaVersion: 3,
    remoteState: "published",
    localCommitPhase: "verified",
  });
  expect(f.remote.createInputs).toHaveLength(1);
  expect(f.remote.finalizeCalls).toBe(1);
  expect((await baselineFor(f).read()).baseRevision).toBe("rev-push-1");
  expect(f.vault.text("Wiki/pages/note.md")).toBe(
    "ordinary edit\n![A](../assets/photo.png)",
  );
});
