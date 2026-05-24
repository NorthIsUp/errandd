import type { WindowState } from "./store";

/**
 * URL hash fragment encoding for open windows + their geometry.
 *
 * Format: `#w=<appId>@<x>,<y>,<width>x<height>;<appId>@…`
 *
 * Compact + human-readable. Position rounded to integer pixels. Used for
 * deep-linking — share the URL, get the same window layout.
 */

export interface HashWin {
  appId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function serialize(windows: WindowState[]): string {
  if (windows.length === 0) return "";
  // Stable order by z so the reload restores focus order too.
  const sorted = [...windows].sort((a, b) => a.z - b.z);
  return sorted
    .map(
      (w) =>
        `${encodeURIComponent(w.appId)}@${Math.round(w.x)},${Math.round(w.y)},${w.width}x${w.height}`,
    )
    .join(";");
}

export function parse(raw: string): HashWin[] {
  if (!raw) return [];
  const out: HashWin[] = [];
  for (const entry of raw.split(";")) {
    const m = entry.match(/^([^@]+)@(-?\d+),(-?\d+),(\d+)x(\d+)$/);
    if (!m) continue;
    out.push({
      appId: decodeURIComponent(m[1]!),
      x: Number(m[2]),
      y: Number(m[3]),
      width: Number(m[4]),
      height: Number(m[5]),
    });
  }
  return out;
}

export function readHashWindows(): HashWin[] {
  const raw = window.location.hash.slice(1);
  const params = new URLSearchParams(raw);
  return parse(params.get("w") ?? "");
}

export function writeHashWindows(windows: WindowState[]): void {
  const raw = window.location.hash.slice(1);
  const params = new URLSearchParams(raw);
  const ser = serialize(windows);
  if (ser) params.set("w", ser);
  else params.delete("w");
  const next = params.toString();
  const target = next ? `#${next}` : "";
  // Use replaceState to avoid spamming history on every drag.
  history.replaceState(null, "", `${window.location.pathname}${target}`);
}
