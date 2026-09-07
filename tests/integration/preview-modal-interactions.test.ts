import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { contentHash } from "../../src/agentwiki/protocol";
import { buildTreePullPreviewV3 } from "../../src/application/tree-diff";
import type { PullPreviewV3 } from "../../src/application/sync-runtime";
import type {
  TreeAttachment,
  TreeFolder,
  TreePageV3,
  TreeSnapshotV3,
} from "../../src/core/tree-model";
import type { LocalTreeScanV3 } from "../../src/core/tree-scan";
import { PreviewModal } from "../../src/obsidian/preview-modal";
import type { MockElement } from "../fakes/obsidian-mock";
import { makeNormalizedRuntimeFixture } from "../fakes/normalized-push-fixture";

it("keeps the full repair count across async resolution, small-page pagination and invalidation", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  for (let i = 0; i < 24; i++)
    f.vault.seedMarkdown(`Wiki/pages/extra-${i}.md`, "![A](photo.png)");
  const resolver = (
    f.vault as typeof f.vault & { resolveShortestImage: () => Promise<unknown> }
  ).resolveShortestImage;
  Object.assign(f.vault, {
    resolveShortestImage: async () => {
      await Promise.resolve();
      return resolver();
    },
  });
  const preview = await f.runtime.previewPushV3();
  const off = vi.fn();
  const modal = new PreviewModal(
    app,
    "Sync",
    Array.from({ length: 100 }, (_, i) => `变更 ${i}`),
    (options) => f.runtime.applyPushV3(preview, options),
    () => {},
    [],
    preview,
    {
      canConfirm: () => f.runtime.isPushPreviewCurrent(preview),
      subscribeInvalidation: (listener) => {
        const unsubscribe = f.runtime.onInvalidate(listener);
        return () => {
          off();
          unsubscribe();
        };
      },
    },
  );
  modal.open();
  const root = modal.contentEl as unknown as MockElement;
  expect(root.textContent).toContain("本地图片链接修正：25 个 Page");
  expect(root.textContent).toContain("共 126 项");
  root
    .queryAll((e) => e.tag === "button" && e.textContent === "下一页")[0]!
    .dispatchEvent({ type: "click" });
  expect(root.textContent).toContain("共 126 项");
  f.runtime.invalidate();
  expect(
    root.queryAll((e) => e.tag === "button" && e.textContent === "确认执行")[0]!
      .disabled,
  ).toBe(true);
  modal.close();
  expect(off).toHaveBeenCalledOnce();
});

it.each(["local_only", "remote_push"] as const)(
  "shows %s pending files without cancelling the owned transaction",
  async (mode) => {
    const f = await makeNormalizedRuntimeFixture(mode);
    const preview = await f.runtime.previewPushV3();
    f.vault.failAfterOperations = f.vault.operations + 1;
    await expect(f.runtime.applyPushV3(preview)).rejects.toThrow();
    const journal = await f.runtime.inspectNormalizedPush();
    expect(journal?.phase).toBe("local_pending");
    const open = vi.fn(async () => {});
    const state =
      mode === "local_only"
        ? "本地链接修正待处理，未发布云端版本"
        : "远端已发布，本地待处理";
    const modal = new PreviewModal(
      app,
      state,
      [state],
      () => f.runtime.recover(),
      () => {},
      [],
      null,
      {
        closeLabel: "关闭",
        confirmLabel: "重试",
        files: journal!.localPlan.map((a) => ({ path: a.path, open })),
      },
    );
    modal.open();
    const root = modal.contentEl as unknown as MockElement;
    const writes = [...f.vault.operationLog];
    const requests = f.remote.createInputs.length;
    const file = root.queryAll(
      (e) => e.tag === "button" && e.textContent === "查看文件：pages/note.md",
    )[0];
    expect(file).toBeDefined();
    file!.dispatchEvent({ type: "click" });
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(f.vault.operationLog).toEqual(writes);
    expect(f.remote.createInputs).toHaveLength(requests);
    root
      .queryAll((e) => e.tag === "button" && e.textContent === "关闭")[0]!
      .dispatchEvent({ type: "click" });
    expect((await f.runtime.inspectNormalizedPush())?.phase).toBe(
      "local_pending",
    );
    f.vault.failAfterOperations = null;
    modal.open();
    root
      .queryAll((e) => e.tag === "button" && e.textContent === "重试")[0]!
      .dispatchEvent({ type: "click" });
    await vi.waitFor(async () =>
      expect((await f.runtime.inspectNormalizedPush())?.phase).toBe("complete"),
    );
    expect(f.remote.finalizeCalls).toBe(mode === "local_only" ? 0 : 1);
  },
);

