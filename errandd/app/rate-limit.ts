// Rate-limit singleton state + detection helpers, extracted from runner.ts.
//
// The module-level `rateLimitResetAt` / `rateLimitNotified` pair is a
// process-global singleton. Callers in runner.ts read/write it through these
// helpers.
//
// Backoff strategy: retries happen on a SHORT timer — Fibonacci backoff in
// SECONDS, capped at 30s. We do NOT parse a wall-clock "resets 3:10pm" reset
// time anymore. That parsing caused multi-minute/hour freezes: both queue
// drains early-returned while isRateLimited(), and isRateLimited() stayed true
// until the far parsed reset. Instead we hold for fib(consecutiveHits) seconds
// and try again — a recovered API resumes within seconds, and a still-limited
// API just re-defers on the next (longer) fib step.

// Any "you can't run right now because of capacity/billing" signal — a
// subscription usage cap OR a depleted API credit balance. All of these mean the
// SAME thing for the queue: don't fail the work and burn its retry budget; defer
// it on a short fib timer and try again.
// The "you can't run right now" signals. NOTE the `(?:[\w-]+ )?` before `limit`:
// Claude now sends MODEL-SPECIFIC caps — "You've hit your Sonnet limit", "...Opus
// limit" — as well as the older "usage limit" / "session limit" / bare "limit".
export const RATE_LIMIT_PATTERN =
  /you(?:'|')ve hit your (?:[\w-]+ )?limit|out of extra usage|(?:usage|sonnet|opus|rate) limit (?:reached|exceeded)|credit balance is too low|insufficient credits|out of credits|billing.{0,20}(?:hard limit|quota) reached/i;

// --- Rate limit state ---
let rateLimitResetAt = 0; // epoch ms; 0 = not rate-limited
let rateLimitNotified = false;
/** Set to true inside recordRateLimit(); cleared by clearRateLimitDetected().
 *  Lets callers know whether the most-recent run hit a rate-limit message. */
let rateLimitDetectedLastRun = false;
/** Count of CONSECUTIVE rate-limit hits. Drives the fib backoff step. Reset to
 *  0 when the hold releases (isRateLimited) or a clean run succeeds
 *  (clearRateLimit) so a recovered API restarts backoff at fib(1). */
let consecutiveRateLimits = 0;

/**
 * Fibonacci backoff in milliseconds for a given attempt (>= 1).
 *
 * Classic Fibonacci delays in SECONDS: 1, 1, 2, 3, 5, 8, 13, 21, then 30 (the
 * cap) for every further attempt. Returned as milliseconds, capped at 30_000.
 * attempt <= 0 clamps to attempt 1.
 */
export function fibBackoffMs(attempt: number): number {
  const n = attempt <= 0 ? 1 : Math.floor(attempt);
  // Fibonacci sequence F(1)=1, F(2)=1, F(3)=2, F(4)=3, F(5)=5, F(6)=8, ...
  // Seed prev=F(0)=0, curr=F(1)=1 so attempt=1→1s, attempt=2→1s (the second 1).
  let prev = 0;
  let curr = 1;
  for (let i = 1; i < n; i++) {
    const next = prev + curr;
    prev = curr;
    curr = next;
    if (curr * 1000 >= 30_000) return 30_000; // early cap
  }
  return Math.min(curr * 1000, 30_000);
}

export function isRateLimited(): boolean {
  if (rateLimitResetAt === 0) return false;
  if (Date.now() >= rateLimitResetAt) {
    rateLimitResetAt = 0;
    rateLimitNotified = false;
    consecutiveRateLimits = 0;
    return false;
  }
  return true;
}

export function getRateLimitResetAt(): number {
  return rateLimitResetAt;
}

export function wasRateLimitNotified(): boolean {
  return rateLimitNotified;
}

export function markRateLimitNotified(): void {
  rateLimitNotified = true;
}

/**
 * Record a freshly-detected rate limit. Increments the consecutive-hit counter
 * and sets a SHORT fib backoff hold: rateLimitResetAt = now + fibBackoffMs(n),
 * where n is the number of consecutive hits (1, 1, 2, 3, 5, 8, ... seconds,
 * capped at 30s). Marks rateLimitDetectedLastRun so callers can distinguish a
 * rate limit from an ordinary failure, and clears the notified flag.
 *
 * Always returns the (future) rateLimitResetAt epoch ms.
 */
export function recordRateLimit(_message: string): number {
  consecutiveRateLimits += 1;
  rateLimitResetAt = Date.now() + fibBackoffMs(consecutiveRateLimits);
  rateLimitDetectedLastRun = true;
  rateLimitNotified = false;
  return rateLimitResetAt;
}

/**
 * Reset the per-run detection flag. Call this at the START of each queued-
 * batch run so wasRateLimitDetected() accurately reflects only the current run.
 */
export function clearRateLimitDetected(): void {
  rateLimitDetectedLastRun = false;
}

/**
 * Clear the rate-limit HOLD (rateLimitResetAt → 0) and reset the consecutive
 * counter so backoff restarts at fib(1). Call when a Claude run SUCCEEDS with no
 * rate-limit message: a success proves the API is available again, so the queue
 * must not keep deferring, and the next limit (if any) should start fresh.
 */
export function clearRateLimit(): void {
  rateLimitResetAt = 0;
  rateLimitNotified = false;
  consecutiveRateLimits = 0;
}

/**
 * True when recordRateLimit() was called since the last clearRateLimitDetected().
 * Combined with !isRateLimited(), this identifies a "transient rate limit".
 */
export function wasRateLimitDetected(): boolean {
  return rateLimitDetectedLastRun;
}

export function extractRateLimitMessage(stdout: string, stderr: string): string | null {
  const candidates = [stdout, stderr];
  for (const text of candidates) {
    const trimmed = text.trim();
    if (trimmed && RATE_LIMIT_PATTERN.test(trimmed)) return trimmed;
  }
  return null;
}
