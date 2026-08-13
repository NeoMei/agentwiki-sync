import { describe, expect, it } from "vitest";
import { buildInitialBindingPreview } from "../../src/core/initial-binding";

describe("initial binding", () => {
  it("clones a remote-only page cleanly", () => {
    const preview = buildInitialBindingPreview(
      [],
      [
        {
          pageId: "remote",
          path: "Guide.md",
          title: "Remote title",
          body: "remote",
          contentHash: "h",
        },
      ],
    );
    expect(preview.base).toHaveLength(1);
    expect(preview.vault[0]?.relativePath).toBe("Guide.md");
    expect(preview.dirty).toHaveLength(0);
  });

  it("keeps explicit cross-path local choices dirty while base remains remote", () => {
    const preview = buildInitialBindingPreview(
      [
        {
          relativePath: "Local.md",
          title: "Local",
          normalizedBody: "local",
          contentHash: "l",
          vaultByteHash: "v",
        },
      ],
      [
        {
          pageId: "remote",
          path: "Remote.md",
          title: "Remote",
          body: "remote",
          contentHash: "r",
        },
      ],
      [
        {
          localPath: "Local.md",
          remotePageId: "remote",
          finalPath: "Local.md",
          finalBody: "local",
        },
      ],
    );
    expect(preview.base[0]).toMatchObject({
      pageId: "remote",
      relativePath: "Remote.md",
      title: "Remote",
    });
    expect(preview.vault[0]).toMatchObject({
      pageId: "remote",
      relativePath: "Local.md",
      title: "Local",
    });
    expect(preview.dirty).toEqual(["remote"]);
  });
});
