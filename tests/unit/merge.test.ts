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

  it("auto-merges append-only edits when one side fully contains the other", async () => {
    const base = "base";
    const remote = `${base}\nremote addition`;
    const local = `${remote}\nlocal addition`;

    const localContainsRemote = await mergeBody(base, local, remote, "p1");
    expect(localContainsRemote).toEqual({ body: local, conflicts: [] });

    const remoteContainsLocal = await mergeBody(base, remote, local, "p1");
    expect(remoteContainsLocal).toEqual({ body: local, conflicts: [] });
  });

  it("auto-merges concurrent end-of-document additions when diff3 preserves both", async () => {
    const base = "base\n";
    const local = `${base}\nlocal addition`;
    const remote = `${base}remote addition\n\n`;

    const result = await mergeBody(base, local, remote, "p1");
    expect(result.conflicts).toHaveLength(0);
    expect(result.body).toContain("remote addition");
    expect(result.body).toContain("local addition");
  });

  it("keeps overlapping deletions as a structured conflict", async () => {
    const result = await mergeBody("abc", "a", "ab", "p1");
    expect(result.conflicts).toHaveLength(1);
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
