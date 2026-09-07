import { describe, expect, it } from "vitest";

import {
  classifyAttachmentMerge,
  mergeAttachmentsById,
  rewriteAttachmentPageReferences,
} from "../../src/core/attachment-merge";
import type {
  AttachmentConflictResolution,
  AttachmentMergeClassification,
} from "../../src/core/attachment-merge";
import type { TreeAttachment, TreePageV3 } from "../../src/core/tree-model";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function attachment(
  attachmentId: string,
  path: string,
  contentHash = HASH_A,
): TreeAttachment {
  return {
    attachmentId,
    path,
    mimeType: "image/png",
    sizeBytes: "10",
    width: 1,
    height: 1,
    contentHash,
    updatedAt: "2026-09-04T00:00:00Z",
  };
}

function page(
  pageId: string,
  path: string,
  body: string,
  referencedAttachmentIds: string[],
): TreePageV3 {
  return {
    pageId,
    folderId: null,
    path,
    title: pageId,
    body,
    contentHash: HASH_A,
    updatedAt: "2026-09-04T00:00:00Z",
    referencedAttachmentIds,
  };
}

describe("attachment three-way classification", () => {
  const fixtures: Array<
    [
      string,
      TreeAttachment,
      TreeAttachment,
      TreeAttachment,
      AttachmentMergeClassification["kind"],
    ]
  > = [
    [
      "same path and hash",
      attachment("a", "assets/a.png"),
      attachment("a", "assets/a.png"),
      attachment("a", "assets/a.png"),
      "bind",
    ],
    [
      "local content only",
      attachment("a", "assets/a.png"),
      attachment("a", "assets/a.png", HASH_B),
      attachment("a", "assets/a.png"),
      "take_local_version",
    ],
    [
      "remote content only",
      attachment("a", "assets/a.png"),
      attachment("a", "assets/a.png"),
      attachment("a", "assets/a.png", HASH_B),
      "take_remote_version",
    ],
    [
      "local rename only",
      attachment("a", "assets/a.png"),
      attachment("a", "assets/local.png"),
      attachment("a", "assets/a.png"),
      "rename_remote",
    ],
    [
      "remote rename only",
      attachment("a", "assets/a.png"),
      attachment("a", "assets/a.png"),
      attachment("a", "assets/remote.png"),
      "rename_local",
    ],
    [
      "different content both sides",
      attachment("a", "assets/a.png"),
      attachment("a", "assets/a.png", HASH_B),
      attachment("a", "assets/a.png", HASH_C),
      "conflict",
    ],
    [
      "different rename both sides",
      attachment("a", "assets/a.png"),
      attachment("a", "assets/local.png"),
      attachment("a", "assets/remote.png"),
      "conflict",
    ],
  ];

  it.each(fixtures)("merges %s as %s", (_name, base, local, remote, want) => {
    expect(classifyAttachmentMerge(base, local, remote).kind).toBe(want);
  });

  it("merges path and content as independent dimensions", () => {
    const result = classifyAttachmentMerge(
      attachment("a", "assets/a.png"),
      attachment("a", "assets/local.png"),
      attachment("a", "assets/a.png", HASH_B),
    );
    expect(result).toMatchObject({
      kind: "merged",
      attachment: { path: "assets/local.png", contentHash: HASH_B },
    });
  });
});

