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
});