it("confirms a real local-only repair from the DOM despite an empty wire delta", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  const preview = await f.runtime.previewPushV3();
  const modal = new PreviewModal(
    app,
    "Sync",
    [],
    (options) => f.runtime.applyPushV3(preview, options),
    () => {},
    [],
    preview,
  );
  modal.onOpen();
  const root = modal.contentEl as unknown as MockElement;
  expect(root.textContent).toContain("本地图片链接修正");
  expect(root.textContent).toContain("pages/note.md");
  const button = root.queryAll(
    (e) => e.tag === "button" && e.textContent === "确认修正本地链接",
  )[0]!;
  expect(button).toBeDefined();
  expect(button.disabled).toBe(false);
  button.dispatchEvent({ type: "click" });
  await vi.waitFor(async () =>
    expect(
      new TextDecoder().decode((await f.vault.read("Wiki/pages/note.md"))!),
    ).toBe("![A](../assets/photo.png)"),
  );
  expect(f.remote.createInputs).toEqual([]);
});

it("cancels the real repair preview without RPC or Vault writes", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  const preview = await f.runtime.previewPushV3();
  const before = [...f.vault.operationLog];
  const modal = new PreviewModal(
    app,
    "Sync",
    [],
    (options) => f.runtime.applyPushV3(preview, options),
    () => {
      void f.runtime.discardPushPreviewV3(preview);
    },
    [],
    preview,
  );
  modal.onOpen();
  (modal.contentEl as unknown as MockElement)
    .queryAll((e) => e.tag === "button" && e.textContent === "取消")[0]!
    .dispatchEvent({ type: "click" });
  expect(f.vault.operationLog).toEqual(before);
  expect(f.remote.createInputs).toEqual([]);
});

const app = {
  vault: { adapter: { read: async () => "" } },
} as unknown as App;

const attachment = (
  attachmentId: string,
  path: string,
  hash: string,
): TreeAttachment => ({
  attachmentId,
  path,
  mimeType: "image/png",
  sizeBytes: "16",
  width: 2,
  height: 2,
  contentHash: hash,
  updatedAt: "2026-09-06T00:00:00.000Z",
});

async function page(
  pageId: string,
  path: string,
  body: string,
  referencedAttachmentIds: string[] = [],
): Promise<TreePageV3> {
  return {
    pageId,
    folderId: null,
    path,
    title: path.split("/").at(-1)!.replace(/\.md$/u, ""),
    body,
    contentHash: await contentHash(body),
    updatedAt: "2026-09-06T00:00:00.000Z",
    referencedAttachmentIds,
  };
}

function snapshot(
  pages: TreePageV3[],
  attachments: TreeAttachment[] = [],
  folders: TreeFolder[] = [],
): TreeSnapshotV3 {
  return {
    protocolVersion: "3",
    spaceId: "space",
    revision: "revision",
    revisionContentHash: "0".repeat(64),
    folders,
    pages,
    attachments,
  };
}

function scan(
  pages: TreePageV3[],
  attachments: TreeAttachment[] = [],
  folders: TreeFolder[] = [],
): LocalTreeScanV3 {
  return {
    rootPath: "Wiki",
    folders,
    pages,
    attachments,
    blockers: [],
    rawPathStates: {},
    normalizations: [],
  };
}

