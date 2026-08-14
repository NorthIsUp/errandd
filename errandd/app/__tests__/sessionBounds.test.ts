import { describe, expect, test } from "bun:test";
import {
  appendDigest,
  buildCarryoverPrompt,
  DEFAULT_SESSION_LIMITS,
  DIGEST_MAX_CHARS,
  DIGEST_MAX_ENTRIES,
  restartReason,
  summarizeTurnOutput,
  type SessionLimits,
} from "../sessionBounds";

const LIMITS: SessionLimits = { maxTurns: 8, maxContextTokens: 200_000 };

describe("restartReason", () => {
  test("under both caps → keep resuming", () => {
    expect(restartReason({ turnCount: 7, contextTokens: 199_999 }, LIMITS)).toBeNull();
  });

  test("turn cap fires at the cap, not one past it", () => {
    expect(restartReason({ turnCount: 8 }, LIMITS)).toBe("turns");
    expect(restartReason({ turnCount: 9 }, LIMITS)).toBe("turns");
  });

  test("context cap fires on the last turn's peak live context", () => {
    expect(restartReason({ turnCount: 1, contextTokens: 200_000 }, LIMITS)).toBe("context");
  });

  test("turns win the tie so the reported reason names the knob to lower", () => {
    expect(restartReason({ turnCount: 9, contextTokens: 900_000 }, LIMITS)).toBe("turns");
  });

  test("0 disables a cap independently", () => {
    expect(restartReason({ turnCount: 99 }, { maxTurns: 0, maxContextTokens: 200_000 })).toBeNull();
    expect(
      restartReason({ turnCount: 99, contextTokens: 900_000 }, { maxTurns: 0, maxContextTokens: 0 }),
    ).toBeNull();
    // …but the OTHER cap still applies.
    expect(
      restartReason({ contextTokens: 900_000 }, { maxTurns: 0, maxContextTokens: 200_000 }),
    ).toBe("context");
  });

  test("a brand-new thread with no counters is never restarted", () => {
    expect(restartReason({}, LIMITS)).toBeNull();
  });

  test("the shipped defaults are bounded on both axes", () => {
    expect(DEFAULT_SESSION_LIMITS.maxTurns).toBeGreaterThan(0);
    expect(DEFAULT_SESSION_LIMITS.maxContextTokens).toBeGreaterThan(0);
  });
});

describe("digest", () => {
  test("summarizeTurnOutput flattens whitespace and caps length", () => {
    expect(summarizeTurnOutput("  posted\n\n a review \t comment  ")).toBe(
      "posted a review comment",
    );
    const long = summarizeTurnOutput("x".repeat(2000));
    expect(long.length).toBe(DIGEST_MAX_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });

  test("summarizeTurnOutput on an empty turn yields nothing", () => {
    expect(summarizeTurnOutput("   \n ")).toBe("");
  });

  test("appendDigest is newest-first and bounded", () => {
    let d: string[] = [];
    for (let i = 1; i <= DIGEST_MAX_ENTRIES + 3; i++) d = appendDigest(d, `turn ${i}`);
    expect(d).toHaveLength(DIGEST_MAX_ENTRIES);
    expect(d[0]).toBe(`turn ${DIGEST_MAX_ENTRIES + 3}`);
    expect(d).not.toContain("turn 1");
  });

  test("an empty entry never evicts a real one", () => {
    const d = appendDigest(appendDigest(undefined, "did a thing"), "   ");
    expect(d).toEqual(["did a thing"]);
  });
});

describe("buildCarryoverPrompt", () => {
  const base = {
    generation: 2,
    previousSessionId: "abcdef01-2345-6789-abcd-ef0123456789",
    previousTurns: 8,
    reason: "turns" as const,
    digest: ["replied to review comment 3", "pushed a fixup for the null check"],
  };

  test("states the restart, the generation, and every digest line", () => {
    const p = buildCarryoverPrompt(base);
    expect(p).toContain('generation="2"');
    expect(p).toContain("abcdef01");
    expect(p).toContain("8 resumed turn(s)");
    expect(p).toContain("- replied to review comment 3");
    expect(p).toContain("- pushed a fixup for the null check");
    expect(p.startsWith("<errandd-session-carryover")).toBe(true);
    expect(p.trimEnd().endsWith("</errandd-session-carryover>")).toBe(true);
  });

  test("tells the agent the transcript is gone so it re-reads live state", () => {
    const p = buildCarryoverPrompt(base).toLowerCase();
    expect(p).toContain("do not have its transcript");
    expect(p).toContain("not yet done");
  });

  test("the carryover stays far smaller than the transcript it replaces", () => {
    const p = buildCarryoverPrompt({
      ...base,
      digest: Array.from({ length: DIGEST_MAX_ENTRIES }, () => "y".repeat(DIGEST_MAX_CHARS)),
    });
    // Worst case is a few thousand characters — ~1k tokens against the ~729k/turn
    // re-read the restart avoids.
    expect(p.length).toBeLessThan(4000);
  });

  test("a context-triggered restart says so instead of quoting a turn count", () => {
    const p = buildCarryoverPrompt({ ...base, reason: "context" });
    expect(p).toContain("live context had grown large");
    expect(p).not.toContain("resumed turn(s)");
  });

  test("an empty digest still produces a usable message", () => {
    const p = buildCarryoverPrompt({ ...base, digest: [] });
    expect(p).toContain("No summary of the earlier passes survived.");
  });
});
