import { describe, expect, it } from "vitest";
import {
  batchHash,
  canonicalBytes,
  confirmationHash,
  contentHash,
  parseDecimalCount,
} from "../../src/agentwiki/protocol";

const upsert = {
  operation: "upsert" as const,
  pageId: "11111111-1111-4111-8111-111111111111",
  path: "Guide.md",
  title: "Guide",
  contentHash:
    "66a045b452102c59d840ec097d59d9467e13a3f34f6494e539ffd32c1bb35f18",
};
const archive = {
  operation: "archive" as const,
  pageId: "22222222-2222-4222-8222-222222222222",
  previousPath: "Old.md",
};

describe("protocol canonicalization", () => {
  it("matches the published hash fixtures", async () => {
    expect(await contentHash("Hello\n")).toBe(
      "66a045b452102c59d840ec097d59d9467e13a3f34f6494e539ffd32c1bb35f18",
    );
    expect(
      await confirmationHash({
        protocolVersion: "1",
        spaceId: "space-a",
        baseRevision: "rev-7",
        changes: [archive, upsert],
      }),
    ).toBe("212c1be142dfc093c9c8974080b7f0b9b8ae956c137284fd58a8db1248e4a3d5");
    expect(
      await batchHash({
        protocolVersion: "1",
        batchIndex: 0,
        changes: [{ ...upsert, body: "Hello\n" }, archive],
      }),
    ).toBe("a2a748fe94c9c1d63c26bf35d4a50e32d085e352033f4f52126cb80545f25276");
  });

  it("sorts object keys by Unicode code point and rejects non-protocol values", () => {
    expect(new TextDecoder().decode(canonicalBytes({ z: 1, a: "雪" }))).toBe(
      '{"a":"雪","z":1}',
    );
    expect(() => canonicalBytes({ n: 1.5 })).toThrow(/safe integer/);
    expect(() => canonicalBytes({ value: undefined })).toThrow(/undefined/);
    expect(() => canonicalBytes({ value: "\ud800" })).toThrow(/surrogate/);
  });

  it("parses canonical decimal counts without losing precision", () => {
    expect(parseDecimalCount("9223372036854775807")).toBe(9223372036854775807n);
    for (const invalid of [
      "",
      "01",
      "+1",
      "1.0",
      "1e3",
      "9223372036854775808",
    ]) {
      expect(() => parseDecimalCount(invalid)).toThrow();
    }
  });
});
