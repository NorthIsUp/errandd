import { shiftDateToOffset } from "./timezone";

function matchCronField(field: string, value: number): boolean {
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr) : 1;

    if (range === "*") {
      if (value % step === 0) return true;
      continue;
    }

    if (range.includes("-")) {
      const [lo, hi] = range.split("-").map(Number);
      if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
      continue;
    }

    if (parseInt(range) === value) return true;
  }
  return false;
}

export function cronMatches(expr: string, date: Date, timezoneOffsetMinutes = 0): boolean {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = expr.trim().split(/\s+/);
  const shifted = shiftDateToOffset(date, timezoneOffsetMinutes);
  const d = {
    minute: shifted.getUTCMinutes(),
    hour: shifted.getUTCHours(),
    dayOfMonth: shifted.getUTCDate(),
    month: shifted.getUTCMonth() + 1,
    dayOfWeek: shifted.getUTCDay(),
  };

  return (
    matchCronField(minute, d.minute) &&
    matchCronField(hour, d.hour) &&
    matchCronField(dayOfMonth, d.dayOfMonth) &&
    matchCronField(month, d.month) &&
    matchCronField(dayOfWeek, d.dayOfWeek)
  );
}

export function nextCronMatch(expr: string, after: Date, timezoneOffsetMinutes = 0): Date {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 || !Number.isFinite(after.getTime()) || !Number.isFinite(timezoneOffsetMinutes)) {
    throw new Error("Invalid cron expression or date.");
  }
  const [, , dayOfMonth, month, dayOfWeek] = fields;
  const d = new Date(after);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  // Weekly/monthly schedules and leap-day schedules can be years away. Never
  // return the search limit as if it matched. Eight years covers the leap-day
  // gap around a non-leap century (e.g. 2096 -> 2104).
  const limit = new Date(d);
  limit.setUTCFullYear(limit.getUTCFullYear() + 8);
  while (d <= limit) {
    const shifted = shiftDateToOffset(d, timezoneOffsetMinutes);
    if (
      !matchCronField(month, shifted.getUTCMonth() + 1) ||
      !matchCronField(dayOfMonth, shifted.getUTCDate()) ||
      !matchCronField(dayOfWeek, shifted.getUTCDay())
    ) {
      // Skip directly to midnight in the configured offset when this day
      // cannot match, so annual and impossible schedules stay cheap.
      const minutesLeft = 24 * 60 - shifted.getUTCHours() * 60 - shifted.getUTCMinutes();
      d.setTime(d.getTime() + minutesLeft * 60_000);
      continue;
    }
    if (cronMatches(expr, d, timezoneOffsetMinutes)) return d;
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  throw new Error(`No matching date within eight years for cron: ${expr}`);
}

/** True if any of the cron expressions matches `date`. A routine can carry
 *  multiple `schedule:` triggers; it fires when any of them is due. */
export function anyCronMatches(exprs: string[], date: Date, timezoneOffsetMinutes = 0): boolean {
  return exprs.some((e) => cronMatches(e, date, timezoneOffsetMinutes));
}

/** Earliest next fire across multiple cron expressions, or null when the
 *  list is empty (an event-only routine has no scheduled next-run). */
export function earliestCronMatch(
  exprs: string[],
  after: Date,
  timezoneOffsetMinutes = 0,
): Date | null {
  let best: Date | null = null;
  for (const e of exprs) {
    const d = nextCronMatch(e, after, timezoneOffsetMinutes);
    if (best === null || d.getTime() < best.getTime()) best = d;
  }
  return best;
}
