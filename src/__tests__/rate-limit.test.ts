import { describe, expect, test } from "bun:test";
import { RATE_LIMIT_PATTERN, extractRateLimitMessage } from "../rate-limit";

describe("RATE_LIMIT_PATTERN — credit/limit detection (queue, don't fail)", () => {
  // The subscription-cap phrasings that were always caught.
  test.each([
    "You've hit your limit · resets 1:50am",
    "you've hit your usage limit",
    "You've hit your session limit",
    "You are out of extra usage for this period",
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
