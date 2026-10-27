export interface RateLimitDecision {
    ok: boolean;
    /** 0 when the request is allowed. */
    retryAfterMs: number;
}

/**
 * Single-operator limiter: the server is meant for one desktop operator, so a
 * global window is enough. It keeps the app from turning a manual console into
 * a spam loop, which is where TikTok/Euler limits would otherwise be hit.
 */
export class RateLimiter {

    private readonly hits: number[] = [];

    constructor(
        private readonly minIntervalMs: number,
        private readonly maxPerMinute: number,
        private readonly now: () => number = Date.now
    ) {}

    take(): RateLimitDecision {
        const now = this.now();
        this.prune(now);

        if (this.hits.length >= this.maxPerMinute) {
            const oldest = this.hits[0];
            return { ok: false, retryAfterMs: Math.max(0, oldest + 60_000 - now) };
        }

        const last = this.hits[this.hits.length - 1];
        if (last !== undefined && now - last < this.minIntervalMs) {
            return { ok: false, retryAfterMs: this.minIntervalMs - (now - last) };
        }

        this.hits.push(now);
        return { ok: true, retryAfterMs: 0 };
    }

    private prune(now: number): void {
        const cutoff = now - 60_000;
        while (this.hits.length > 0 && this.hits[0] <= cutoff) {
            this.hits.shift();
        }
    }

}
