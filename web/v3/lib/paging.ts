/**
 * Client-side filter + pagination for the sidebar hook sections (Errors /
 * Alerts / Tickets / Pull Requests). All data lives in the queue snapshot
 * (≤300 rows), so filtering and slicing are pure in-memory operations.
 *
 * Two modes:
 *
 *   count — show a fixed number of items per page, newest-first.
 *           page 0 = items[0..value-1], page 1 = items[value..2*value-1], …
 *
 *   days  — show items that fall within a sliding D-day window.
 *           page 0 = last D days,
 *           page 1 = the D-day window before that (D..2D days ago),
 *           page N = items where now−(N+1)·D·86400s ≤ lastAt < now−N·D·86400s
 */

/** The fixed stop values available on the count-mode slider. */
export const COUNT_STOPS = [10, 25, 50, 100] as const;
/** The fixed stop values available on the days-mode slider. */
export const DAYS_STOPS = [1, 3, 7, 14, 30] as const;

export type ViewMode = "count" | "days";

export interface PageResult<T> {
  /** Items to display for this page. Already sorted by recency (lastAt desc). */
  items: T[];
  /** True when page > 0 (there is a newer page). */
  hasPrev: boolean;
  /** True when there is an older page with at least one item. */
  hasNext: boolean;
  /** Total item count across the full un-paged list (for "of N" display). */
  total: number;
  /**
   * 1-based index of the first shown item relative to the recency-sorted list
   * (count mode only; 0 in days mode — caller uses `items.length` instead).
   */
  from: number;
  /**
   * 1-based index of the last shown item (count mode only; 0 in days mode).
   */
  to: number;
}

/**
 * Slice `items` into a single page according to `mode`, `value`, and `page`.
 *
 * @param items  The full item list (any order — function sorts by lastAt desc).
 * @param mode   "count" | "days"
 * @param value  Count (10/25/50/100) or days window (1/3/7/14/30).
 * @param page   Zero-based page index.
 * @param now    Current epoch-ms (pass `Date.now()` from the caller; kept as a
 *               parameter so the pure function stays deterministic in tests).
 */
export function pageItems<T extends { lastAt: number }>(
  items: T[],
  mode: ViewMode,
  value: number,
  page: number,
  now: number,
): PageResult<T> {
  const total = items.length;

  if (mode === "count") {
    // Sort all items newest-first, then slice [page*value, (page+1)*value).
    const sorted = [...items].sort((a, b) => b.lastAt - a.lastAt);
    const start = page * value;
    const end = start + value;
    const slice = sorted.slice(start, end);
    return {
      items: slice,
      hasPrev: page > 0,
      hasNext: end < total,
      total,
      from: total === 0 ? 0 : start + 1,
      to: Math.min(end, total),
    };
  }

  // days mode —————————————————————————————————————————————————————————————
  //
  // The D-day window for page N spans:
  //   windowStart = now − (page+1) × D × 86_400_000 ms
  //   windowEnd   = now − page     × D × 86_400_000 ms
  //
  // Items on this page: windowStart ≤ lastAt < windowEnd.
  // Items on older pages: lastAt < windowStart.
  //
  const windowMs = value * 86_400_000;
  const windowEnd = now - page * windowMs;
  const windowStart = now - (page + 1) * windowMs;

  const slice = items
    .filter((it) => it.lastAt >= windowStart && it.lastAt < windowEnd)
    .sort((a, b) => b.lastAt - a.lastAt);

  // hasNext: at least one item is older than the current window.
  const hasNext = items.some((it) => it.lastAt < windowStart);

  return {
    items: slice,
    hasPrev: page > 0,
    hasNext,
    total,
    // days mode: from/to are 0 — callers use items.length for the readout.
    from: 0,
    to: 0,
  };
}
