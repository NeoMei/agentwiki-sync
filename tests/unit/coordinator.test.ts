import { describe, expect, it } from "vitest";
import {
  OperationLock,
  removeMapping,
  selectMappingForPath,
  validateMappings,
} from "../../src/application/sync-coordinator";
import * as coordinator from "../../src/application/sync-coordinator";
import { parseSettings } from "../../src/application/settings";

describe("sync coordinator", () => {
  it("serializes each space without blocking another space", async () => {
    const lock = new OperationLock();
    const release = lock.acquire("s1");
    expect(() => lock.acquire("s1")).toThrow(/已有/);
    expect(() => lock.acquire("s2")).not.toThrow();
    release();
    expect(() => lock.acquire("s1")).not.toThrow();
  });

  it("removes pending mappings but requires clean proof for active mappings", () => {
    const pending = [
      { spaceId: "s", rootPath: "Wiki", status: "pending" as const },
    ];
    expect(
      removeMapping(pending, "s", {
        activeTransaction: false,
        localClean: false,
        remoteAtBase: false,
      }),
    ).toEqual([]);
    const active = [
      { spaceId: "s", rootPath: "Wiki", status: "active" as const },
    ];
    expect(() =>
      removeMapping(active, "s", {
        activeTransaction: true,
        localClean: true,
        remoteAtBase: true,
      }),
    ).toThrow(/事务/);
    expect(() =>
      removeMapping(active, "s", {
        activeTransaction: false,
        localClean: false,
        remoteAtBase: true,
      }),
    ).toThrow(/干净/);
    expect(
      removeMapping(active, "s", {
        activeTransaction: false,
        localClean: true,
        remoteAtBase: true,
      }),
    ).toEqual([]);
  });
  it("freezes unknown future settings instead of silently resetting them", () => {
    expect(() =>
      parseSettings({
        schemaVersion: 2,
        serverUrl: "",
        serverInstanceId: null,
        mappings: [],
      }),
    ).toThrow(/更新的设置版本/);
  });

  it("rejects settings whose Space mappings are structurally invalid", () => {
    expect(() =>
      parseSettings({
        schemaVersion: 1,
        serverUrl: "https://wiki.example.com",
        serverInstanceId: null,
        mappings: [{ spaceId: "s", rootPath: "../escape", status: "active" }],
      }),
    ).toThrow(/无效的空间映射/);
  });

  it("selects pending mappings for first sync and rejects duplicate spaces", () => {
    const mappings = [
      { spaceId: "s1", rootPath: "Wiki", status: "active" as const },
      { spaceId: "s2", rootPath: "Other", status: "pending" as const },
    ];
    expect(selectMappingForPath(mappings, "Wiki/A.md")?.spaceId).toBe("s1");
    expect(selectMappingForPath(mappings, "Other/A.md")?.spaceId).toBe("s2");
    expect(() =>
      validateMappings([
        { spaceId: "same", rootPath: "Wiki", status: "active" },
        { spaceId: "same", rootPath: "Other", status: "pending" },
      ]),
    ).toThrow(/Space.*映射/);
    expect(() =>
      validateMappings([
        { spaceId: "a", rootPath: "Wiki", status: "active" },
        { spaceId: "b", rootPath: "Wiki/Sub", status: "active" },
      ]),
    ).toThrow(/重叠/);
    expect(() =>
      validateMappings([
        { spaceId: "a", rootPath: "Wiki", status: "pending" },
        { spaceId: "b", rootPath: "Wiki/Sub", status: "pending" },
      ]),
    ).toThrow(/重叠/);
  });

  it("offers unmapped read-only spaces as pull-capable mapping candidates", () => {
    expect(coordinator).toHaveProperty("unmappedSpaces");
    const unmappedSpaces = (
      coordinator as typeof coordinator & {
        unmappedSpaces: <T extends { spaceId: string }>(
          spaces: T[],
          mappings: Array<{ spaceId: string }>,
        ) => T[];
      }
    ).unmappedSpaces;
    expect(
      unmappedSpaces(
        [
          { spaceId: "viewer", canPublish: false },
          { spaceId: "editor", canPublish: true },
        ],
        [{ spaceId: "editor" }],
      ),
    ).toEqual([{ spaceId: "viewer", canPublish: false }]);
  });

  it("keeps an explicitly selected sync mapping stable across the flow", () => {
    expect(coordinator).toHaveProperty("resolveMapping");
    const resolveMapping = (
      coordinator as typeof coordinator & {
        resolveMapping: (
          mappings: Array<{
            spaceId: string;
            rootPath: string;
            status: "pending" | "active";
          }>,
          activePath: string,
          requestedSpaceId?: string,
        ) => { spaceId: string } | null;
      }
    ).resolveMapping;
    const mappings = [
      { spaceId: "s1", rootPath: "Wiki", status: "active" as const },
      { spaceId: "s2", rootPath: "Other", status: "pending" as const },
    ];
    expect(resolveMapping(mappings, "Other/A.md")?.spaceId).toBe("s2");
    expect(resolveMapping(mappings, "Other/A.md", "s1")?.spaceId).toBe("s1");
    expect(resolveMapping(mappings, "Other/A.md", "missing")).toBeNull();
  });

  it("routes diff loading and strategy execution through one selected Space", async () => {
    expect(coordinator).toHaveProperty("SyncTargetSelection");
    const Selection = (
      coordinator as typeof coordinator & {
        SyncTargetSelection: new (
          targetIds: string[],
          initialId: string,
        ) => {
          current: string;
          select: (spaceId: string) => void;
        };
      }
    ).SyncTargetSelection;
    const selection = new Selection(["s1", "s2"], "s2");
    expect(selection.current).toBe("s2");
    selection.select("s1");
    expect(selection.current).toBe("s1");
    expect(() => selection.select("missing")).toThrow(/空间/);
  });
});
