/**
 * Pure function: parse "/loop <interval> <prompt>" arguments.
 * Shared between the browser client (copy-pasted) and server-side tests.
 *
 * Returns { ok: true, cron, prompt } or { ok: false, error }.
 */
export interface ParseLoopResult {
  ok: boolean;
  cron?: string;
  prompt?: string;
  error?: string;
}

export function parseLoopArgs(input: string): ParseLoopResult {
  const s = String(input ?? "").trim();
  if (!s) {
    return { ok: false, error: "Usage: /loop <interval> <prompt> — e.g. /loop 5m write a haiku" };
  }

  let cron: string;
  let prompt: string;

  // Quoted raw cron: starts with a double-quote
  if (s.startsWith('"')) {
    const closeQ = s.indexOf('"', 1);
    if (closeQ === -1) return { ok: false, error: "Unclosed quote in cron expression" };
    cron = s.slice(1, closeQ).trim();
    prompt = s.slice(closeQ + 1).trim();
    const parts = cron.split(/\s+/);
    if (parts.length !== 5) {
      return { ok: false, error: `Quoted cron must have 5 fields, got: "${cron}"` };
    }
  } else {
    // Interval token is the first whitespace-delimited word
    const spIdx = s.search(/\s/);
    const token = spIdx === -1 ? s : s.slice(0, spIdx);
    const rest = spIdx === -1 ? "" : s.slice(spIdx + 1).trim();
    prompt = rest;

    const mMatch = /^(\d+)m$/.exec(token);
    const hMatch = /^(\d+)h$/.exec(token);
    const dMatch = /^(\d+)d$/.exec(token);

    if (mMatch) {
      const nm = parseInt(mMatch[1], 10);
      if (nm < 1 || nm > 1440) return { ok: false, error: "Minutes interval must be 1–1440" };
      cron = `*/${nm} * * * *`;
    } else if (hMatch) {
      const nh = parseInt(hMatch[1], 10);
      if (nh < 1 || nh > 24) return { ok: false, error: "Hours interval must be 1–24" };
      cron = `0 */${nh} * * *`;
    } else if (dMatch) {
      const nd = parseInt(dMatch[1], 10);
      if (nd < 1 || nd > 30) return { ok: false, error: "Days interval must be 1–30" };
      cron = `0 0 */${nd} * *`;
    } else {
      return {
        ok: false,
        error: `Unrecognised interval "${token}". Use Nm, Nh, Nd or a quoted 5-field cron.`,
      };
    }
  }

  if (!prompt) return { ok: false, error: "No prompt provided after the interval" };
  return { ok: true, cron, prompt };
}
