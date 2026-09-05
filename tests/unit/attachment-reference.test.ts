import { describe, expect, it } from "vitest";

import {
  FlatAttachmentPathSchema,
  pathKey,
} from "@neomei/agentwiki-sync-protocol";
import vectors from "@neomei/agentwiki-sync-protocol/test-vectors/sync-v3.json";

import { parseAttachmentReferences } from "../../src/core/attachment-reference";
import conformanceCases from "../fixtures/attachment-reference.conformance.json";

type NormalizedClassification =
  "managed" | "page_embed" | "external" | "invalid";

function normalizedClassification(
  classification: ReturnType<
    typeof parseAttachmentReferences
  >[number]["classification"],
): NormalizedClassification {
  return classification === "local" || classification === "legacy"
    ? "managed"
    : classification;
}

describe("parseAttachmentReferences", () => {
  it.each(conformanceCases)(
    "matches neutral conformance case $name",
    ({ body, expected }) => {
      const references = parseAttachmentReferences(body, "pages/note.md");

      expected.forEach((expectedReference, index) => {
        const targetStart = body.indexOf(expectedReference.rawTarget);
        expect(references[index]?.targetStart).toBe(targetStart);
        expect(references[index]?.targetEnd).toBe(
          targetStart + expectedReference.rawTarget.length,
        );
      });

      expect(
        references.map((reference) => ({
          syntax: reference.syntax,
          classification: normalizedClassification(reference.classification),
          rawTarget: body.slice(reference.targetStart, reference.targetEnd),
          resolvedPath:
            reference.classification === "legacy"
              ? `assets/${reference.target}`
              : (reference.resolvedPath ?? null),
        })),
      ).toEqual(expected);
    },
  );

  it("preserves source ranges for exact target rewriting", () => {
    const body = "before ![[assets/a.png|320]] after";
    const reference = parseAttachmentReferences(body, "pages/note.md")[0]!;

    expect(body.slice(reference.targetStart, reference.targetEnd)).toBe(
      "assets/a.png",
    );
    expect(reference).toMatchObject({
      syntax: "obsidian",
      classification: "local",
      resolvedPath: "assets/a.png",
    });
  });

  it("matches published v3 canonical attachment paths and path keys", () => {
    const publishedPaths = vectors.revision.input.attachments.map(
      (attachment) => attachment.path,
    );
    const body = publishedPaths.map((path) => `![[${path}]]`).join("\n");

    const references = parseAttachmentReferences(body, "pages/note.md");

    expect(references.map((reference) => reference.resolvedPath)).toEqual(
      publishedPaths.map((path) => FlatAttachmentPathSchema.parse(path)),
    );
    expect(
      references.map((reference) => pathKey(reference.resolvedPath!)),
    ).toEqual(publishedPaths.map((path) => pathKey(path)));
  });

  it("normalizes NFC and Unicode case folding through the public path contract", () => {
    const decomposed = "assets/Cafe\u0301.PNG";
    const [reference] = parseAttachmentReferences(
      `![[${decomposed}]]`,
      "pages/note.md",
    );

    expect(reference?.resolvedPath).toBe("assets/Café.PNG");
    expect(pathKey(reference!.resolvedPath!)).toBe(pathKey("assets/CAFÉ.png"));
  });

  it("ignores image-looking syntax inside inline, indented, fenced, list, blockquote code and comments", () => {
    const body = [
      "`![[assets/inline.png]]`",
      "    ![[assets/indented.png]]",
      "-     ![[assets/list-indent.png]]",
      ">     ![[assets/quote-indent.png]]",
      "- ```md",
      "  ![[assets/list-fence.png]]",
      "  ```",
      "> ~~~",
      "> ![x](../assets/quote-fence.png)",
      "> ~~~",
      "<!-- ![[assets/comment.png]] -->",
      "![[assets/real.png]]",
    ].join("\n");

    expect(
      parseAttachmentReferences(body, "pages/note.md").map(
        (reference) => reference.resolvedPath,
      ),
    ).toEqual(["assets/real.png"]);
  });

  it("parses escaped alt brackets, escaped destination characters, angle whitespace and one complete title", () => {
    const body = [
      String.raw`![a\]b](../assets/a\ b.png "one title")`,
      `![x](<../assets/angle name.png> 'single title')`,
      `![x](../assets/paren.png (paren title))`,
    ].join("\n");
    const references = parseAttachmentReferences(body, "pages/note.md");

    expect(references.map((reference) => reference.resolvedPath)).toEqual([
      "assets/a b.png",
      "assets/angle name.png",
      "assets/paren.png",
    ]);
    expect(
      references.map((reference) =>
        body.slice(reference.targetStart, reference.targetEnd),
      ),
    ).toEqual([
      String.raw`../assets/a\ b.png`,
      "../assets/angle name.png",
      "../assets/paren.png",
    ]);
  });

  it("decodes percent encoding before validating the portable local path", () => {
    const [reference] = parseAttachmentReferences(
      "![x](../assets/a%20b.png)",
      "pages/note.md",
    );

    expect(reference).toMatchObject({
      classification: "local",
      resolvedPath: "assets/a b.png",
    });
  });

  it("requires a nested page to traverse all the way back to assets", () => {
    const references = parseAttachmentReferences(
      "![bad](../assets/a.png) ![good](../../assets/a.png)",
      "pages/topic/note.md",
    );

    expect(references.map((reference) => reference.classification)).toEqual([
      "invalid",
      "local",
    ]);
    expect(references[1]?.resolvedPath).toBe("assets/a.png");
  });

  it("classifies only supported network and data targets as external", () => {
    const body = [
      "![a](https://example.test/a.png)",
      "![b](http://example.test/b.png)",
      "![c](ftp://example.test/c.png)",
      "![d](//cdn.test/d.png)",
      "![e](data:image/png;base64,AA==)",
      "![f](file:///tmp/f.png)",
      "![g](/tmp/g.png)",
      "![h](C:/tmp/h.png)",
    ].join("\n");

    expect(
      parseAttachmentReferences(body, "pages/note.md").map((reference) =>
        [reference.target, reference.classification].join(":"),
      ),
    ).toEqual([
      "https://example.test/a.png:external",
      "http://example.test/b.png:external",
      "ftp://example.test/c.png:external",
      "//cdn.test/d.png:external",
      "data:image/png;base64,AA==:external",
      "file:///tmp/f.png:invalid",
      "/tmp/g.png:invalid",
      "C:/tmp/h.png:invalid",
    ]);
  });

  it("rejects raw destination whitespace, invalid trailing tokens and malformed escapes", () => {
    const body = [
      "![x](../assets/raw name.png)",
      '![x](../assets/a.png "title" trailing)',
      "![x](../assets/a%ZZ.png)",
    ].join("\n");

    expect(
      parseAttachmentReferences(body, "pages/note.md").map(
        (reference) => reference.classification,
      ),
    ).toEqual(["invalid", "invalid", "invalid"]);
  });

  it("does not parse escaped image openers and classifies a historical bare name", () => {
    const body = String.raw`\![[assets/not.png]] ![x](../assets/yes.png) ![[old.png]]`;

    expect(
      parseAttachmentReferences(body, "pages/note.md").map((reference) => ({
        classification: reference.classification,
        resolvedPath: reference.resolvedPath,
        target: reference.target,
      })),
    ).toEqual([
      {
        classification: "local",
        resolvedPath: "assets/yes.png",
        target: "../assets/yes.png",
      },
      { classification: "legacy", resolvedPath: undefined, target: "old.png" },
    ]);
  });

  it("keeps escaped brackets in the source token while resolving their literal name", () => {
    const body = String.raw`![[assets/a\].png|200]]`;
    const [reference] = parseAttachmentReferences(body, "pages/note.md");

    expect(reference?.resolvedPath).toBe("assets/a].png");
    expect(body.slice(reference!.targetStart, reference!.targetEnd)).toBe(
      String.raw`assets/a\].png`,
    );
  });

  it("balances nested and escaped alt brackets while preserving the exact target range", () => {
    const body = String.raw`![outer [inner\] literal]](../assets/a.png)`;
    const [reference] = parseAttachmentReferences(body, "pages/note.md");

    expect(reference).toMatchObject({
      syntax: "markdown",
      classification: "local",
      resolvedPath: "assets/a.png",
    });
    expect(body.slice(reference!.targetStart, reference!.targetEnd)).toBe(
      "../assets/a.png",
    );
  });

  it.each([
    [
      "nested block quote and list",
      "> - ```md\r\n>   ![[assets/hidden.png]]\r\n![[assets/real.png]]",
    ],
    [
      "nested list",
      "- outer\n  - ```md\n    ![[assets/hidden.png]]\n  ![[assets/real.png]]",
    ],
  ])("reprocesses the exit line after leaving a %s fence", (_label, body) => {
    expect(
      parseAttachmentReferences(body, "pages/note.md").map(
        (reference) => reference.resolvedPath,
      ),
    ).toEqual(["assets/real.png"]);
  });
});
