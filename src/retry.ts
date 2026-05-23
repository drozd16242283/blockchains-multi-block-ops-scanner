export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
}

export const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 4,
  baseDelayMs: 50,
  maxDelayMs: 1_000,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Bounded exponential backoff. Surfaces the last error if all attempts fail.
 *
 * In production this would be paired with a circuit breaker around the RPC client
 * and a metric for retry counts so we can alert on a flapping node.
 *
 * Or switching to a backup node in case of main node unreliable.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryConfig = DEFAULT_RETRY): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === opts.maxAttempts) break;
      const delay = Math.min(opts.baseDelayMs * 2 ** (attempt - 1), opts.maxDelayMs ?? Infinity);
      await sleep(delay);
    }
  }
  throw lastErr;
}
