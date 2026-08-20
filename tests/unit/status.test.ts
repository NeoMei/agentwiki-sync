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

  it("keeps the baseline title for an unchanged allocated duplicate path", async () => {
    const body = "# 标题\n\n第二篇";
    const files: VaultFile[] = [
      {
        relativePath: "pages/标题 (2).md",
        bytes: new TextEncoder().encode(body),
      },
    ];
    const scan = await scanMapping(files, {
      complete: true,
      scanEpoch: 1,
      capabilities: {
        pages: 5000,
        bodyBytes: 100_000,
        manifestBytes: 100_000,
      },
    });
    const manifest = {
      p2: {
        pageId: "p2",
        relativePath: "pages/标题 (2).md",
        title: "标题",
        contentHash: scan.files[0]!.contentHash,
      },
    };

    const resolved = resolvePageIdentities(manifest, scan.files, []);

    expect(resolved[0]).toMatchObject({
      pageId: "p2",
      relativePath: "pages/标题 (2).md",
      title: "标题",
      identityStatus: "resolved",
    });
    expect(computeStatus(manifest, resolved, scan).modified).toHaveLength(0);
  });

  it("keeps the new basename title for a genuine local rename", async () => {
    const body = "# 标题\n\n第二篇";
    const files: VaultFile[] = [
      {
        relativePath: "pages/新标题.md",
        bytes: new TextEncoder().encode(body),
      },
    ];
    const scan = await scanMapping(files, {
      complete: true,
      scanEpoch: 1,
      capabilities: {
        pages: 5000,
        bodyBytes: 100_000,
        manifestBytes: 100_000,
      },
    });
    const manifest = {
      p2: {
        pageId: "p2",
        relativePath: "pages/标题 (2).md",
        title: "标题",
        contentHash: scan.files[0]!.contentHash,
      },
    };
    const resolved = resolvePageIdentities(manifest, scan.files, [
      {
        pageId: "p2",
        fromPath: "pages/标题 (2).md",
        toPath: "pages/新标题.md",
        observedVaultByteHash: scan.files[0]!.vaultByteHash,
      },
    ]);

    const status = computeStatus(manifest, resolved, scan);

    expect(resolved[0]?.title).toBe("新标题");
    expect(status.renamed).toHaveLength(1);
    expect(status.modified).toHaveLength(1);
  });
});
