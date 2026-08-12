/**
 * A per-address budget for requests that arrive with no valid credential.
 *
 * What this is for: before this, `login` and the OIDC handshake were throttled
 * and nothing else was, so every other public route could be hammered for free.
 * The client address only became trustworthy behind a proxy once
 * COMPANION_TRUSTED_PROXIES existed, which is what makes a per-address budget
 * meaningful rather than a single shared bucket for the whole internet.
 *
 * What it deliberately does NOT do: limit authenticated traffic. An account is
 * accountable and revocable, the SPA polls, and CLI/MCP clients burst; a blanket
 * cap there would break legitimate use to mitigate a threat that session
 * revocation already answers. Per-endpoint cost control is a different problem.
 *
 * Fixed window rather than a sliding one: a caller straddling a boundary can
 * spend up to two windows back to back, which is the accepted cost of holding
 * one counter per address instead of one timestamp per request. This is a flood
 * guard, not an accounting system, and the login throttle remains the tighter,
 * principal-aware layer above it.
 */

const WINDOW_MS = 60_000;
/** Bounded so a flood from many spoofed-looking addresses cannot grow the map without limit. */
const MAX_KEYS = 10_000;

interface Window {
  count: number;
  startedAt: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  /** `perMinute` of 0 disables the limiter outright. */
  constructor(private readonly perMinute: number) {}

  get enabled(): boolean {
    return this.perMinute > 0;
  }

  /** Seconds to wait, or 0 when the request fits in the current budget. */
  check(key: string, now: number = Date.now()): number {
    if (!this.enabled) return 0;
    const existing = this.windows.get(key);
    const window =
      existing && now - existing.startedAt < WINDOW_MS ? existing : { count: 0, startedAt: now };
    window.count += 1;
    this.windows.set(key, window);
    if (this.windows.size > MAX_KEYS) this.evict(now);
    if (window.count <= this.perMinute) return 0;
    return Math.max(1, Math.ceil((window.startedAt + WINDOW_MS - now) / 1000));
  }

  /** Drop expired windows first; only if that is not enough, the oldest ones. */
  private evict(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= WINDOW_MS) this.windows.delete(key);
    }
    if (this.windows.size <= MAX_KEYS) return;
    const oldest = [...this.windows.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt);
    for (const [key] of oldest.slice(0, this.windows.size - MAX_KEYS)) this.windows.delete(key);
  }
}
