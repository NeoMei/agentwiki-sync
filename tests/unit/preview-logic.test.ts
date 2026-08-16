import { describe, expect, it } from "vitest";
import type {
  InitialBindingChoice,
  PullPreview,
} from "../../src/application/sync-runtime";
import {
  applyBindingMode,
  applyBindingPath,
  applyBindingSearch,
  applyConflictResolution,
  clampPage,
  conflictManualValue,
  matchCandidates,
  pageCount,
  pageSlice,
  PREVIEW_PAGE_SIZE,
} from "../../src/obsidian/preview-logic";

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
  return {
    scanEpoch: 1,
    revision: "r1",
    actions: [],
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