const findAll = (root: unknown, predicate: (item: MockElement) => boolean) =>
  (root as MockElement).queryAll(predicate);

function button(root: unknown, label: string): MockElement {
  return findAll(
    root,
    (item) => item.tag === "button" && item.text === label,
  )[0]!;
}

function setting(root: unknown, name: string): MockElement {
  return findAll(
    root,
    (item) =>
      item.classes.has("setting-item") && item.textContent.includes(name),
  )[0]!;
}

function control(root: unknown, tag: string, index = 0): MockElement {
  return findAll(root, (item) => item.tag === tag)[index]!;
}

function change(element: MockElement, value: string): void {
  element.value = value;
  element.dispatchEvent({ type: "change" });
}

function click(element: MockElement): void {
  element.dispatchEvent({ type: "click" });
}

function calculationSummary(preview: PullPreviewV3): string[] {
  const bytes = preview.resolvedAttachments.reduce(
    (total, item) => total + Number(item.sizeBytes),
    0,
  );
  return [
    `图片：${preview.resolvedAttachments.length} 张 · ${bytes} B`,
    ...preview.resolvedAttachments.map((item) => `图片：${item.path}`),
    ...preview.resolvedPages.map((item) => `Page：${item.path} · ${item.body}`),
    ...preview.resolvedFolders.map((item) => `Folder：${item.path}`),
    ...preview.actions.map((item) => `本地动作：${item.kind}`),
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function pageConflictPreview(): Promise<PullPreviewV3> {
  const base = await page("p1", "pages/Note.md", "base");
  const local = await page("p1", "pages/Note.md", "local choice");
  const remote = await page("p1", "pages/Note.md", "remote choice");
  return (await buildTreePullPreviewV3(
    snapshot([base]),
    scan([local]),
    snapshot([remote]),
  )) as PullPreviewV3;
}

async function attachmentConflictPreview(): Promise<PullPreviewV3> {
  const pageOne = await page("p1", "pages/First.md", "![[assets/image.png]]", [
    "a1",
  ]);
  const pageTwo = await page("p2", "pages/Second.md", "![[assets/image.png]]", [
    "a1",
  ]);
  return (await buildTreePullPreviewV3(
    snapshot(
      [pageOne, pageTwo],
      [attachment("a1", "assets/image.png", "a".repeat(64))],
    ),
    scan(
      [pageOne, pageTwo],
      [attachment("a1", "assets/image.png", "b".repeat(64))],
    ),
    snapshot(
      [pageOne, pageTwo],
      [attachment("a1", "assets/image.png", "c".repeat(64))],
    ),
  )) as PullPreviewV3;
}

const folder = (
  folderId: string,
  parentFolderId: string | null,
  path: string,
): TreeFolder => ({
  folderId,
  parentFolderId,
  name: path.split("/").at(-1)!,
  path,
  sortOrder: 0,
  updatedAt: "2026-09-06T00:00:00.000Z",
});

async function folderConflictPreview(): Promise<PullPreviewV3> {
  const parentA = folder("a", null, "pages/A");
  const parentB = folder("b", null, "pages/B");
  const baseChild = folder("child", null, "pages/Child");
  return (await buildTreePullPreviewV3(
    snapshot([], [], [parentA, parentB, baseChild]),
    scan([], [], [parentA, parentB, folder("child", "a", "pages/A/Child")]),
    snapshot([], [], [parentA, parentB, folder("child", "b", "pages/B/Child")]),
  )) as PullPreviewV3;
}

afterEach(() => vi.restoreAllMocks());

describe("rendered PreviewModal controls", () => {
  it("renders the one-time upgrade action and keeps a viewer disabled", () => {
    const confirm = vi.fn();
    const modal = new PreviewModal(
      app,
      "升级预览",
      ["Sync v2 → Sync v3"],
      confirm,
      undefined,
      [],
      null,
      {
        confirmLabel: "确认升级并同步",
        canConfirm: () => false,
        disabledReason: "当前空间为只读，无法确认升级。",
      },
    );

    modal.open();

    expect(modal.contentEl.textContent).toContain("当前空间为只读");
    const upgrade = button(modal.contentEl, "确认升级并同步");
    expect(upgrade.disabled).toBe(true);
    click(upgrade);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("keeps confirm disabled until the latest rapid Page choice has finished", async () => {
    const preview = await pageConflictPreview();
    const conflictId = preview.pageConflicts[0]!.conflictId;
    const localDigest = deferred<ArrayBuffer>();
    const remoteDigest = deferred<ArrayBuffer>();
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const localBytes = new TextEncoder().encode("local choice");
    const remoteBytes = new TextEncoder().encode("remote choice");
    const localHash = await originalDigest("SHA-256", localBytes);
    const remoteHash = await originalDigest("SHA-256", remoteBytes);
    vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, data) => {
      const value = new TextDecoder().decode(data);
      if (value === "local choice") return localDigest.promise;
      if (value === "remote choice") return remoteDigest.promise;
      return originalDigest(algorithm, data);
    });
    const confirmed: PullPreviewV3[] = [];
    const modal = new PreviewModal(
      app,
      "Pull",
      () => calculationSummary(preview),
      async () => {
        confirmed.push(preview);
      },
      undefined,
      [],
      preview,
    );
    modal.open();
    const pageSetting = setting(modal.contentEl, "body: p1");
    const choice = control(pageSetting, "select");
    const confirm = button(modal.contentEl, "确认执行");

    change(choice, "local");
    change(choice, "remote");
    remoteDigest.resolve(remoteHash);
    await Promise.resolve();
    await Promise.resolve();
    expect(confirm.disabled).toBe(true);

    localDigest.resolve(localHash);
    await vi.waitFor(() => {
      expect(confirm.disabled).toBe(false);
    });
    expect(preview.pageConflictResolutions[conflictId]).toEqual({
      choice: "remote",
    });
    expect(modal.contentEl.textContent).toContain(
      "Page：pages/Note.md · remote choice",
    );
    click(confirm);
    await vi.waitFor(() => expect(confirmed).toEqual([preview]));
  });

  it("refreshes the current paginated confirm button after an async decision settles", async () => {
    const preview = await pageConflictPreview();
    const digest = deferred<ArrayBuffer>();
    const started = deferred<void>();
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const remoteBody = "remote choice";
    const remoteHash = await originalDigest(
      "SHA-256",
      new TextEncoder().encode(remoteBody),
    );
    vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, data) => {
      if (new TextDecoder().decode(data) === remoteBody) {
        started.resolve();
        return digest.promise;
      }
      return originalDigest(algorithm, data);
    });
    const modal = new PreviewModal(
      app,
      "Pull",
      Array.from({ length: 101 }, (_, index) => `line-${index}`),
      async () => {},
      undefined,
      [],
      preview,
    );
    modal.open();
    const choice = control(setting(modal.contentEl, "body: p1"), "select");

    change(choice, "remote");
    await started.promise;
    click(button(modal.contentEl, "下一页"));
    const currentConfirm = button(modal.contentEl, "确认执行");
    expect(currentConfirm.disabled).toBe(true);

    digest.resolve(remoteHash);
    await vi.waitFor(() => expect(currentConfirm.disabled).toBe(false));
  });

  it("invalidates an applied attachment choice on every visible draft edit", async () => {
    const preview = await attachmentConflictPreview();
    const conflict = preview.attachmentConflicts[0]!;
    const confirmed: PullPreviewV3[] = [];
    const modal = new PreviewModal(
      app,
      "Pull",
      () => calculationSummary(preview),
      async () => {
        confirmed.push(preview);
      },
      undefined,
      [],
      preview,
    );
    modal.open();
    const imageSetting = setting(modal.contentEl, "图片：assets/image.png");
    const mode = control(imageSetting, "select", 0);
    const primary = control(imageSetting, "select", 1);
    const path = control(imageSetting, "input");
    const redirects = findAll(modal.contentEl, (item) =>
      item.classes.has("agentwiki-sync-attachment-redirects"),
    )[0]!;
    const firstRedirect = control(redirects, "input");
    const confirm = button(modal.contentEl, "确认执行");

    expect(confirm.disabled).toBe(true);
    change(mode, "local");
    await vi.waitFor(() => expect(confirm.disabled).toBe(false));
    change(primary, "remote");
    expect(confirm.disabled).toBe(true);
    click(button(imageSetting, "应用图片选择"));
    await vi.waitFor(() => expect(confirm.disabled).toBe(false));
    expect(preview.attachmentConflictResolutions[conflict.conflictId]).toEqual({
      choice: "local",
    });
    change(mode, "keep_both");
    change(path, "assets/image-local.png");
    firstRedirect.checked = true;
    firstRedirect.dispatchEvent({ type: "change" });
    expect(confirm.disabled).toBe(true);
    expect(
      preview.attachmentConflictResolutions[conflict.conflictId],
    ).toBeUndefined();
    expect(redirects.textContent).toContain("pages/First.md");
    expect(redirects.textContent).not.toContain("p1p2");

    click(button(imageSetting, "应用图片选择"));
    await vi.waitFor(() => expect(confirm.disabled).toBe(false));
    expect(
      preview.attachmentConflictResolutions[conflict.conflictId],
    ).toMatchObject({
      choice: "keep_both",
      primary: "remote",
      secondaryPath: "assets/image-local.png",
      redirectPageIds: ["p1"],
    });
    expect(modal.contentEl.textContent).toContain("图片：2 张 · 32 B");
    expect(modal.contentEl.textContent).toContain(
      "图片：assets/image-local.png",
    );
    expect(modal.contentEl.textContent).toContain("本地动作：");
    click(confirm);
    await vi.waitFor(() => expect(confirmed).toEqual([preview]));
  });

  it("does not install an attachment result after the visible draft changes while Apply is pending", async () => {
    const preview = await attachmentConflictPreview();
    const conflict = preview.attachmentConflicts[0]!;
    const firstDigest = deferred<ArrayBuffer>();
    const secondDigest = deferred<ArrayBuffer>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const body = "![[assets/image.png]]";
    const bodyHash = await originalDigest(
      "SHA-256",
      new TextEncoder().encode(body),
    );
    let matchingCalls = 0;
    vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, data) => {
      if (new TextDecoder().decode(data) !== body)
        return originalDigest(algorithm, data);
      matchingCalls += 1;
      if (matchingCalls === 1) {
        firstStarted.resolve();
        return firstDigest.promise;
      }
      secondStarted.resolve();
      return secondDigest.promise;
    });
    const modal = new PreviewModal(
      app,
      "Pull",
      () => calculationSummary(preview),
      async () => {},
      undefined,
      [],
      preview,
    );
    modal.open();
    const imageSetting = setting(modal.contentEl, "图片：assets/image.png");
    const mode = control(imageSetting, "select", 0);
    const confirm = button(modal.contentEl, "确认执行");

    change(mode, "local");
    await firstStarted.promise;
    change(mode, "keep_both");
    expect(confirm.disabled).toBe(true);

    firstDigest.resolve(bodyHash);
    await secondStarted.promise;
    secondDigest.resolve(bodyHash);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(
      preview.attachmentConflictResolutions[conflict.conflictId],
    ).toBeUndefined();
    expect(confirm.disabled).toBe(true);
  });

  it("invalidates an applied Folder choice until the manual draft is applied", async () => {
    const preview = await folderConflictPreview();
    const conflict = preview.folderConflicts[0]!;
    const modal = new PreviewModal(
      app,
      "Pull",
      () => calculationSummary(preview),
      async () => {},
      undefined,
      [],
      preview,
    );
    modal.open();
    const folderSetting = setting(modal.contentEl, "目录：child");
    const choice = control(folderSetting, "select");
    const manual = control(folderSetting, "textarea");
    const confirm = button(modal.contentEl, "确认执行");

    expect(confirm.disabled).toBe(true);
    change(choice, "remote");
    await vi.waitFor(() => expect(confirm.disabled).toBe(false));
    expect(modal.contentEl.textContent).toContain("Folder：pages/B/Child");
    expect(modal.contentEl.textContent).toContain("本地动作：");
    change(choice, "manual");
    change(manual, "pages/Manual");
    expect(confirm.disabled).toBe(true);
    expect(
      preview.folderConflictResolutions[conflict.conflictId],
    ).toBeUndefined();
    click(button(folderSetting, "应用手动路径"));
    await vi.waitFor(() => expect(confirm.disabled).toBe(false));
    expect(preview.folderConflictResolutions[conflict.conflictId]).toEqual({
      choice: "manual",
      manualPath: "pages/Manual",
    });
  });

  it("renders a blocked Push locator, disables confirm, and releases on cancel", () => {
    const release = vi.fn();
    const modal = new PreviewModal(
      app,
      "Push",
      [],
      async () => {},
      release,
      [],
      {
        protocolVersion: "3",
        publishable: false,
        normalizedPush: null,
        spaceId: "space",
        baseRevision: "revision",
        changes: [],
        blockers: [
          {
            code: "ATTACHMENT_MISSING",
            pagePath: "pages/Missing.md",
            path: "assets/missing.png",
            detail: "hidden detail",
          },
        ],
        capabilities: {} as never,
        capabilitiesHash: "hash",
      },
    );
    modal.open();

    expect(modal.contentEl.textContent).toContain("pages/Missing.md");
    expect(modal.contentEl.textContent).toContain("请恢复图片文件");
    expect(button(modal.contentEl, "确认执行").disabled).toBe(true);
    click(button(modal.contentEl, "取消"));
    expect(release).toHaveBeenCalledOnce();
  });

  it("aborts a running confirmation through the rendered cancel button", async () => {
    const started = deferred<void>();
    const finish = deferred<void>();
    const signals: AbortSignal[] = [];
    const release = vi.fn();
    const modal = new PreviewModal(
      app,
      "Push",
      [],
      async (options) => {
        signals.push(options.signal!);
        started.resolve();
        await finish.promise;
      },
      release,
    );
    modal.open();
    click(button(modal.contentEl, "确认执行"));
    await started.promise;

    click(button(modal.contentEl, "取消"));
    expect(signals[0]?.aborted).toBe(true);

    finish.resolve();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  });

  it("disables cancel after the rendered confirmation crosses its terminal boundary", async () => {
    const started = deferred<void>();
    const progressSent = deferred<void>();
    const finish = deferred<void>();
    const signals: AbortSignal[] = [];
    const release = vi.fn();
    const modal = new PreviewModal(
      app,
      "Push",
      [],
      async (options) => {
        signals.push(options.signal!);
        started.resolve();
        options.onProgress?.({
          phase: "finalize",
          completed: 0,
          total: 1,
          cancellable: false,
          nonCancellableReason: "已提交，正在完成终态。",
        });
        progressSent.resolve();
        await finish.promise;
      },
      release,
    );
    modal.open();
    click(button(modal.contentEl, "确认执行"));
    await started.promise;
    await progressSent.promise;
    const cancel = button(modal.contentEl, "取消");

    expect(cancel.disabled).toBe(true);
    expect(modal.contentEl.textContent).toContain("已提交");
    click(cancel);
    expect(signals[0]?.aborted).toBe(false);

    finish.resolve();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  });
});
