import { describe, expect, it } from "vitest";
import type {
  InitialBindingChoice,
  PullPreview,
  PullPreviewV3,
} from "../../src/application/sync-runtime";
import type {
  AttachmentConflict,
  AttachmentConflictResolution,
  FolderConflict,
} from "../../src/core/merge";
import {
  attachmentConflictResolutionComplete,
  attachmentOperationLabel,
  attachmentTransferSummary,
  applyBindingMode,
  applyBindingPath,
  applyBindingSearch,
  applyConflictResolution,
  applyFolderConflictResolution,
  clampPage,
  conflictManualValue,
  folderConflictManualValue,
  folderConflictValidationError,
  matchCandidates,
  pendingPreviewDecisionCount,
  pageCount,
  pageSlice,
  PREVIEW_PAGE_SIZE,
  protocolLabel,
} from "../../src/obsidian/preview-logic";
import {
  syncSummary,
  type AttachmentSyncDiff,
  type SyncDiff,
} from "../../src/obsidian/sync-center-modal";
import * as previewLogic from "../../src/obsidian/preview-logic";
import { makeNormalizedRuntimeFixture } from "../fakes/normalized-push-fixture";

it("counts local repairs separately and allows an empty wire delta only with real local actions", async () => {
  const f = await makeNormalizedRuntimeFixture("local_only");
  const preview = await f.runtime.previewPushV3();
  expect(preview.changes).toEqual([]);
  expect(previewLogic.canConfirmV3Push(preview)).toBe(true);
  expect(previewLogic.localImageRepairLines(preview)).toEqual([
    "本地图片链接修正：1 个 Page",
    "pages/note.md",
  ]);
  expect(
    previewLogic.canConfirmV3Push({ ...preview, normalizedPush: null }),
  ).toBe(false);
  expect(
    previewLogic.canConfirmV3Push({
      ...preview,
      publishable: false,
      normalizedPush: null,
    } as never),
  ).toBe(false);
});

function binding(
  overrides: Partial<InitialBindingChoice> = {},
): InitialBindingChoice {
  return {
    pageId: "p1",
    remotePath: "Remote.md",
    remoteBody: "",
    localPath: null,
    localBody: null,
    localVaultByteHash: null,
    resolution: "remote",
    ...overrides,
  };
}

function preview(
  resolutions: PullPreview["conflictResolutions"] = {},
): PullPreview {
  const emptySnapshot = {
    protocolVersion: "2" as const,
    spaceId: "space",
    revision: "0",
    revisionContentHash: "",
    folders: [],
    pages: [],
  };
  return {
    revision: "r1",
    actions: [],
    folderConflicts: [],
    folderConflictResolutions: {},
    pageConflicts: [],
    pageConflictResolutions: {},
    resolvedFolders: [],
    resolvedPages: [],
    base: emptySnapshot,
    local: { rootPath: "Wiki", folders: [], pages: [] },
    remote: emptySnapshot,
    pagePlan: { resolved: [], conflicts: [] },
    scanEpoch: 1,
    remotePages: [],
    conflicts: [],
    conflictResolutions: resolutions,
    initialBindings: [],
    expectedVaultHashes: {},
    conflictValuePaths: {},
    localCandidates: [],
    artifactRoots: [],
  };
}

function folderConflict(
  overrides: Partial<FolderConflict> = {},
): FolderConflict {
  return {
    conflictId: "folder:f1",
    objectType: "folder",
    folderId: "f1",
    baseParentPath: null,
    localParentPath: null,
    remoteParentPath: null,
    basePath: "pages/A",
    localPath: "pages/A",
    remotePath: "pages/B",
    ...overrides,
  };
}

function previewWithFolderConflict(): PullPreview {
  const value = preview();
  value.folderConflicts = [folderConflict()];
  value.resolvedFolders = [
    {
      folderId: "f1",
      parentFolderId: null,
      name: "A",
      path: "pages/A",
      sortOrder: 0,
      updatedAt: "",
    },
    {
      folderId: "f2",
      parentFolderId: null,
      name: "Other",
      path: "pages/Other",
      sortOrder: 0,
      updatedAt: "",
    },
  ];
  return value;
}

function attachmentConflict(): AttachmentConflict {
  return {
    conflictId: "attachment:a1:content",
    attachmentId: "a1",
    kind: "content",
    base: null,
    local: null,
    remote: null,
    affectedPageIds: ["p1", "p2"],
  };
}

function v3Preview(
  input: {
    blockers?: PullPreviewV3["blockers"];
    conflicts?: AttachmentConflict[];
    resolutions?: Record<string, AttachmentConflictResolution>;
  } = {},
): PullPreviewV3 {
  return {
    blockers: input.blockers ?? [],
    attachmentConflicts: input.conflicts ?? [],
    attachmentConflictResolutions: input.resolutions ?? {},
    folderConflicts: [],
    folderConflictResolutions: {},
    pageConflicts: [],
    pageConflictResolutions: {},
  } as unknown as PullPreviewV3;
}

