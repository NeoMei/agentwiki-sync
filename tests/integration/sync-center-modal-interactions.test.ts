import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import {
  SyncCenterModal,
  type SyncDiff,
} from "../../src/obsidian/sync-center-modal";
import type { MockElement } from "../fakes/obsidian-mock";

const baseDiff = (
  items: NonNullable<SyncDiff["attachmentChanges"]>["items"],
): SyncDiff => ({
  canPublish: true,
  displayName: "Space",
  rootPath: "Wiki",
  roleLabel: "可编辑",
  remoteAhead: false,
  protocolLabel: "Sync v3",
  attachmentChanges: {
    uploads: items.length,
    downloads: 0,
    replacements: 0,
    renames: 0,
    detached: 0,
    uploadBytes: items.length,
    downloadBytes: 0,
    transferLimitBytes: 100 * 1024 * 1024,
    items,
  },
  localFoldersAdded: [],
  localFoldersMoved: [],
  localFoldersDeleted: [],
  remoteFoldersUpdated: [],
  remoteFoldersArchived: [],
  folderCount: 0,
  pageCount: 0,
  localAdded: [],
  localModified: [],
  localRenamed: [],
  localDeleted: [],
  remoteUpdated: [],
  remoteArchived: [],
  remoteListed: true,
  remoteFirstBind: false,
});

const findAll = (root: unknown, predicate: (item: MockElement) => boolean) =>
  (root as MockElement).queryAll(predicate);

