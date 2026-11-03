// Failed-login limiter, in memory (single API instance in version 1): 10 attempts per 15 minutes.
export class AttemptLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  private recent(key: string): number[] {
    const now = Date.now();
    const list = (this.attempts.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.attempts.set(key, list);
    return list;
  }

  isBlocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }

  fail(key: string): void {
    this.recent(key).push(Date.now());
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }
}
