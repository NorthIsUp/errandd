import { describe, expect, test } from "bun:test";
import { businessHoursAgo } from "../../shared/businessHours";

/** Local-time constructor — the helper works in the viewer's timezone. */
function at(y: number, m: number, d: number, h: number): number {
  return new Date(y, m - 1, d, h).getTime();
}

const HOURS = (n: number) => n * 60 * 60 * 1000;

describe("businessHoursAgo", () => {
  test("mid-week: 24 business hours is a plain 24 hours", () => {
    const wednesday = at(2026, 8, 19, 10); // Wed
    expect(businessHoursAgo(24, wednesday)).toBe(wednesday - HOURS(24));
  });

  test("monday morning reaches back through the weekend to friday (~72h)", () => {
    const monday = at(2026, 8, 24, 10); // Mon
    expect(businessHoursAgo(24, monday)).toBe(at(2026, 8, 21, 10)); // Fri, same hour
  });

  test("tuesday only crosses the weekend for the hours before monday", () => {
    const tuesday = at(2026, 8, 25, 9); // Tue 09:00
    expect(businessHoursAgo(24, tuesday)).toBe(at(2026, 8, 24, 9)); // Mon 09:00
  });

  test("asked on a weekend, the window ends at friday rather than burning budget", () => {
    const sunday = at(2026, 8, 23, 12); // Sun
    // rewind Sun 12:00 → Fri 23:00 (25h of weekend), then 24 business hours back
    expect(businessHoursAgo(24, sunday)).toBe(at(2026, 8, 20, 23)); // Thu 23:00
  });

  test("zero / negative hours never move the cutoff forward", () => {
    const now = at(2026, 8, 19, 10);
    expect(businessHoursAgo(0, now)).toBe(now);
    expect(businessHoursAgo(-5, now)).toBe(now);
  });
});