describe("sync strategy permissions", () => {
  it("keeps Pull available while disabling publish strategies for viewers", () => {
    expect(previewLogic).toHaveProperty("canRunSyncStrategy");
    const canRunSyncStrategy = (
      previewLogic as typeof previewLogic & {
        canRunSyncStrategy: (
          canPublish: boolean,
          strategy: "auto" | "local" | "server",
        ) => boolean;
      }
    ).canRunSyncStrategy;
    expect(canRunSyncStrategy(false, "server")).toBe(true);
    expect(canRunSyncStrategy(false, "auto")).toBe(false);
    expect(canRunSyncStrategy(false, "local")).toBe(false);
    expect(canRunSyncStrategy(true, "auto")).toBe(true);
  });

  it("prepares local-preference resolutions without applying the Pull", () => {
    expect(previewLogic).toHaveProperty("preferLocalPull");
    const preferLocalPull = (
      previewLogic as typeof previewLogic & {
        preferLocalPull: (preview: PullPreview) => void;
      }
    ).preferLocalPull;
    const value = preview();
    value.conflicts = [
      {
        conflictId: "c1",
        pageId: "p1",
        field: "body",
        base: "base",
        local: "local",
        remote: "remote",
        wholeDocument: true,
      },
    ];
    value.initialBindings = [
      binding({ pageId: "local", localPath: "Local.md", resolution: null }),
      binding({ pageId: "remote", localPath: null, resolution: null }),
    ];
    preferLocalPull(value);
    expect(value.conflictResolutions.c1).toEqual({ choice: "local" });
    expect(value.initialBindings.map((item) => item.resolution)).toEqual([
      "local",
      "remote",
    ]);
  });
});

describe("preview paging", () => {
  it("always reports at least one page and clamps out-of-range pages", () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(PREVIEW_PAGE_SIZE)).toBe(1);
    expect(pageCount(PREVIEW_PAGE_SIZE + 1)).toBe(2);
    expect(clampPage(-1, 250)).toBe(0);
    expect(clampPage(99, 250)).toBe(2);
    expect(clampPage(0, 0)).toBe(0);
  });

  it("slices pages without leaking across boundaries", () => {
    const items = Array.from({ length: 250 }, (_, index) => `p${index}`);
    expect(pageSlice(items, 0)).toHaveLength(PREVIEW_PAGE_SIZE);
    expect(pageSlice(items, 0)[0]).toBe("p0");
    expect(pageSlice(items, 1)[0]).toBe(`p${PREVIEW_PAGE_SIZE}`);
    expect(pageSlice(items, 2)).toHaveLength(50);
    expect(pageSlice(items, -5)[0]).toBe("p0");
  });
});

describe("preview inputs", () => {
  it("shows only bindings that still require a user decision", () => {
    expect(previewLogic).toHaveProperty("bindingsRequiringInput");
    const bindingsRequiringInput = (
      previewLogic as typeof previewLogic & {
        bindingsRequiringInput: (
          bindings: InitialBindingChoice[],
        ) => InitialBindingChoice[];
      }
    ).bindingsRequiringInput;
    const pending = binding({ pageId: "pending", resolution: null });
    const resolved = binding({ pageId: "resolved", resolution: "remote" });

    expect(bindingsRequiringInput([resolved, pending])).toEqual([pending]);
  });

  it("counts unresolved conflicts and bindings before confirmation", () => {
    const value = preview({ resolved: { choice: "remote" } });
    value.conflicts = [
      {
        conflictId: "resolved",
        pageId: "p1",
        field: "body",
        base: "base",
        local: "local",
        remote: "remote",
        wholeDocument: true,
      },
      {
        conflictId: "pending",
        pageId: "p2",
        field: "body",
        base: "base",
        local: "local",
        remote: "remote",
        wholeDocument: true,
      },
    ];
    value.initialBindings = [
      binding({ pageId: "pending-binding", resolution: null }),
      binding({ pageId: "resolved-binding", resolution: "remote" }),
    ];

    expect(pendingPreviewDecisionCount(value.initialBindings, value)).toBe(2);

    value.conflictResolutions.pending = { choice: "local" };
    value.initialBindings[0]!.resolution = "local";
    expect(pendingPreviewDecisionCount(value.initialBindings, value)).toBe(0);
  });

  it("keeps confirmation disabled while an attachment blocker or conflict is unresolved", () => {
    const conflict = attachmentConflict();
    const value = v3Preview({
      blockers: [
        {
          code: "ATTACHMENT_MISSING",
          pagePath: "pages/note.md",
          path: "assets/missing.png",
          detail: "missing",
        },
      ],
      conflicts: [conflict],
    });

    expect(pendingPreviewDecisionCount([], value)).toBe(2);
    value.blockers = [];
    value.attachmentConflictResolutions[conflict.conflictId] = {
      choice: "remote",
    };
    expect(pendingPreviewDecisionCount([], value)).toBe(0);
  });
});

