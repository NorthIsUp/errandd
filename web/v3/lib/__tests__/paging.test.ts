import { describe, expect, test } from "bun:test";
import { pageItems } from "../paging";

const item = (lastAt: number) => ({ lastAt });
const DAY = 86_400_000;

describe("pageItems — days mode page-0 upper bound (the 'PR vanishes on new hook' bug)", () => {
  // `now` is captured at sidebar mount; incoming hooks bump a PR's lastAt to the
  // CURRENT time, which is later than that mount-time `now`. Page 0 must keep
  // those items, not exclude them with a hard `lastAt < now`.
  const now = 1_000 * DAY; // arbitrary fixed "mount time"

  test("an item updated AFTER `now` (a fresh hook) stays on page 0", () => {
    const fresh = item(now + 5 * 60_000); // 5 min "in the future" vs captured now
    const old = item(now - 1 * DAY);
    const res = pageItems([fresh, old], "days", 3, 0, now);
    expect(res.items).toContain(fresh); // ← would fail before the fix
    expect(res.items).toContain(old);
  });

  test("page 0 still excludes items older than the D-day window", () => {
    const recent = item(now - 1 * DAY);
    const tooOld = item(now - 5 * DAY); // outside the 3-day window
    const res = pageItems([recent, tooOld], "days", 3, 0, now);
    expect(res.items).toContain(recent);
    expect(res.items).not.toContain(tooOld);
    expect(res.hasNext).toBe(true); // older items exist → next page available
  });

  test("page 1 keeps a bounded window (no Infinity leak past page 0)", () => {
    const onP0 = item(now - 1 * DAY); // within 0..3d
    const onP1 = item(now - 4 * DAY); // within 3..6d
    const future = item(now + 60_000); // fresh — must NOT appear on page 1
    const res = pageItems([onP0, onP1, future], "days", 3, 1, now);
    expect(res.items).toContain(onP1);
    expect(res.items).not.toContain(onP0);
    expect(res.items).not.toContain(future);
  });
});

describe("pageItems — count mode is unaffected (newest-first slice)", () => {
  const now = 1_000 * DAY;
  test("a fresh item sorts to the top of page 0", () => {
    const fresh = item(now + 60_000);
    const a = item(now - 1 * DAY);
    const b = item(now - 2 * DAY);
    const res = pageItems([a, b, fresh], "count", 2, 0, now);
    expect(res.items[0]).toBe(fresh);
    expect(res.items.length).toBe(2);
    expect(res.hasNext).toBe(true);
  });
});
