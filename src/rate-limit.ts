// Rate-limit singleton state + detection helpers, extracted from runner.ts.
//
// Behavior-preserving: the module-level `rateLimitResetAt` / `rateLimitNotified`
// pair is a process-global singleton exactly as it was when inlined in runner.ts.
// Callers in runner.ts read/write it through these helpers.

// Any "you can't run right now because of capacity/billing" signal — a
// subscription usage cap OR a depleted API credit balance. All of these mean the
// SAME thing for the queue: don't fail the work and burn its retry budget; defer
// it and try again once the limit/balance recovers (the queue uses the parsed
// reset time, or falls back to ~1h via recordRateLimit). Broadened from the
// original subscription-only phrasing so genuine "out of credits" API errors
// queue-until-funded instead of failing after the retry cap.
// The "you can't run right now" signals. NOTE the `(?:[\w-]+ )?` before `limit`:
// Claude now sends MODEL-SPECIFIC caps — "You've hit your Sonnet limit", "...Opus
// limit" — as well as the older "usage limit" / "session limit" / bare "limit".
// Matching only usage/session (the prior pattern) silently MISSED the Sonnet/Opus
// messages, so the daemon never set rateLimitResetAt → it kept draining into the
// exhausted quota, every run failed (exit 1), retried to the cap, and the work
// was lost as "exhausted 5 retries" instead of being deferred to the reset.
export const RATE_LIMIT_PATTERN =
  /you(?:'|')ve hit your (?:[\w-]+ )?limit|out of extra usage|(?:usage|sonnet|opus|rate) limit (?:reached|exceeded)|credit balance is too low|insufficient credits|out of credits|billing.{0,20}(?:hard limit|quota) reached/i;

