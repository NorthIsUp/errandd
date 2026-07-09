import { describe, expect, test } from "bun:test";
import {
  RATE_LIMIT_PATTERN,
  clearRateLimit,
  clearRateLimitDetected,
  extractRateLimitMessage,
  fibBackoffMs,
  isRateLimited,
  recordRateLimit,
  wasRateLimitDetected,
} from "../rate-limit";

describe("RATE_LIMIT_PATTERN — credit/limit detection (queue, don't fail)", () => {
  // The subscription-cap phrasings that were always caught.
  test.each([
    "You've hit your limit · resets 1:50am",
    "you've hit your usage limit",
    "You've hit your session limit",
    "You are out of extra usage for this period",
    // MODEL-SPECIFIC caps — the prior pattern missed these, so the daemon never
    // deferred and burned the retry budget against the exhausted quota.
    "You've hit your Sonnet limit · resets Jun 20, 6pm (UTC)",
    "You've hit your Opus limit · resets 11pm",
    "you've hit your sonnet limit",
  ])("subscription cap: %s", (msg) => {
    expect(RATE_LIMIT_PATTERN.test(msg)).toBe(true);
  });

  // The generalized "out of credits" / API-billing phrasings — these used to
  // fall through to fail-after-cap; now they defer-and-queue.
  test.each([
    "Your credit balance is too low to access the Anthropic API",
    "Error: insufficient credits remaining",
    "out of credits",
    "Usage limit reached for this organization",
    "usage limit exceeded",
  ])("credit/billing limit: %s", (msg) => {
    expect(RATE_LIMIT_PATTERN.test(msg)).toBe(true);
  });

  // Ordinary failures must NOT be mistaken for a limit (they should retry/fail
  // on their own backoff, not defer indefinitely waiting for "credits").
  test.each([
    "TypeError: cannot read property 'x' of undefined",
    "fatal: not a git repository",
    "the credit card on file was declined",
  ])("non-limit failure: %s", (msg) => {
    expect(RATE_LIMIT_PATTERN.test(msg)).toBe(false);
  });

  test("extractRateLimitMessage returns the matching stream, else null", () => {
    expect(
      extractRateLimitMessage("Your credit balance is too low", ""),
    ).toContain("credit balance is too low");
    expect(extractRateLimitMessage("all good", "warning: noise")).toBeNull();
  });
});

describe("fibBackoffMs — Fibonacci seconds *1000, capped at 30s", () => {
  // Classic Fibonacci delays in SECONDS: 1, 1, 2, 3, 5, 8, 13, 21, then 30 (cap).
  test.each([
    [1, 1_000],
    [2, 1_000],
    [3, 2_000],
    [4, 3_000],
    [5, 5_000],
    [6, 8_000],
    [7, 13_000],
    [8, 21_000],
    [9, 30_000], // fib(9)=34 → capped
    [10, 30_000],
    [50, 30_000],
  ])("attempt %i → %ims", (attempt, expected) => {
    expect(fibBackoffMs(attempt)).toBe(expected);
  });

  test("attempt <= 0 clamps to attempt 1 (1s)", () => {
    expect(fibBackoffMs(0)).toBe(1_000);
    expect(fibBackoffMs(-5)).toBe(1_000);
  });

  test("never exceeds the 30s cap", () => {
    for (let a = 1; a <= 100; a++) {
      expect(fibBackoffMs(a)).toBeLessThanOrEqual(30_000);
    }
  });
});

describe("recordRateLimit — sets a short fib hold", () => {
  test("first hit → hold ~1s out, always returns a future epoch, sets detected", () => {
    clearRateLimit();
    clearRateLimitDetected();
    const before = Date.now();
    const resetAt = recordRateLimit("You've hit your usage limit · resets 3pm");
    // Always a number now (no more null "no reset" path).
    expect(typeof resetAt).toBe("number");
    expect(resetAt).toBeGreaterThan(before);
    // First consecutive hit → fib(1) = 1000ms.
    expect(resetAt - before).toBeLessThanOrEqual(1_000 + 50); // small tolerance
    expect(isRateLimited()).toBe(true);
    expect(wasRateLimitDetected()).toBe(true);
  });

  test("consecutive hits increment the counter → longer fib holds (1,1,2,3,5s)", () => {
    clearRateLimit();
    const holdMs = () => {
      const now = Date.now();
      return recordRateLimit("out of credits") - now;
    };
    // fib sequence in seconds: 1, 1, 2, 3, 5 for hits 1..5
    expect(holdMs()).toBeGreaterThanOrEqual(1_000 - 50); // hit 1 → 1s
    expect(holdMs()).toBeGreaterThanOrEqual(1_000 - 50); // hit 2 → 1s
    const h3 = holdMs(); // hit 3 → 2s
    expect(h3).toBeGreaterThanOrEqual(2_000 - 50);
    expect(h3).toBeLessThanOrEqual(2_000 + 50);
    const h4 = holdMs(); // hit 4 → 3s
    expect(h4).toBeGreaterThanOrEqual(3_000 - 50);
    expect(h4).toBeLessThanOrEqual(3_000 + 50);
    const h5 = holdMs(); // hit 5 → 5s
    expect(h5).toBeGreaterThanOrEqual(5_000 - 50);
    expect(h5).toBeLessThanOrEqual(5_000 + 50);
  });

  test("clearRateLimitDetected resets only the per-run detection flag", () => {
    recordRateLimit("out of credits");
    expect(wasRateLimitDetected()).toBe(true);
    clearRateLimitDetected();
    expect(wasRateLimitDetected()).toBe(false);
  });

  test("no recordRateLimit call → wasRateLimitDetected is false after clear", () => {
    clearRateLimitDetected();
    expect(wasRateLimitDetected()).toBe(false);
  });
});

describe("counter reset semantics", () => {
  test("clearRateLimit releases the hold AND resets the consecutive counter", () => {
    clearRateLimit();
    // Build the counter up a few hits.
    recordRateLimit("out of credits");
    recordRateLimit("out of credits");
    recordRateLimit("out of credits"); // counter now 3
    expect(isRateLimited()).toBe(true);
    // A clean run succeeded → clear the hold and reset backoff to fib(1).
    clearRateLimit();
    expect(isRateLimited()).toBe(false);
    // Next hit should start fresh at fib(1) = 1s, proving the counter reset.
    const now = Date.now();
    const resetAt = recordRateLimit("out of credits");
    expect(resetAt - now).toBeLessThanOrEqual(1_000 + 50);
  });

  test("isRateLimited release (hold expired) resets the consecutive counter", async () => {
    clearRateLimit();
    recordRateLimit("out of credits"); // counter 1 → fib(1)=1s hold
    recordRateLimit("out of credits"); // counter 2 → fib(2)=1s hold
    expect(isRateLimited()).toBe(true);
    // Wait out the (<=1s) hold; the fib(2) step is exactly 1000ms.
    await new Promise((r) => setTimeout(r, 1_100));
    // Expiry branch fires: clears the hold AND resets the counter to 0.
    expect(isRateLimited()).toBe(false);
    // Proof the counter reset: the next hit restarts at fib(1) = 1s, not fib(3).
    const now = Date.now();
    const resetAt = recordRateLimit("out of credits");
    expect(resetAt - now).toBeLessThanOrEqual(1_000 + 50);
    clearRateLimit();
  });
});
