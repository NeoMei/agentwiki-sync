import { describe, expect, it } from "vitest";
import {
  progressCheckpoint,
  progressLabel,
} from "../../src/application/progress";

describe("sync operation progress", () => {
  it("reports checkpoints and honors cancellation only at safe boundaries", async () => {
    expect(
      progressLabel({
        phase: "download",
        completed: 50,
        total: 100,
        cancellable: true,
      }),
    ).toBe("下载 50 / 100");
    const controller = new AbortController();
    const seen: unknown[] = [];
    const options = {
      signal: controller.signal,
      onProgress: (value: unknown) => seen.push(value),
    };
    await progressCheckpoint(options, {
      phase: "scan",
      completed: 50,
      total: 100,
      cancellable: true,
    });
    expect(seen).toEqual([
      { phase: "scan", completed: 50, total: 100, cancellable: true },
    ]);

    controller.abort();
    await expect(
      progressCheckpoint(options, {
        phase: "download",
        completed: 1,
        cancellable: true,
      }),
    ).rejects.toThrow(/取消/);
    await expect(
      progressCheckpoint(options, {
        phase: "apply",
        completed: 0,
        cancellable: false,
      }),
    ).resolves.toBeUndefined();
  });
});
