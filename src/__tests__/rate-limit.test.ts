import { describe, expect, test } from "bun:test";
import {
  RATE_LIMIT_HOLD_CAP_MS,
  RATE_LIMIT_PATTERN,
  RATE_LIMIT_RESET_PATTERN,
  clearRateLimit,
  clearRateLimitDetected,
  extractRateLimitMessage,
  isRateLimited,
  parseRateLimitResetTime,
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

describe("RATE_LIMIT_RESET_PATTERN — reset time extraction", () => {
  // Bug 1 fix: the pattern must match bare am/pm times WITHOUT requiring "UTC".
  test.each([
    "You've hit your limit · resets 1:50am",
    "resets 3pm",
    "Resets 12:30 AM",
    "Your limit resets 11pm",
  ])("matches bare am/pm time: %s", (msg) => {
    expect(RATE_LIMIT_RESET_PATTERN.test(msg)).toBe(true);
  });

  test("also matches when UTC is present (backwards compat)", () => {
    expect(RATE_LIMIT_RESET_PATTERN.test("resets 3pm (UTC)")).toBe(true);
    expect(RATE_LIMIT_RESET_PATTERN.test("resets 1:50am UTC")).toBe(true);
  });
});

describe("parseRateLimitResetTime — honors the message's stated timezone (UTC default)", () => {
  const wallClock = (epoch: number, timeZone: string): string =>
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(
      new Date(epoch),
    );

  test("returns null when no time in message", () => {
    expect(parseRateLimitResetTime("You've hit your usage limit")).toBeNull();
    expect(parseRateLimitResetTime("")).toBeNull();
  });

  // THE real Claude message — reports the reset in UTC. The epoch must decode to
  // 22:10 UTC, NOT 05:10 UTC (the old bug treated it as Pacific and added ~7h).
  test("'resets 10:10pm (UTC)' → 22:10 UTC (the actual session-limit format)", () => {
    const r = parseRateLimitResetTime("You've hit your session limit · resets 10:10pm (UTC)");
    expect(r).not.toBeNull();
    expect(wallClock(r!, "UTC")).toBe("22:10");
  });

  test("no timezone stated → defaults to UTC (Claude's format)", () => {
    expect(wallClock(parseRateLimitResetTime("Your limit resets 1:50am")!, "UTC")).toBe("01:50");
    expect(wallClock(parseRateLimitResetTime("resets 3pm")!, "UTC")).toBe("15:00");
    expect(wallClock(parseRateLimitResetTime("resets 1:50am UTC")!, "UTC")).toBe("01:50");
  });

  // Only when the message EXPLICITLY says Pacific do we convert (DST-aware).
  test("'resets 3pm (PDT)' → 15:00 Pacific (explicit-Pacific path, DST-correct)", () => {
    const r = parseRateLimitResetTime("resets 3pm (PDT)");
    expect(r).not.toBeNull();
    expect(wallClock(r!, "America/Los_Angeles")).toBe("15:00");
  });

  test("reset time is always in the future (rolls to tomorrow if passed)", () => {
    const now = Date.now();
    expect(parseRateLimitResetTime("resets 12:00am")!).toBeGreaterThan(now);
  });

  test("am/pm conversion: 12am → 00:00 UTC, 12pm → 12:00 UTC", () => {
    expect(wallClock(parseRateLimitResetTime("resets 12pm")!, "UTC")).toBe("12:00");
    expect(wallClock(parseRateLimitResetTime("resets 12am")!, "UTC")).toBe("00:00");
  });

  // Model-cap messages carry an explicit DATE that can be days out — the time
  // must land on that date, not "today/tomorrow".
  test("'resets Jun 20, 6pm (UTC)' → the 20th at 18:00 UTC", () => {
    const r = parseRateLimitResetTime("You've hit your Sonnet limit · resets Jun 20, 6pm (UTC)");
    expect(r).not.toBeNull();
    const d = new Date(r!);
    expect(d.getUTCMonth()).toBe(5); // June (0-based)
    expect(d.getUTCDate()).toBe(20);
    expect(wallClock(r!, "UTC")).toBe("18:00");
  });

  test("'resets June 20 6:30am' (no comma) parses date + time", () => {
    const r = parseRateLimitResetTime("resets June 20 6:30am");
    expect(r).not.toBeNull();
    const d = new Date(r!);
    expect(d.getUTCMonth()).toBe(5);
    expect(d.getUTCDate()).toBe(20);
    expect(wallClock(r!, "UTC")).toBe("06:30");
  });
});

describe("clearRateLimit — a successful run clears a stale hold", () => {
  test("recordRateLimit holds; clearRateLimit releases it so isRateLimited is false", () => {
    // A real future reset (so isRateLimited would otherwise stay true).
    recordRateLimit("You've hit your session limit · resets 11:59pm (UTC)");
    expect(isRateLimited()).toBe(true);
    // A clean run succeeded → API recovered → clear the hold.
    clearRateLimit();
    expect(isRateLimited()).toBe(false);
  });
});

describe("recordRateLimit + wasRateLimitDetected", () => {
  test("explicit reset → returns epoch, sets rateLimitResetAt (isRateLimited=true)", () => {
    // We can't directly call isRateLimited here without side effects on the
    // global singleton, but we CAN verify the return value is a future epoch.
    clearRateLimitDetected();
    const msg = "You've hit your usage limit · resets 3pm";
    const result = recordRateLimit(msg);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(Date.now());
    // wasRateLimitDetected must be true after recordRateLimit
    expect(wasRateLimitDetected()).toBe(true);
  });

  test("caps a FAR reset at RATE_LIMIT_HOLD_CAP_MS (no multi-hour freeze)", () => {
    // "resets 11:59pm (UTC)" can be hours out. Honoring it froze both queue
    // drains for the whole window ("resuming 15:10"); the hold must be capped.
    clearRateLimitDetected();
    const before = Date.now();
    const result = recordRateLimit("You've hit your session limit · resets 11:59pm (UTC)");
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(before);
    expect(result!).toBeLessThanOrEqual(Date.now() + RATE_LIMIT_HOLD_CAP_MS);
    clearRateLimit();
  });

  // Bug 2 fix: no explicit reset must NOT default to +1 hour.
  test("no parseable reset → returns null (no +1h block)", () => {
    clearRateLimitDetected();
    const msg = "You've hit your usage limit"; // no reset time
    const result = recordRateLimit(msg);
    expect(result).toBeNull();
    // rateLimitResetAt is 0, so isRateLimited() returns false → queue can drain.
    // wasRateLimitDetected lets callers detect the transient condition.
    expect(wasRateLimitDetected()).toBe(true);
  });

  test("clearRateLimitDetected resets the flag", () => {
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
