import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("repository test collection", () => {
  it("keeps recovery evidence outside both Vitest and ESLint collection", async () => {
    const [vitestConfig, eslintConfig] = await Promise.all([
      readFile(new URL("../../vitest.config.ts", import.meta.url), "utf8"),
      readFile(new URL("../../eslint.config.mjs", import.meta.url), "utf8"),
    ]);

    expect(vitestConfig).toContain(
      'include: ["tests/**/*.{test,spec}.?(c|m)[jt]s?(x)"]',
    );
    expect(eslintConfig).toContain('".superpowers/**"');
  });
});
