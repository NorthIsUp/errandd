import { describe, expect, test } from "bun:test";
import { cronMatches, earliestCronMatch, nextCronMatch } from "../cron";

describe("nextCronMatch", () => {
  test.each([
    ["0 9 * * 1", "2026-10-20T10:00:00Z", "2026-10-26T09:00:00Z"],
    ["0 9 1 * *", "2026-10-02T10:00:00Z", "2026-11-01T09:00:00Z"],
    ["0 0 1 1 *", "2026-02-01T00:00:00Z", "2027-01-01T00:00:00Z"],
    ["0 0 29 2 *", "2096-03-01T00:00:00Z", "2104-02-29T00:00:00Z"],
  ])("finds distant schedule %s", (expr, after, expected) => {
    const next = nextCronMatch(expr, new Date(after));
    expect(next.toISOString()).toBe(new Date(expected).toISOString());
    expect(cronMatches(expr, next)).toBe(true);
  });

  test("honors timezone offset while skipping nonmatching days", () => {
    const next = nextCronMatch("0 9 1 * *", new Date("2026-10-02T10:00:00Z"), -420);
    expect(next.toISOString()).toBe("2026-11-01T16:00:00.000Z");
  });

  test("never returns a fabricated date for an impossible schedule", () => {
    expect(() => nextCronMatch("0 0 30 2 *", new Date("2026-01-01T00:00:00Z"))).toThrow("No matching date");
  });

  test("rejects malformed field counts and invalid dates", () => {
    expect(() => nextCronMatch("0 9 *", new Date())).toThrow();
    expect(() => nextCronMatch("* * * * *", new Date("invalid"))).toThrow();
  });

  test("selects the actual earliest occurrence among distant schedules", () => {
    expect(earliestCronMatch(["0 9 * * 1", "0 9 1 * *"], new Date("2026-10-20T10:00:00Z"))?.toISOString())
      .toBe("2026-10-26T09:00:00.000Z");
  });
});
