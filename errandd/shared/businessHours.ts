/**
 * Business-hour arithmetic for the sidebar's "recently finished" PR filter.
 *
 * The default view shows terminal PRs (merged/closed) from the last 24 *business*
 * hours, so a Monday morning reaches back through the weekend to Friday (~72h)
 * instead of losing everything that landed Friday afternoon.
 *
 * Weekends are the only thing skipped — nights and holidays still count. A
 * calendar-aware version would need the viewer's working hours and locale, which
 * is a lot of machinery for a sidebar toggle.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Sat/Sun in the viewer's local timezone — the filter is a human-facing "did
 *  this happen since I last looked?", so local is the right frame. */
function isWeekend(ms: number): boolean {
  const day = new Date(ms).getDay();
  return day === 0 || day === 6;
}

/**
 * Timestamp `hours` business hours before `now` (ms epoch), skipping weekends.
 *
 * Walks back an hour at a time — at 24h that's at most ~72 iterations, cheap
 * enough to call on every render and exact at hour granularity.
 */
export function businessHoursAgo(hours: number, now: number = Date.now()): number {
  let ms = now;
  let remaining = Math.max(0, hours);
  // A weekend *start* shouldn't burn budget either: rewind to Friday first.
  while (isWeekend(ms)) {
    ms -= HOUR_MS;
  }
  while (remaining > 0) {
    ms -= HOUR_MS;
    if (!isWeekend(ms)) {
      remaining--;
    }
  }
  return ms;
}
