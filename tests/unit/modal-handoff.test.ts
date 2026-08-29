import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { completeModalAction } from "../../src/obsidian/modal-handoff";
import {
  SyncCenterModal,
  type SyncDiff,
} from "../../src/obsidian/sync-center-modal";

const runnableDiff: SyncDiff = {
  canPublish: true,
  displayName: "Space",
  rootPath: "AgentWiki",
  roleLabel: "可编辑",
  remoteAhead: true,
  protocolLabel: "Sync v2",
  localFoldersAdded: [],
  localFoldersMoved: [],
  localFoldersDeleted: [],
  remoteFoldersUpdated: [],
  remoteFoldersArchived: [],
  folderCount: 0,
  pageCount: 1,
  localAdded: [],
  localModified: [],
  localRenamed: [],
  localDeleted: [],
  remoteUpdated: ["page.md"],
  remoteArchived: [],
  remoteListed: true,
  remoteFirstBind: false,
};

describe("modal handoff", () => {
  it("closes the current modal before opening the prepared next modal", async () => {
    const events: string[] = [];

    await completeModalAction(
      async () => {
        events.push("prepared");
        return () => events.push("opened");
      },
      () => events.push("closed"),
    );

    expect(events).toEqual(["prepared", "closed", "opened"]);
  });

  it("keeps the current modal open when preparation fails", async () => {
    const close = vi.fn();

    await expect(
      completeModalAction(async () => {
        throw new Error("preview failed");
      }, close),
    ).rejects.toThrow("preview failed");

    expect(close).not.toHaveBeenCalled();
  });

  it("hands the sync center off to its prepared preview in the safe order", async () => {
    const events: string[] = [];
    const modal = new SyncCenterModal({} as App, {
      targets: [{ spaceId: "space-1", label: "Space" }],
      initialSpaceId: "space-1",
      loadDiff: async () => runnableDiff,
      runStrategy: async () => {
        events.push("prepared");
        return () => events.push("opened");
      },
    });
    const testable = modal as unknown as {
      diff: SyncDiff;
      render: () => void;
      run: (strategy: "auto") => Promise<void>;
    };
    testable.diff = runnableDiff;
    testable.render = () => {};
    modal.close = () => events.push("closed");

    await testable.run("auto");

    expect(events).toEqual(["prepared", "closed", "opened"]);
  });
});
