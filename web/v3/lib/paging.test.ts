import { describe, expect, test } from "bun:test";
import { pageItems } from "./paging";

// ─── helpers ────────────────────────────────────────────────────────────────

function items(timestamps: number[]) {
  return timestamps.map((lastAt, i) => ({ lastAt, id: i }));
}

const NOW = 1_700_000_000_000; // fixed epoch for deterministic tests

// ─── count mode ─────────────────────────────────────────────────────────────

describe("count mode", () => {
  test("page 0 returns first N items newest-first", () => {
    const data = items([100, 300, 200, 400]);
    const r = pageItems(data, "count", 2, 0, NOW);
    expect(r.items.map((it) => it.lastAt)).toEqual([400, 300]);
    expect(r.from).toBe(1);
    expect(r.to).toBe(2);
    expect(r.total).toBe(4);
    expect(r.hasPrev).toBe(false);
    expect(r.hasNext).toBe(true);
  });

  test("page 1 returns the next slice", () => {
    const data = items([100, 300, 200, 400]);
    const r = pageItems(data, "count", 2, 1, NOW);
    expect(r.items.map((it) => it.lastAt)).toEqual([200, 100]);
    expect(r.from).toBe(3);
    expect(r.to).toBe(4);
    expect(r.hasPrev).toBe(true);
    expect(r.hasNext).toBe(false);
  });

  test("last page partial slice", () => {
    const data = items([5, 4, 3, 2, 1]);
    const r = pageItems(data, "count", 3, 1, NOW);
    expect(r.items.map((it) => it.lastAt)).toEqual([2, 1]);
    expect(r.from).toBe(4);
    expect(r.to).toBe(5);
    expect(r.hasNext).toBe(false);
  });

  test("empty list", () => {
    const r = pageItems([], "count", 25, 0, NOW);
    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.from).toBe(0);
    expect(r.to).toBe(0);
    expect(r.hasPrev).toBe(false);
    expect(r.hasNext).toBe(false);
  });

  test("page beyond the list returns empty slice", () => {
    const data = items([1, 2, 3]);
    const r = pageItems(data, "count", 10, 1, NOW);
    expect(r.items).toEqual([]);
    expect(r.hasNext).toBe(false);
    expect(r.hasPrev).toBe(true);
  });

  test("total equals N items when exactly filled", () => {
    const data = items([3, 1, 2]);
    const r = pageItems(data, "count", 3, 0, NOW);
    expect(r.to).toBe(3);
    expect(r.hasNext).toBe(false);
  });
});

// ─── days mode ──────────────────────────────────────────────────────────────

describe("days mode", () => {
  // D = 7 days in ms
  const D = 7 * 86_400_000;

  test("page 0 returns items within the last D days", () => {
    const recent = NOW - D / 2; // 3.5 days ago — in window
    const old = NOW - D * 2; // 14 days ago — not in window
    const data = items([recent, old]);
    const r = pageItems(data, "days", 7, 0, NOW);
    expect(r.items.map((it) => it.lastAt)).toEqual([recent]);
    expect(r.total).toBe(2);
    expect(r.hasPrev).toBe(false);
    // old item is older than the window → hasNext true
    expect(r.hasNext).toBe(true);
    // days mode: from/to are sentinel 0
    expect(r.from).toBe(0);
    expect(r.to).toBe(0);
  });

  test("page 1 returns items in the previous D-day window", () => {
    // Window for page 1: now−2D ≤ lastAt < now−D
    const page0item = NOW - D / 2; // last 7 days
    const page1item = NOW - D * 1.5; // 10.5 days ago — in page 1 window
    const page2item = NOW - D * 2.5; // 17.5 days ago — older than page 1
    const data = items([page0item, page1item, page2item]);
    const r = pageItems(data, "days", 7, 1, NOW);
    expect(r.items.map((it) => it.lastAt)).toEqual([page1item]);
    expect(r.hasPrev).toBe(true);
    expect(r.hasNext).toBe(true);
  });

  test("hasNext false when no items are older than current window", () => {
    const recent = NOW - 1000;
    const data = items([recent]);
    const r = pageItems(data, "days", 7, 0, NOW);
    expect(r.hasNext).toBe(false);
  });

  test("empty list in days mode", () => {
    const r = pageItems([], "days", 7, 0, NOW);
    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.hasPrev).toBe(false);
    expect(r.hasNext).toBe(false);
  });

  test("items at exact window boundary: windowStart inclusive, windowEnd exclusive", () => {
    const D1 = 1 * 86_400_000;
    const windowEnd = NOW; // page 0 upper bound (exclusive) = now - 0*D
    const windowStart = NOW - D1; // page 0 lower bound (inclusive)
    // Exactly at windowStart → included
    const atStart = items([windowStart]);
    expect(pageItems(atStart, "days", 1, 0, NOW).items).toHaveLength(1);
    // Exactly at windowEnd → excluded (falls in page -1, i.e. the "future")
    const atEnd = items([windowEnd]);
    expect(pageItems(atEnd, "days", 1, 0, NOW).items).toHaveLength(0);
    // One ms before windowStart → not in page 0 (falls in page 1)
    const justBefore = items([windowStart - 1]);
    expect(pageItems(justBefore, "days", 1, 0, NOW).items).toHaveLength(0);
    expect(pageItems(justBefore, "days", 1, 0, NOW).hasNext).toBe(true);
  });

  test("multiple items in window are sorted newest-first", () => {
    const a = NOW - 1000;
    const b = NOW - 500;
    const c = NOW - 2000;
    const data = items([a, b, c]);
    const r = pageItems(data, "days", 7, 0, NOW);
    expect(r.items.map((it) => it.lastAt)).toEqual([b, a, c]);
  });
});
