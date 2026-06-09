import { describe, test, expect } from "bun:test";

// P0-15: the AI thread-intent classifier must be OFF by default and only
// activate via an explicit opt-in (env var or settings flag).
import { threadIntentEnabledFrom } from "../commands/discord";

describe("threadIntentEnabledFrom (P0-15 opt-in gate)", () => {
  test("defaults to OFF when nothing is set", () => {
    expect(threadIntentEnabledFrom(undefined, undefined)).toBe(false);
    expect(threadIntentEnabledFrom("", undefined)).toBe(false);
    expect(threadIntentEnabledFrom(undefined, false)).toBe(false);
  });

  test("enables on truthy env values (case/whitespace insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", "  On  "]) {
      expect(threadIntentEnabledFrom(v, undefined)).toBe(true);
    }
  });

  test("does not enable on non-truthy env values", () => {
    for (const v of ["0", "false", "no", "off", "maybe", "2"]) {
      expect(threadIntentEnabledFrom(v, undefined)).toBe(false);
    }
  });

  test("enables when settings flag is exactly true", () => {
    expect(threadIntentEnabledFrom(undefined, true)).toBe(true);
  });

  test("env opt-in wins even when settings flag is false", () => {
    expect(threadIntentEnabledFrom("1", false)).toBe(true);
  });
});