describe("attachment preview", () => {
  it("requires keep-both primary, secondary path, and a proper Page subset", () => {
    const conflict = attachmentConflict();
    const incomplete: AttachmentConflictResolution = {
      choice: "keep_both",
      primary: "local",
      secondaryAttachmentId: "11111111-1111-4111-8111-111111111111",
      secondaryPath: "",
      redirectPageIds: ["p1"],
    };
    expect(attachmentConflictResolutionComplete(conflict, incomplete)).toBe(
      false,
    );
    expect(
      pendingPreviewDecisionCount(
        [],
        v3Preview({
          conflicts: [conflict],
          resolutions: { [conflict.conflictId]: incomplete },
        }),
      ),
    ).toBe(1);
    expect(
      attachmentConflictResolutionComplete(conflict, {
        choice: "keep_both",
        primary: "remote",
        secondaryAttachmentId: "11111111-1111-4111-8111-111111111111",
        secondaryPath: "assets/copy.png",
        redirectPageIds: [],
      }),
    ).toBe(false);
    expect(
      attachmentConflictResolutionComplete(conflict, {
        choice: "keep_both",
        primary: "remote",
        secondaryAttachmentId: "11111111-1111-4111-8111-111111111111",
        secondaryPath: "assets/copy.png",
        redirectPageIds: ["p1"],
      }),
    ).toBe(true);
  });

  it("summarizes upload/download bytes together with the capability limit", () => {
    const diff: AttachmentSyncDiff = {
      uploads: 2,
      downloads: 1,
      replacements: 1,
      renames: 0,
      detached: 1,
      uploadBytes: 3 * 1024 * 1024,
      downloadBytes: 512 * 1024,
      transferLimitBytes: 100 * 1024 * 1024,
      items: [],
    };

    expect(attachmentTransferSummary(diff)).toBe(
      "图片：上传 2 张 / 3 MB · 下载 1 张 / 512 KB · 替换 1 · 取消引用 1 · 单次传输上限 100 MB",
    );
  });

  it("does not report no work when only referenced images changed", () => {
    const attachmentChanges: AttachmentSyncDiff = {
      uploads: 1,
      downloads: 0,
      replacements: 0,
      renames: 0,
      detached: 0,
      uploadBytes: 1024,
      downloadBytes: 0,
      transferLimitBytes: 100 * 1024 * 1024,
      items: [
        {
          attachmentId: "a1",
          path: "assets/image.png",
          operation: "upsert_attachment",
          sizeBytes: 1024,
          affectedPageCount: 1,
        },
      ],
    };
    const diff: SyncDiff = {
      canPublish: true,
      displayName: "Space",
      rootPath: "AgentWiki",
      roleLabel: "可编辑",
      remoteAhead: false,
      protocolLabel: "Sync v3",
      attachmentChanges,
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
      remoteListed: false,
      remoteFirstBind: false,
    };

    expect(syncSummary(diff)).toContain("图片变更");
    expect(syncSummary(diff)).not.toContain("无需操作");
  });

  it("explains detach without implying either file is deleted", () => {
    expect(attachmentOperationLabel("detach_attachment")).toContain(
      "两端文件保留",
    );
  });
});

describe("candidate matching", () => {
  const candidates = [
    { path: "Alpha.md", vaultByteHash: "a" },
    { path: "alphabet/Beta.md", vaultByteHash: "b" },
    { path: "Gamma.md", vaultByteHash: "c" },
  ];

  it("matches case-insensitively and trims whitespace", () => {
    expect(matchCandidates(candidates, "  ALPHA ")).toHaveLength(2);
    expect(matchCandidates(candidates, "gamma")[0]?.path).toBe("Gamma.md");
    expect(matchCandidates(candidates, "")).toHaveLength(0);
    expect(matchCandidates(candidates, "miss")).toHaveLength(0);
  });

  it("respects the result limit", () => {
    expect(matchCandidates(candidates, "a", 1)).toHaveLength(1);
  });
});