describe("mergeAttachmentsById", () => {
  it("binds a unique first local identity to the remote identity by pathKey and hash", () => {
    const plan = mergeAttachmentsById({
      base: [],
      local: [attachment("local-new", "assets/Photo.png")],
      remote: [attachment("remote-id", "assets/photo.png")],
      affectedPageIdsByAttachment: { "local-new": ["p"] },
    });
    expect(plan.identityAliases).toEqual({ "local-new": "remote-id" });
    expect(plan.attachments).toEqual([
      expect.objectContaining({ attachmentId: "remote-id" }),
    ]);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("keeps a target occupied by another identity pending", () => {
    const plan = mergeAttachmentsById({
      base: [
        attachment("a", "assets/a.png"),
        attachment("b", "assets/occupied.png"),
      ],
      local: [
        attachment("a", "assets/a.png"),
        attachment("b", "assets/occupied.png"),
      ],
      remote: [
        attachment("a", "assets/occupied.png"),
        attachment("b", "assets/occupied.png"),
      ],
      affectedPageIdsByAttachment: { a: ["p"] },
    });
    expect(plan.conflicts).toContainEqual(
      expect.objectContaining({
        attachmentId: "a",
        kind: "path_occupied",
        affectedPageIds: ["p"],
      }),
    );

    const conflictId = plan.conflicts.find(
      (item) => item.attachmentId === "a" && item.kind === "path_occupied",
    )!.conflictId;
    const resolved = mergeAttachmentsById({
      base: [
        attachment("a", "assets/a.png"),
        attachment("b", "assets/occupied.png"),
      ],
      local: [
        attachment("a", "assets/a.png"),
        attachment("b", "assets/occupied.png"),
      ],
      remote: [
        attachment("a", "assets/occupied.png"),
        attachment("b", "assets/occupied.png"),
      ],
      affectedPageIdsByAttachment: { a: ["p"] },
      resolutions: { [conflictId]: { choice: "local" } },
    });
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.attachments).toContainEqual(
      expect.objectContaining({ attachmentId: "a", path: "assets/a.png" }),
    );
  });

  it("requires a validated explicit secondary identity, path, and page split for keep-both", () => {
    const input = {
      base: [attachment("a", "assets/a.png")],
      local: [attachment("a", "assets/a.png", HASH_B)],
      remote: [attachment("a", "assets/a.png", HASH_C)],
      affectedPageIdsByAttachment: { a: ["p1", "p2"] },
    };
    const unresolved = mergeAttachmentsById(input);
    const conflictId = unresolved.conflicts[0]!.conflictId;
    const bad: Record<string, AttachmentConflictResolution> = {
      [conflictId]: {
        choice: "keep_both",
        primary: "local",
        secondaryAttachmentId: "22222222-2222-4222-8222-222222222222",
        secondaryPath: "assets/sub/name.png",
        redirectPageIds: ["p2"],
      },
    };
    expect(() => mergeAttachmentsById({ ...input, resolutions: bad })).toThrow(
      /ATTACHMENT_PATH_INVALID/,
    );
    expect(() =>
      mergeAttachmentsById({
        ...input,
        resolutions: {
          [conflictId]: {
            choice: "keep_both",
            primary: "local",
            secondaryAttachmentId: "33333333-3333-4333-8333-333333333333",
            secondaryPath: "assets/a (3).png",
            redirectPageIds: ["p1", "p2"],
          },
        },
      }),
    ).toThrow(/ATTACHMENT_REDIRECT_INVALID/);

    const plan = mergeAttachmentsById({
      ...input,
      resolutions: {
        [conflictId]: {
          choice: "keep_both",
          primary: "local",
          secondaryAttachmentId: "22222222-2222-4222-8222-222222222222",
          secondaryPath: "assets/a (2).png",
          redirectPageIds: ["p2"],
        },
      },
    });
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attachmentId: "a", contentHash: HASH_B }),
        expect.objectContaining({
          attachmentId: "22222222-2222-4222-8222-222222222222",
          path: "assets/a (2).png",
          contentHash: HASH_C,
        }),
      ]),
    );
    expect(plan.pageAttachmentRedirects).toEqual({
      p2: { a: "22222222-2222-4222-8222-222222222222" },
    });
  });

  it.each(["local", "remote"] as const)(
    "lets a later path-occupied %s choice replace an earlier keep-both proposal",
    (choice) => {
      const base = attachment("a", "assets/a.png");
      const local = attachment("a", "assets/a.png", HASH_B);
      const remote = attachment("a", "assets/a.png", HASH_C);
      const occupied = attachment("b", "assets/occupied.png");
      const resolutions: Record<string, AttachmentConflictResolution> = {
        "attachment:a:content": {
          choice: "keep_both",
          primary: "local",
          secondaryAttachmentId: "22222222-2222-4222-8222-222222222222",
          secondaryPath: "assets/occupied.png",
          redirectPageIds: ["p2"],
        },
        "attachment:a:path_occupied": { choice },
      };

      const plan = mergeAttachmentsById({
        base: [base, occupied],
        local: [local, occupied],
        remote: [remote, occupied],
        affectedPageIdsByAttachment: { a: ["p1", "p2"], b: ["q"] },
        resolutions,
      });

      const selected = choice === "local" ? local : remote;
      expect(plan.conflicts).toEqual([]);
      expect(plan.attachments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attachmentId: "a",
            path: selected.path,
            contentHash: selected.contentHash,
          }),
          expect.objectContaining({ attachmentId: "b" }),
        ]),
      );
      expect(plan.pageAttachmentRedirects).toEqual({});
    },
  );

  it("preserves a path choice when a later path-occupied choice replaces the content keep-both proposal", () => {
    const occupied = attachment("b", "assets/occupied.png");
    const input = {
      base: [attachment("a", "assets/a.png"), occupied],
      local: [attachment("a", "assets/local.png", HASH_B), occupied],
      remote: [attachment("a", "assets/remote.png", HASH_C), occupied],
      affectedPageIdsByAttachment: { a: ["p1", "p2"], b: ["q"] },
    };
    const keepBoth: AttachmentConflictResolution = {
      choice: "keep_both",
      primary: "local",
      secondaryAttachmentId: "22222222-2222-4222-8222-222222222222",
      secondaryPath: "assets/occupied.png",
      redirectPageIds: ["p2"],
    };
    const blocked = mergeAttachmentsById({
      ...input,
      resolutions: {
        "attachment:a:path": { choice: "local" },
        "attachment:a:content": keepBoth,
      },
    });
    expect(blocked.conflicts).toContainEqual(
      expect.objectContaining({
        attachmentId: "a",
        kind: "path_occupied",
      }),
    );

    const resolved = mergeAttachmentsById({
      ...input,
      resolutions: {
        "attachment:a:path": { choice: "local" },
        "attachment:a:content": keepBoth,
        "attachment:a:path_occupied": { choice: "remote" },
      },
    });

    expect(resolved.conflicts).toEqual([]);
    expect(resolved.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attachmentId: "a",
          path: "assets/local.png",
          contentHash: HASH_C,
        }),
        expect.objectContaining({ attachmentId: "b" }),
      ]),
    );
    expect(resolved.pageAttachmentRedirects).toEqual({});
  });

  it("reapplies explicit path and content choices independently", () => {
    const input = {
      base: [attachment("a", "assets/a.png")],
      local: [attachment("a", "assets/local.png", HASH_B)],
      remote: [attachment("a", "assets/remote.png", HASH_C)],
      affectedPageIdsByAttachment: { a: ["p"] },
    };
    const repeated = mergeAttachmentsById({
      ...input,
      resolutions: {
        "attachment:a:path": { choice: "remote" },
        "attachment:a:content": { choice: "local" },
      },
    });

    expect(repeated.attachments).toEqual([
      expect.objectContaining({
        path: "assets/remote.png",
        contentHash: HASH_B,
      }),
    ]);
  });

  it("detaches the identity when the final reference set is empty without a Vault delete action", () => {
    const plan = mergeAttachmentsById({
      base: [attachment("a", "assets/a.png")],
      local: [attachment("a", "assets/a.png")],
      remote: [],
      affectedPageIdsByAttachment: {},
    });
    expect(plan.attachments).toEqual([]);
    expect(plan.detachedAttachmentIds).toEqual(["a"]);
  });
});

