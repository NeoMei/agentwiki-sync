import { describe, expect, it } from "vitest";
import {
  OperationLock,
  removeMapping,
  selectMappingForPath,
  validateMappings,
} from "../../src/application/sync-coordinator";
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

  it("selects the active mapping for an open file and rejects overlaps", () => {
    const mappings = [
      { spaceId: "s1", rootPath: "Wiki", status: "active" as const },
      { spaceId: "s2", rootPath: "Other", status: "pending" as const },
    ];
    expect(selectMappingForPath(mappings, "Wiki/A.md")?.spaceId).toBe("s1");
    expect(selectMappingForPath(mappings, "Other/A.md")).toBeNull();
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
});
