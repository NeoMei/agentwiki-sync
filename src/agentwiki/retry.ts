import { AgentWikiHttpError } from "./client";

export interface RetryPolicy {
  maxAttempts: number;
  maxElapsedMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  maxElapsedMs: 30_000,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};
export function isRetryableReadError(error: unknown): boolean {
  if (error instanceof AgentWikiHttpError)
    return error.status === 429 || error.status >= 500;
  if (
    error instanceof TypeError ||
    (error instanceof Error && error.name === "ZodError")
  )
    return false;
  return true;
}
function retryAfterMs(error: unknown): number | null {
  if (!(error instanceof AgentWikiHttpError)) return null;
  const value = Object.entries(error.headers).find(
    ([key]) => key.toLowerCase() === "retry-after",
  )?.[1];
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}
export async function retryRead<T>(
  operation: () => Promise<T>,
  policy = DEFAULT_RETRY_POLICY,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  const started = Date.now();
  let last: unknown;
  for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      last = error;
      if (!isRetryableReadError(error) || attempt + 1 >= policy.maxAttempts)
        throw error;
      const delay = Math.min(
        policy.maxDelayMs,
        retryAfterMs(error) ?? policy.baseDelayMs * 2 ** attempt,
      );
      if (Date.now() - started + delay > policy.maxElapsedMs) throw error;
      await sleep(delay);
    }
  }
  throw last;
}
