import { describe, expect, it } from "vitest";
import { mergeBody, mergeField } from "../../src/core/merge";

describe("three-way merge", () => {
  it("merges independent field and body edits", async () => {
    expect(mergeField("A", "L", "A")).toEqual({ value: "L", conflict: false });
    expect(mergeField("A", "L", "R").conflict).toBe(true);
    const result = await mergeBody(
      "a\nkeep\nb\n",
      "A\nkeep\nb\n",
      "a\nkeep\nB\n",
      "page-1",
    );
    expect(result.conflicts).toHaveLength(0);
    expect(result.body).toContain("A");
    expect(result.body).toContain("B");
  });

  it("degrades very large line sets to one structured conflict", async () => {
    const huge = `${"x\n".repeat(10_001)}`;
    const result = await mergeBody(
      huge,
      huge.replace("x", "l"),
      huge.replace("x", "r"),
      "page-1",
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.wholeDocument).toBe(true);
    expect(result.body).not.toContain("<<<<<<<");
  });

  it("offers complete merged documents when a small conflict also has independent edits", async () => {
    const result = await mergeBody(
      "start\nkeep-a\nvalue\nkeep-b\nend",
      "LOCAL START\nkeep-a\nlocal\nkeep-b\nend",
      "start\nkeep-a\nremote\nkeep-b\nREMOTE END",
      "page-1",
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      wholeDocument: true,
      local: "LOCAL START\nkeep-a\nlocal\nkeep-b\nREMOTE END",
      remote: "LOCAL START\nkeep-a\nremote\nkeep-b\nREMOTE END",
    });
  });
});
