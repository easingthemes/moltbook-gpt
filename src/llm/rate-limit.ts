/**
 * Simple in-memory rate limiter for OpenAI calls.
 */
export interface RateLimiterConfig {
  maxCallsPerMinute: number;
}

export class RateLimiter {
  private readonly maxCallsPerMinute: number;
  private timestamps: number[] = [];

  constructor(config: RateLimiterConfig) {
    this.maxCallsPerMinute = config.maxCallsPerMinute;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    const oneMinuteAgo = now - 60 * 1000;
    this.timestamps = this.timestamps.filter((t) => t > oneMinuteAgo);
    if (this.timestamps.length >= this.maxCallsPerMinute) {
      const oldest = this.timestamps[0];
      const waitMs = oldest + 60 * 1000 - now;
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return this.acquire();
      }
    }
    this.timestamps.push(Date.now());
  }
}
