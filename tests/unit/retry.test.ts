import { describe, expect, it } from "vitest";
import { retryRead } from "../../src/agentwiki/retry";
import { AgentWikiHttpError } from "../../src/agentwiki/client";
describe("endpoint retry", () => {
  it("retries transient reads with a bounded budget", async () => {
    let calls = 0;
    const value = await retryRead(
      async () => {
        calls += 1;
        if (calls < 3) throw new AgentWikiHttpError(500, {});
        return "ok";
      },
      { maxAttempts: 3, maxElapsedMs: 30_000, baseDelayMs: 1, maxDelayMs: 1 },
      async () => undefined,
    );
    expect(value).toBe("ok");
    expect(calls).toBe(3);
  });
  it("does not retry terminal client errors", async () => {
    let calls = 0;
    await expect(
      retryRead(
        async () => {
          calls += 1;
          throw new AgentWikiHttpError(403, {});
        },
        undefined,
        async () => undefined,
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
