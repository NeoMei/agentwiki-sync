import { describe, expect, it } from "vitest";
import {
  computeStatus,
  resolvePageIdentities,
  scanMapping,
} from "../../src/core/status";
import type { ManifestPage, VaultFile } from "../../src/core/model";

const base: Record<string, ManifestPage> = {
  p1: { pageId: "p1", relativePath: "A.md", title: "A", contentHash: "h1" },
  p2: { pageId: "p2", relativePath: "B.md", title: "B", contentHash: "h2" },
};

describe("status", () => {
  it("never invents deletions from an incomplete scan", async () => {
    const files: VaultFile[] = [
      { relativePath: "A.md", bytes: new TextEncoder().encode("one") },
    ];
    const scan = await scanMapping(files, {
      complete: false,
      scanEpoch: 1,
      capabilities: { pages: 5000, bodyBytes: 100_000, manifestBytes: 100_000 },
    });
    expect(() =>
      computeStatus(base, resolvePageIdentities(base, scan.files, []), scan),
    ).toThrow(/不完整/);
  });

  it("preserves identity through a valid move hint", async () => {
    const files: VaultFile[] = [
      { relativePath: "Moved.md", bytes: new TextEncoder().encode("one") },
    ];
    const scan = await scanMapping(files, {
      complete: true,
      scanEpoch: 1,
      capabilities: { pages: 5000, bodyBytes: 100_000, manifestBytes: 100_000 },
    });
    const resolved = resolvePageIdentities(
      { p1: { ...base.p1!, contentHash: scan.files[0]!.contentHash } },
      scan.files,
      [
        {
          pageId: "p1",
          fromPath: "A.md",
          toPath: "Moved.md",
          observedVaultByteHash: scan.files[0]!.vaultByteHash,
        },
      ],
    );
    expect(resolved[0]?.pageId).toBe("p1");
    expect(
      computeStatus(
        { p1: { ...base.p1!, contentHash: scan.files[0]!.contentHash } },
        resolved,
        scan,
      ).renamed,
    ).toHaveLength(1);
  });

  it("blocks scans over any client capacity", async () => {
    const files: VaultFile[] = [
      { relativePath: "A.md", bytes: new TextEncoder().encode("12345") },
    ];
    await expect(
      scanMapping(files, {
        complete: true,
        scanEpoch: 1,
        capabilities: { pages: 1, bodyBytes: 4, manifestBytes: 1000 },
      }),
    ).rejects.toThrow(/SPACE_TOO_LARGE/);
  });
});
