import { describe, expect, it } from "vitest";
import * as local from "../../src/agentwiki/protocol";
import * as published from "@neomei/agentwiki-sync-protocol";
import {
  portablePathKey,
  validatePortablePath as localValidatePortablePath,
} from "../../src/core/portable-path";

describe("protocol conformance against the published package", () => {
  it("produces identical canonical bytes for representative values", () => {
    for (const value of [
      { z: 1, a: "雪", nested: { list: [1, 2, 3], flag: true } },
      { pages: [{ pageId: "p1", path: "A.md", title: "A", contentHash: "h" }] },
      {
        changes: [
          { operation: "archive", pageId: "p", previousPath: "Old.md" },
        ],
      },
      { empty: {}, null: null, zero: 0 },
    ]) {
      expect(Array.from(local.canonicalBytes(value))).toEqual(
        Array.from(published.canonicalBytes(value)),
      );
    }
  });

  it("produces identical content, confirmation, batch, and revision hashes", async () => {
    expect(await local.contentHash("Hello\r\n")).toBe(
      await published.contentHash("Hello\r\n"),
    );

    const upsert = {
      operation: "upsert" as const,
      pageId: "11111111-1111-4111-8111-111111111111",
      path: "Guide.md",
      title: "Guide",
      body: "Hello\n",
      contentHash: await published.contentHash("Hello\n"),
    };
    const archive = {
      operation: "archive" as const,
      pageId: "22222222-2222-4222-8222-222222222222",
      previousPath: "Old.md",
    };

    const confirmation = {
      protocolVersion: "1" as const,
      spaceId: "space-a",
      baseRevision: "rev-7",
      changes: [
        {
          operation: "upsert" as const,
          pageId: "11111111-1111-4111-8111-111111111111",
          path: "Guide.md",
          title: "Guide",
          contentHash: await published.contentHash("Hello\n"),
        },
        archive,
      ],
    };
    expect(await local.confirmationHash(confirmation)).toBe(
      await published.confirmationHash(confirmation),
    );

    const batch = {
      protocolVersion: "1" as const,
      batchIndex: 0,
      changes: [upsert, archive],
    };
    expect(await local.batchHash(batch)).toBe(await published.batchHash(batch));

    const revision = {
      protocolVersion: "1" as const,
      spaceId: "space",
      pages: [
        {
          pageId: "p1",
          path: "A.md",
          title: "A",
          contentHash: await published.contentHash("a"),
        },
      ],
    };
    expect(await local.revisionContentHash(revision)).toBe(
      await published.revisionContentHash(revision),
    );
  });

  it("produces identical portable path keys", () => {
    for (const input of [
      "Straße/İ.MD",
      "normal/path.md",
      "A.md",
      "café/naïve.md",
    ]) {
      expect(portablePathKey(input)).toBe(published.pathKey(input));
      expect(localValidatePortablePath(input).path).toBe(
        published.validatePortablePath(input).path,
      );
    }
  });

  it("parses decimal counts identically", () => {
    for (const value of ["0", "1", "9223372036854775807"]) {
      expect(local.parseDecimalCount(value)).toBe(
        published.parseDecimalCount(value),
      );
    }
    for (const invalid of ["", "01", "+1", "1.0", "9223372036854775808"]) {
      expect(() => local.parseDecimalCount(invalid)).toThrow();
      expect(() => published.parseDecimalCount(invalid)).toThrow();
    }
  });
});
