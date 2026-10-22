import { HttpError } from "./errors";

export interface RetryOptions {
  /** Retries after the first attempt. */
  retries: number;
  /** Delay before the first retry; doubles on each further retry. */
  delayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying server errors (5xx) and network failures with
 * exponential backoff. Client errors (4xx) are thrown immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (err instanceof HttpError && err.status < 500) throw err;
      if (attempt < opts.retries) await sleep(opts.delayMs * 2 ** attempt);
    }
  }
  throw lastError;
}