describe("rendered SyncCenterModal target recovery", () => {
  it("preserves its target when the host saves DOM selection, then recovers from a missing folder", async () => {
    const loadedSpaces: string[] = [];
    const startedSyncs: string[] = [];
    let operationSignal: AbortSignal | undefined;
    const modal = new SyncCenterModal({} as App, {
      targets: [
        { spaceId: "wiki", label: "我的知识库 · Wiki" },
        { spaceId: "projects", label: "项目管理 · AgentWiki-项目管理" },
      ],
      initialSpaceId: "wiki",
      loadDiff: async (spaceId) => {
        loadedSpaces.push(spaceId);
        if (spaceId === "wiki") throw new Error("MAPPING_ROOT_MISSING");
        return {
          ...baseDiff([]),
          displayName: "项目管理",
          rootPath: "AgentWiki-项目管理",
          remoteAhead: true,
          remoteFirstBind: true,
        };
      },
      runStrategy: async (spaceId, strategy, { signal }) => {
        startedSyncs.push(`${spaceId}:${strategy}`);
        operationSignal = signal;
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });

    modal.open();
    expect(loadedSpaces).toEqual(["wiki"]);
    await vi.waitFor(() =>
      expect((modal.contentEl as unknown as MockElement).textContent).toContain(
        "映射的本地文件夹不存在",
      ),
    );

    const selectors = findAll(modal.contentEl, (item) => item.tag === "select");
    expect(selectors).toHaveLength(1);
    const selector = selectors[0]!;
    expect(selector.value).toBe("wiki");
    expect(selector.disabled).toBe(false);
    expect(
      findAll(modal.contentEl, (item) =>
        item.classes.has("setting-item-description"),
      ).map((item) => item.textContent),
    ).toContain("当前目标：我的知识库 · Wiki");
    expect(startedSyncs).toEqual([]);

    selector.value = "projects";
    selector.dispatchEvent({ type: "change" });
    await vi.waitFor(() =>
      expect((modal.contentEl as unknown as MockElement).textContent).toContain(
        "首次同步",
      ),
    );
    expect(loadedSpaces).toEqual(["wiki", "projects"]);
    expect(
      (modal.contentEl as unknown as MockElement).textContent,
    ).not.toContain("加载差异失败");
    expect(
      findAll(modal.contentEl, (item) => item.tag === "select")[0]?.value,
    ).toBe("projects");
    expect(startedSyncs).toEqual([]);

    findAll(
      modal.contentEl,
      (item) => item.tag === "button" && item.text === "使用服务器内容",
    )[0]!.dispatchEvent({ type: "click" });
    expect(startedSyncs).toEqual(["projects:server"]);
    const runningSelector = findAll(
      modal.contentEl,
      (item) => item.tag === "select",
    )[0]!;
    expect(runningSelector.disabled).toBe(true);
    runningSelector.value = "wiki";
    runningSelector.dispatchEvent({ type: "change" });
    expect(loadedSpaces).toEqual(["wiki", "projects"]);
    modal.close();
    expect(operationSignal?.aborted).toBe(true);
  });
});

describe("rendered SyncCenterModal image details", () => {
  it("sorts and pages one thousand image rows with a bounded render", async () => {
    const items = Array.from({ length: 1_000 }, (_, index) => {
      const reverse = 999 - index;
      return {
        attachmentId: `attachment-${reverse}`,
        path: `assets/${String(reverse).padStart(4, "0")}.png`,
        operation: "upsert_attachment",
        sizeBytes: 1,
        affectedPageCount: reverse % 3,
      };
    });
    const modal = new SyncCenterModal({} as App, {
      targets: [{ spaceId: "space", label: "Space" }],
      initialSpaceId: "space",
      loadDiff: async () => baseDiff(items),
      runStrategy: async () => undefined,
    });
    modal.open();
    await vi.waitFor(() =>
      expect((modal.contentEl as unknown as MockElement).textContent).toContain(
        "assets/0000.png",
      ),
    );

    let rows = findAll(
      modal.contentEl,
      (item) => item.tag === "li" && item.text.includes("assets/"),
    );
    expect(rows).toHaveLength(100);
    expect(rows[0]?.text).toContain("assets/0000.png");
    expect(rows.at(-1)?.text).toContain("assets/0099.png");
    const next = findAll(
      modal.contentEl,
      (item) => item.tag === "button" && item.text === "下一页",
    )[0]!;
    expect(next.disabled).toBe(false);
    next.dispatchEvent({ type: "click" });

    rows = findAll(
      modal.contentEl,
      (item) => item.tag === "li" && item.text.includes("assets/"),
    );
    expect(rows).toHaveLength(100);
    expect(rows[0]?.text).toContain("assets/0100.png");
  });

  it("labels a pending page push as page recovery", async () => {
    const modal = new SyncCenterModal({} as App, {
      targets: [{ spaceId: "space", label: "Space" }],
      initialSpaceId: "space",
      loadDiff: async () => ({
        ...baseDiff([]),
        protocolLabel: "Sync v2",
        recoveryPending: true,
        recoveryKind: "push",
      }),
      runStrategy: async () => undefined,
    });

    modal.open();
    await vi.waitFor(() =>
      expect((modal.contentEl as unknown as MockElement).textContent).toContain(
        "页面同步尚未完成",
      ),
    );

    expect((modal.contentEl as unknown as MockElement).textContent).toContain(
      "恢复已确认同步",
    );
  });
  it("shows persisted archives and cancels only the selected task before refreshing", async () => {
    let cancelled = false;
    const runStrategy = vi.fn();
    const cancelPendingPush = vi.fn(async (spaceId: string) => {
      expect(spaceId).toBe("wiki");
      cancelled = true;
    });
    const modal = new SyncCenterModal({} as App, {
      targets: [{ spaceId: "wiki", label: "Wiki" }],
      initialSpaceId: "wiki",
      loadDiff: async () => ({
        ...baseDiff([]),
        protocolLabel: "Sync v2",
        recoveryKind: "push",
        recoveryPending: !cancelled,
        recoveryCanCancel: !cancelled,
        localFoldersDeleted: cancelled ? [] : ["pages/A"],
        localDeleted: cancelled ? [] : ["pages/root.md"],
      }),
      runStrategy,
      cancelPendingPush,
    });
    modal.open();
    const text = () => (modal.contentEl as unknown as MockElement).textContent;
    await vi.waitFor(() => expect(text()).toContain("归档目录 1 · 归档页面 1"));
    const button = findAll(
      modal.contentEl,
      (node) =>
        node.tag === "button" && node.textContent === "取消此任务并重新预览",
    )[0]!;
    button.dispatchEvent({ type: "click" });
    await vi.waitFor(() => expect(text()).toContain("自动合并（推荐）"));
    expect(cancelPendingPush).toHaveBeenCalledTimes(1);
    expect(runStrategy).not.toHaveBeenCalled();
  });
});
