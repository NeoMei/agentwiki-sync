import { describe, expect, it } from "vitest";

import { contentHash, sha256Hex } from "../../src/agentwiki/protocol/hash";
import { normalizeLocalImageLinks } from "../../src/core/local-image-normalization";

describe("normalizeLocalImageLinks", () => {
  it("canonicalizes only the valid image target and preserves raw evidence", async () => {
    const body = '![A](<photo.png> "T")\n`![code](photo.png)`';
    const raw = new TextEncoder().encode(body);

    const result = await normalizeLocalImageLinks({
      pageId: "page-1",
      pagePath: "pages/nested/note.md",
      raw,
      resolve: async () => ({
        kind: "resolved",
        attachmentPath: "assets/photo.png",
        basenameKey: "photo.png",
      }),
    });

    expect(result.body).toBe(
      '![A](<../../assets/photo.png> "T")\n`![code](photo.png)`',
    );
    expect(result.evidence?.rawHash).toBe(await sha256Hex(raw));
    expect(result.evidence?.canonicalContentHash).toBe(
      await contentHash(result.body),
    );
    expect(result.evidence?.canonicalContentHash).not.toBe(
      result.evidence?.rawHash,
    );
    expect(result.evidence?.replacements).toHaveLength(1);
  });

  it("leaves the body unchanged when no resolver capability is available", async () => {
    const body = "![A](photo.png)";

    await expect(
      normalizeLocalImageLinks({
        pageId: "page-1",
        pagePath: "pages/note.md",
        raw: new TextEncoder().encode(body),
      }),
    ).resolves.toEqual({ body, evidence: null });
  });

  it("rewrites multiple target ranges without shifting later source ranges", async () => {
    const body = "![A](one.png) middle ![B](two.png)";
    const result = await normalizeLocalImageLinks({
      pageId: "page-1",
      pagePath: "pages/deep/note.md",
      raw: new TextEncoder().encode(body),
      resolve: async (_pagePath, decodedBasename) => ({
        kind: "resolved",
        attachmentPath: `assets/${decodedBasename}`,
        basenameKey: decodedBasename,
      }),
    });

    expect(result.body).toBe(
      "![A](../../assets/one.png) middle ![B](../../assets/two.png)",
    );
    expect(
      result.evidence?.replacements.map((item) => item.originalTarget),
    ).toEqual(["one.png", "two.png"]);
  });

  it.each([
    [
      "plain target with spaces and parentheses",
      "![A](photo.png)",
      "assets/photo (2).png",
      "![A](../assets/photo%20(2).png)",
    ],
    [
      "percent-encoded target",
      "![A](photo%20one.png)",
      "assets/photo one.png",
      "![A](../assets/photo%20one.png)",
    ],
    [
      "backslash-escaped target",
      String.raw`![A](photo\(one\).png)`,
      "assets/photo (two).png",
      String.raw`![A](../assets/photo\ \(two\).png)`,
    ],
    [
      "angle target and title",
      '![A](<photo one.png> "T")',
      "assets/photo one.png",
      '![A](<../assets/photo one.png> "T")',
    ],
    [
      "Unicode target",
      "![A](Cafe%CC%81.PNG)",
      "assets/Café.PNG",
      "![A](../assets/Caf%C3%A9.PNG)",
    ],
  ])(
    "preserves %s while canonicalizing its path",
    async (_label, body, attachmentPath, expected) => {
      const result = await normalizeLocalImageLinks({
        pageId: "page-1",
        pagePath: "pages/note.md",
        raw: new TextEncoder().encode(body),
        resolve: async () => ({
          kind: "resolved",
          attachmentPath,
          basenameKey: attachmentPath.slice("assets/".length).toLowerCase(),
        }),
      });

      expect(result.body).toBe(expected);
      expect(result.evidence?.replacements).toHaveLength(1);
    },
  );

  it.each(["missing", "ambiguous", "out_of_scope", "unavailable"] as const)(
    "keeps the original invalid target when resolution is %s",
    async (kind) => {
      const body = "![A](photo.png)";
      const result = await normalizeLocalImageLinks({
        pageId: "page-1",
        pagePath: "pages/note.md",
        raw: new TextEncoder().encode(body),
        resolve: async () => ({ kind }),
      });

      expect(result).toEqual({ body, evidence: null });
    },
  );

  it("keeps every target when a rewritten target fails public parser validation", async () => {
    const body = "![A](photo.png)";
    const result = await normalizeLocalImageLinks({
      pageId: "page-1",
      pagePath: "pages/note.md",
      raw: new TextEncoder().encode(body),
      resolve: async () => ({
        kind: "resolved",
        attachmentPath: "assets/not-image.svg",
        basenameKey: "not-image.svg",
      }),
    });

    expect(result).toEqual({ body, evidence: null });
  });
});