// Match a wall-clock reset time embedded in a rate-limit message, with an
// OPTIONAL leading date ("Jun 20, "). Captures month/day/hour/min/ampm/zone.
// The real messages are e.g. "resets 10:10pm (UTC)" (time only, today/tomorrow)
// and "You've hit your Sonnet limit · resets Jun 20, 6pm (UTC)" (model caps reset
// days out, so the DATE matters — parsing time-only would defer to the wrong day).
//   group 1 = month name (optional)   group 2 = day (optional)
//   group 3 = hour   group 4 = minutes (optional)   group 5 = am/pm (optional)
//   group 6 = zone (optional; default UTC)
// Examples: "resets 10:10pm (UTC)", "resets 1:50am", "resets 3pm (PDT)",
//           "resets Jun 20, 6pm (UTC)", "resets June 20 6:30am".
export const RATE_LIMIT_RESET_PATTERN =
  /resets?\s+(?:([A-Za-z]{3,9})\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(?\s*(UTC|GMT|Z|PST|PDT|PT)?\s*\)?/i;

// --- Rate limit state ---
let rateLimitResetAt = 0; // epoch ms; 0 = not rate-limited
let rateLimitNotified = false;
/** Set to true inside recordRateLimit(); cleared by clearRateLimitDetected().
 *  Lets callers know whether the most-recent run hit a rate-limit message. */
let rateLimitDetectedLastRun = false;

/**
 * Parse a wall-clock reset time out of a rate-limit message and return the
 * corresponding UTC epoch in ms. Returns null when no time is found.
 *
 * Honors the timezone the MESSAGE states. Claude's session-limit messages
 * report the reset in UTC ("resets 10:10pm (UTC)"), so the default is UTC —
 * parse the clock time as UTC for today (or tomorrow if it's already past).
 * Only when the message explicitly says Pacific (PT/PST/PDT) do we convert from
 * Pacific using the real DST-aware offset (PDT = UTC-7, PST = UTC-8).
 *
 * (An earlier version assumed Pacific unconditionally and added ~7h to the
 * already-UTC time — a 7-hour over-defer. Don't do that.)
 */
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

export function parseRateLimitResetTime(text: string): number | null {
  const match = RATE_LIMIT_RESET_PATTERN.exec(text);
  if (!match) return null;

  const monthName = match[1]?.slice(0, 3).toLowerCase();
  const explicitMonth = monthName !== undefined ? MONTHS[monthName] : undefined;
  const explicitDay = match[2] ? Number(match[2]) : undefined;
  let hours = Number(match[3]);
  const minutes = match[4] ? Number(match[4]) : 0;
  const ampm = match[5]?.toLowerCase();
  const tz = (match[6] ?? "").toUpperCase();
  // A month token that isn't a real month (e.g. a stray word) → ignore the date.
  const hasDate = explicitMonth !== undefined && explicitDay !== undefined;

  if (ampm === "pm" && hours < 12) hours += 12;
  if (ampm === "am" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  if (hasDate && (explicitDay < 1 || explicitDay > 31)) return null;

  const now = new Date();
  const statedPacific = tz === "PT" || tz === "PST" || tz === "PDT";

  if (!statedPacific) {
    // UTC (the default + the format Claude actually sends).
    let resetMs: number;
    if (hasDate) {
      // Model-cap resets carry an explicit date ("Jun 20, 6pm") that can be days
      // out — honor it. Assume the current year, rolling to next year if the
      // date already passed (year-boundary guard).
      resetMs = Date.UTC(now.getUTCFullYear(), explicitMonth, explicitDay, hours, minutes, 0, 0);
      if (resetMs <= now.getTime() - 24 * 60 * 60_000) {
        resetMs = Date.UTC(now.getUTCFullYear() + 1, explicitMonth, explicitDay, hours, minutes, 0, 0);
      }
    } else {
      // Time only → today, rolling to tomorrow if already passed.
      resetMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, 0, 0);
      if (resetMs <= now.getTime()) resetMs += 24 * 60 * 60_000;
    }
    return resetMs;
  }

  // Message explicitly stated Pacific → DST-aware conversion. Use
  // Intl.DateTimeFormat to get the current Pacific calendar day + real offset
  // (PDT = UTC-7 in summer, PST = UTC-8 in winter) rather than hardcoding.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string): number => Number(fmt.find((p) => p.type === type)?.value ?? "0");
  const pacYear = get("year");
  const pacMonth = get("month") - 1; // 0-based
  const pacDay = get("day");
  const pacHour = get("hour") % 24; // Intl can emit "24" for midnight
  const pacMin = get("minute");
  const pacificOffsetMs = Date.UTC(pacYear, pacMonth, pacDay, pacHour, pacMin, 0, 0) - now.getTime();
  const dMonth = hasDate ? explicitMonth : pacMonth;
  const dDay = hasDate ? explicitDay : pacDay;
  let resetMs = Date.UTC(pacYear, dMonth, dDay, hours, minutes, 0, 0) - pacificOffsetMs;
  if (!hasDate && resetMs <= now.getTime()) resetMs += 24 * 60 * 60_000;
  return resetMs;
}

export function isRateLimited(): boolean {
  if (rateLimitResetAt === 0) return false;
  if (Date.now() >= rateLimitResetAt) {
    rateLimitResetAt = 0;
    rateLimitNotified = false;
    return false;
  }
  return true;
}

export function getRateLimitResetAt(): number {
  return rateLimitResetAt;
}

export function wasRateLimitNotified(): boolean {
  return rateLimitNotified;
}

export function markRateLimitNotified(): void {
  rateLimitNotified = true;
}

/**
 * Record a freshly-detected rate limit: parse the reset time out of the
 * message and set rateLimitResetAt when the API gave an explicit time.
 * When no reset time is parseable, rateLimitResetAt is left at 0 (not
 * rate-limited at the module level) so the queue falls through to its own
 * short exponential backoff instead of blocking for an hour.
 *
 * Returns the parsed reset epoch ms, or null when no reset time was found.
 * Marks rateLimitDetectedLastRun so callers can distinguish "transient rate
 * limit, no explicit reset" from "ordinary failure".
 */
export function recordRateLimit(message: string): number | null {
  const resetTime = parseRateLimitResetTime(message);
  rateLimitResetAt = resetTime ?? 0;
  rateLimitDetectedLastRun = true;
  rateLimitNotified = false;
  return resetTime;
}

/**
 * Reset the per-run detection flag. Call this at the START of each queued-
 * batch run so wasRateLimitDetected() accurately reflects only the current run.
 */
export function clearRateLimitDetected(): void {
  rateLimitDetectedLastRun = false;
}

/**
 * Clear the rate-limit HOLD (rateLimitResetAt → 0). Call when a Claude run
 * SUCCEEDS with no rate-limit message: a success proves the API is available
 * again, so the queue must not keep deferring until the recorded reset time.
 *
 * Without this, a brief/over-estimated limit blocks the hook queue for the
 * whole window even after the API recovers — e.g. a scheduled job (which
 * bypasses the hold) runs in 2s while the hook-queue drain sits "rate limited"
 * for an hour. Clearing on success lets the queue resume immediately.
 */
export function clearRateLimit(): void {
  rateLimitResetAt = 0;
  rateLimitNotified = false;
}

/**
 * True when recordRateLimit() was called since the last clearRateLimitDetected().
 * Combined with !isRateLimited(), this identifies a "transient rate limit":
 * a rate-limit message was emitted but the API gave no explicit reset time,
 * so the queue should use short exponential backoff (not a 1-hour defer).
 */
export function wasRateLimitDetected(): boolean {
  return rateLimitDetectedLastRun;
}

export function extractRateLimitMessage(stdout: string, stderr: string): string | null {
  const candidates = [stdout, stderr];
  for (const text of candidates) {
    const trimmed = text.trim();
    if (trimmed && RATE_LIMIT_PATTERN.test(trimmed)) return trimmed;
  }
  return null;
}
