export interface RateLimiterOptions {
  /** Requests allowed per second (Notion average limit is 3 req/s; default 2.8 for safety). */
  requestsPerSecond?: number;
  /** Maximum retries on HTTP 429 or 5xx. */
  maxRetries?: number;
  /** Base backoff delay in ms for retries when Retry-After is absent. */
  baseRetryDelayMs?: number;
  /** Injectable sleep function for fast deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextAvailableTime = 0;

  constructor(options: RateLimiterOptions = {}) {
    const rps = options.requestsPerSecond ?? 2.8;
    this.minIntervalMs = rps > 0 ? Math.ceil(1000 / rps) : 0;
    this.maxRetries = options.maxRetries ?? 5;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  private async acquireSlot(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    const scheduled = Math.max(now, this.nextAvailableTime);
    this.nextAvailableTime = scheduled + this.minIntervalMs;
    const waitMs = scheduled - now;
    if (waitMs > 0) {
      await this.sleep(waitMs);
    }
  }

  async schedule<T>(
    fn: () => Promise<{ status: number; retryAfterSeconds?: number; value?: T; error?: Error }>
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      await this.acquireSlot();
      const result = await fn();
      const isRetryable = result.status === 429 || (result.status >= 500 && result.status < 600);
      if (!isRetryable || attempt >= this.maxRetries) {
        if (result.error) {
          throw result.error;
        }
        return result.value as T;
      }

      attempt += 1;
      const retryDelayMs =
        result.retryAfterSeconds !== undefined && !Number.isNaN(result.retryAfterSeconds)
          ? Math.max(100, Math.ceil(result.retryAfterSeconds * 1000))
          : this.baseRetryDelayMs * Math.pow(2, attempt - 1);

      await this.sleep(retryDelayMs);
    }
  }
}
