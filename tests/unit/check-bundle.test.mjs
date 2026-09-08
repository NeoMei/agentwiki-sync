import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execPath } from "node:process";
import { expect, it } from "vitest";

// Exercise the build-time Node script through the existing Vitest mjs glob.
const execute = promisify(execFile);
const script = resolve("scripts/check-bundle.mjs");

it.each([
  {
    name: "exact UTF-8 byte limit",
    source: "界".repeat(666_666) + "aa",
    bytes: 2_000_000,
    accepted: true,
  },
  {
    name: "non-ASCII bytes above limit",
    source: "界".repeat(666_667),
    bytes: 2_000_001,
    accepted: false,
  },
])(
  "checks physical bundle bytes at $name",
  async ({ source, bytes, accepted }) => {
    const dir = await mkdtemp(join(tmpdir(), "agentwiki-bundle-test-"));
    try {
      await writeFile(join(dir, "main.js"), source);
      const result = execute(execPath, [script], { cwd: dir });
      if (accepted)
        await expect(result).resolves.toMatchObject({
          stdout: `Bundle safety check passed (${bytes} bytes)\n`,
        });
      else {
        const error = await result.catch((failure) => failure);
        expect(error).toMatchObject({ code: 1 });
        expect(error.stderr).toContain(`main.js exceeds 2 MB (${bytes} bytes)`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
