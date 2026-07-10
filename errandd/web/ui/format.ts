/**
 * Cross-bundle date/time formatting. Centralized so every section shows
 * timestamps in the same shape — previously each section called
 * `new Date(x).toLocaleString()` with different option subsets.
 */

export function formatTimestamp(iso: string | number | Date): string {
  const d = toDate(iso);
  return d ? d.toLocaleString() : String(iso);
}

/** Short timestamp suitable for tight rows: "5/26 11:09". */
export function formatRun(iso: string | number | Date): string {
  const d = toDate(iso);
  if (!d) return String(iso);
  return d.toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Just the date: "5/26/2026". */
export function formatDate(iso: string | number | Date): string {
  const d = toDate(iso);
  return d ? d.toLocaleDateString() : String(iso);
}

/** Human relative time: "3m ago", "in 2h". Returns "" for invalid input. */
export function formatRelative(iso: string | number | Date, now: Date = new Date()): string {
  const d = toDate(iso);
  if (!d) return "";
  const diffMs = d.getTime() - now.getTime();
  const past = diffMs <= 0;
  const abs = Math.abs(diffMs);
  const sec = Math.round(abs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  const label =
    sec < 60 ? `${sec}s` : min < 60 ? `${min}m` : hr < 24 ? `${hr}h` : `${day}d`;
  return past ? `${label} ago` : `in ${label}`;
}

function toDate(v: string | number | Date): Date | null {
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : v;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