describe("binding interaction", () => {
  const candidates = [
    { path: "A.md", vaultByteHash: "a" },
    { path: "B.md", vaultByteHash: "b" },
  ];

  it("binds an exact path and clears to remote when empty", () => {
    const item = binding();
    applyBindingPath(item, candidates, "A.md");
    expect(item.localPath).toBe("A.md");
    expect(item.localVaultByteHash).toBe("a");
    expect(item.resolution).toBeNull();
    applyBindingPath(item, candidates, "");
    expect(item.localPath).toBeNull();
    expect(item.localVaultByteHash).toBeNull();
    expect(item.resolution).toBe("remote");
  });

  it("search clears binding on empty input and does not bind partial matches", () => {
    const item = binding();
    applyBindingPath(item, candidates, "A.md");
    expect(applyBindingSearch(item, candidates, "")).toHaveLength(0);
    expect(item.localPath).toBeNull();
    const item2 = binding();
    expect(applyBindingSearch(item2, candidates, "B")).toEqual(["B.md"]);
    expect(item2.localPath).toBeNull();
  });

  it("mode accepts only local, remote, and manual", () => {
    const item = binding();
    applyBindingMode(item, "local");
    expect(item.resolution).toBe("local");
    applyBindingMode(item, "manual");
    expect(item.resolution).toBe("manual");
    applyBindingMode(item, "invalid");
    expect(item.resolution).toBeNull();
  });
});

describe("conflict resolution", () => {
  it("sets, replaces, and removes resolutions", () => {
    const state = preview();
    applyConflictResolution(state, "c1", "remote");
    expect(state.conflictResolutions["c1"]).toEqual({ choice: "remote" });
    applyConflictResolution(state, "c1", "manual", "final");
    expect(state.conflictResolutions["c1"]).toEqual({
      choice: "manual",
      manualValue: "final",
    });
    applyConflictResolution(state, "c1", "");
    expect(state.conflictResolutions["c1"]).toBeUndefined();
  });

  it("returns the manual value only for manual resolutions", () => {
    const state = preview({ c1: { choice: "manual", manualValue: "x" } });
    expect(conflictManualValue(state, "c1")).toBe("x");
    const local = preview({ c1: { choice: "local" } });
    expect(conflictManualValue(local, "c1")).toBe("");
    expect(conflictManualValue(preview(), "missing")).toBe("");
  });
});

describe("folder conflict resolution", () => {
  it("counts unresolved Folder and Page conflicts together", () => {
    const value = preview();
    value.conflicts = [
      {
        conflictId: "page:c1",
        pageId: "p1",
        field: "body",
        base: "base",
        local: "local",
        remote: "remote",
        wholeDocument: true,
      },
    ];
    value.folderConflicts = [folderConflict()];
    expect(pendingPreviewDecisionCount(value.initialBindings, value)).toBe(2);
  });

  it("sets local/remote resolutions and removes on empty selection", () => {
    const state = previewWithFolderConflict();
    applyFolderConflictResolution(state, "folder:f1", "local");
    expect(state.folderConflictResolutions["folder:f1"]).toEqual({
      choice: "local",
    });
    applyFolderConflictResolution(state, "folder:f1", "remote");
    expect(state.folderConflictResolutions["folder:f1"]).toEqual({
      choice: "remote",
    });
    applyFolderConflictResolution(state, "folder:f1", "");
    expect(state.folderConflictResolutions["folder:f1"]).toBeUndefined();
  });

  it("stores a valid manual path and refuses an invalid one", () => {
    const state = previewWithFolderConflict();
    expect(
      folderConflictValidationError(state, "folder:f1", "pages/New"),
    ).toBeNull();
    applyFolderConflictResolution(state, "folder:f1", "manual", "pages/New");
    expect(state.folderConflictResolutions["folder:f1"]).toEqual({
      choice: "manual",
      manualPath: "pages/New",
    });

    applyFolderConflictResolution(state, "folder:f1", "manual", "not-pages");
    expect(state.folderConflictResolutions["folder:f1"]).toBeUndefined();
    expect(
      folderConflictValidationError(state, "folder:f1", "not-pages"),
    ).toContain("pages/");
  });

  it("reports collisions, missing parents, and empty manual paths", () => {
    const state = previewWithFolderConflict();
    expect(
      folderConflictValidationError(state, "folder:f1", "pages/Other"),
    ).toContain("占用");
    expect(
      folderConflictValidationError(state, "folder:f1", "pages/Missing/New"),
    ).toContain("父目录");
    expect(folderConflictValidationError(state, "folder:f1", "  ")).toContain(
      "请填写",
    );
  });

  it("returns the manual path only for manual folder resolutions", () => {
    const state = previewWithFolderConflict();
    applyFolderConflictResolution(state, "folder:f1", "manual", "pages/X");
    expect(folderConflictManualValue(state, "folder:f1")).toBe("pages/X");
    expect(
      folderConflictManualValue(previewWithFolderConflict(), "folder:f1"),
    ).toBe("");
  });
});

describe("protocol labeling", () => {
  it("labels protocols as diagnostic-only text", () => {
    expect(protocolLabel("3")).toBe("Sync v3");
    expect(protocolLabel("2")).toBe("Sync v2");
    expect(protocolLabel("1")).toBe("Legacy v1");
  });
});