describe("rewriteAttachmentPageReferences", () => {
  it("rewrites only parser ranges and preserves Obsidian alias and Markdown alt/title/angle style", async () => {
    const original =
      'before ![[assets/a.png|320]] middle ![alt](<../../../assets/a.png> "title") after';
    const result = await rewriteAttachmentPageReferences({
      page: page("p", "pages/old/deep/P.md", original, ["a"]),
      sourcePath: "pages/old/deep/P.md",
      sourceAttachments: [attachment("a", "assets/a.png")],
      finalPath: "pages/new/P.md",
      finalAttachments: [attachment("a", "assets/renamed.png")],
      redirects: {},
    });
    expect(result.blockers).toEqual([]);
    expect(result.page.body).toBe(
      'before ![[assets/renamed.png|320]] middle ![alt](<../../assets/renamed.png> "title") after',
    );
    expect(result.page.referencedAttachmentIds).toEqual(["a"]);
  });

  it("recomputes a standard Markdown target after only the Page location changes", async () => {
    const result = await rewriteAttachmentPageReferences({
      page: page("p", "pages/deep/P.md", "![x](../../assets/a.png)", ["a"]),
      sourcePath: "pages/deep/P.md",
      sourceAttachments: [attachment("a", "assets/a.png")],
      finalPath: "pages/P.md",
      finalAttachments: [attachment("a", "assets/a.png")],
      redirects: {},
    });
    expect(result.page.body).toBe("![x](../assets/a.png)");
  });

  it("keeps a rewritten Markdown path with spaces parseable without changing angle style", async () => {
    const result = await rewriteAttachmentPageReferences({
      page: page("p", "pages/P.md", "![x](../assets/a.png)", ["a"]),
      sourcePath: "pages/P.md",
      sourceAttachments: [attachment("a", "assets/a.png")],
      finalPath: "pages/P.md",
      finalAttachments: [attachment("a", "assets/a (2).png")],
      redirects: {},
    });
    expect(result.blockers).toEqual([]);
    expect(result.page.body).toBe("![x](../assets/a%20(2).png)");
  });

  it("preserves backslash-escaped Markdown destination style", async () => {
    const result = await rewriteAttachmentPageReferences({
      page: page("p", "pages/P.md", "![x](../assets/a\\ name.png)", ["a"]),
      sourcePath: "pages/P.md",
      sourceAttachments: [attachment("a", "assets/a name.png")],
      finalPath: "pages/P.md",
      finalAttachments: [attachment("a", "assets/b name.png")],
      redirects: {},
    });
    expect(result.blockers).toEqual([]);
    expect(result.page.body).toBe("![x](../assets/b\\ name.png)");
  });

  it("preserves percent-encoded Markdown destination style after extraction", async () => {
    const result = await rewriteAttachmentPageReferences({
      page: page("p", "pages/P.md", "![x](../assets/a%20name.png)", ["a"]),
      sourcePath: "pages/P.md",
      sourceAttachments: [attachment("a", "assets/a name.png")],
      finalPath: "pages/P.md",
      finalAttachments: [attachment("a", "assets/b name.png")],
      redirects: {},
    });

    expect(result.blockers).toEqual([]);
    expect(result.page.body).toBe("![x](../assets/b%20name.png)");
  });

  it("leaves unrelated bytes exact and blocks a source range that cannot bind to the declared identity", async () => {
    const body = "prefix ![[assets/other.png|alias]] suffix\n";
    const result = await rewriteAttachmentPageReferences({
      page: page("p", "pages/P.md", body, ["a"]),
      sourcePath: "pages/P.md",
      sourceAttachments: [attachment("a", "assets/a.png")],
      finalPath: "pages/P.md",
      finalAttachments: [attachment("a", "assets/renamed.png")],
      redirects: {},
    });
    expect(result.page.body).toBe(body);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: "ATTACHMENT_SOURCE_RANGE_MISMATCH" }),
    );
  });
});
