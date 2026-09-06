import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["verification/**/*.live.ts"],
    testTimeout: 60_000,
  },
});
