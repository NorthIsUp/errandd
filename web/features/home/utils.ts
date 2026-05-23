/**
 * Shared formatting utilities for the Home section.
 * Ported faithfully from src/ui/page/script.ts.
 */

/** Format a token count as e.g. "4.2K", "1.3M", or the raw number. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Format a USD cost with appropriate precision. */
export function fmtCost(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Format milliseconds as "5m", "2h", "3d ago" or empty. */
export function fmtDur(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (s < 60) return `${s}s`;
  if (m < 60) return `${m}m`;
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Format an ISO date/ms as a relative age string. */
export function fmtRelative(
  isoStr: string | number | null | undefined,
): string {
  if (!isoStr) return "";
  try {
    const ms = Date.now() - new Date(isoStr).getTime();
    return `${fmtDur(ms)} ago`;
  } catch {
    return "";
  }
}

/** Format a date value as a localized time string (HH:MM). */
export function fmtTime(value: string | number | Date): string {
  try {
    const d = new Date(value as string);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** Format a date as "HH:MM" today, or "Mon D" if not today. */
export function formatSessionTime(
  isoStr: string | number | null | undefined,
): string {
  if (!isoStr) return "";
  try {
    const d = new Date(isoStr as string);
    const now = new Date();
    const dateStr = d.toLocaleDateString();
    const nowStr = now.toLocaleDateString();
    if (dateStr === nowStr) return fmtTime(d);
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

/** Capitalise the first letter of a string. */
export function cap(s: string | undefined | null): string {
  if (!s) return "";
  return s.slice(0, 1).toUpperCase() + s.slice(1);
}

/**
 * Compute the "job base" from a usage label.
 * Labels like "#base:123" belong to base "base".
 * Labels exactly "#base" also belong if base is in knownBases.
 * Returns null if the label is not a job-run label.
 */
export function usageJobBase(
  label: string,
  knownBases: Record<string, boolean> | null,
): string | null {
  if (!label.startsWith("#")) return null;
  const bare = label.slice(1);
  const colonIdx = bare.indexOf(":");
  if (colonIdx === -1) {
    // Exactly "#base" — only assign to a group if knownBases says so
    if (knownBases?.[bare]) return bare;
    return null;
  }
  const runPart = bare.slice(colonIdx + 1);
  if (!/^\d+$/.test(runPart)) return null;
  return bare.slice(0, colonIdx);
}

/**
 * Compute the next cron run time given a 5-field cron expression and a starting Date.
 * Returns null if no match found within 2 days (2880 probes).
 */
function matchCronField(field: string, value: number): boolean {
  const parts = String(field ?? "").split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [range, stepStr] = trimmed.split("/");
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    if (!Number.isInteger(step) || step <= 0) continue;
    if (range === "*") {
      if (value % step === 0) return true;
      continue;
    }
    if (range?.includes("-")) {
      const [loStr, hiStr] = range.split("-");
      const lo = parseInt(loStr ?? "", 10);
      const hi = parseInt(hiStr ?? "", 10);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) continue;
      if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
      continue;
    }
    if (range !== undefined && parseInt(range, 10) === value) return true;
  }
  return false;
}

function cronMatchesAt(schedule: string, date: Date): boolean {
  const parts = String(schedule ?? "")
    .trim()
    .split(/\s+/);
  if (parts.length !== 5) return false;
  const d = {
    minute: date.getUTCMinutes(),
    hour: date.getUTCHours(),
    dayOfMonth: date.getUTCDate(),
    month: date.getUTCMonth() + 1,
    dayOfWeek: date.getUTCDay(),
  };
  const [m0, m1, m2, m3, m4] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  return (
    matchCronField(m0, d.minute) &&
    matchCronField(m1, d.hour) &&
    matchCronField(m2, d.dayOfMonth) &&
    matchCronField(m3, d.month) &&
    matchCronField(m4, d.dayOfWeek)
  );
}

export function nextRunAt(schedule: string, now: Date): Date | null {
  const probe = new Date(now);
  probe.setSeconds(0, 0);
  probe.setMinutes(probe.getMinutes() + 1);
  for (let i = 0; i < 2880; i++) {
    if (cronMatchesAt(schedule, probe)) return new Date(probe);
    probe.setMinutes(probe.getMinutes() + 1);
  }
  return null;
}
