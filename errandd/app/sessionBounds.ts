/**
 * Bounded session reuse for job threads.
 *
 * A hook-scoped run gets a stable per-subject thread id (`<job>:hook:pr-2530`),
 * so consecutive webhook deliveries resume the SAME claude session. Nothing used
 * to cap that, so turn N re-read turns 1..N-1 and cost grew quadratically in
 * turns — one observed PR thread burned 13.1M cache-read tokens over 18 turns to
 * produce 84k of output.
 *
 * The fix is NOT to prune old turns. Prompt caching is a PREFIX cache: dropping
 * or rewriting the oldest turns invalidates every cached block from the edit
 * point onward, converting ~0.1x cache reads into 1.25x cache writes on every
 * trim. Pruning costs more than doing nothing.
 *
 * Instead we bound and restart: past a turn cap or a live-context cap, the next
 * run starts a FRESH session for that thread and carries forward a small state
 * summary — what earlier passes already did — instead of the transcript. That is
 * one small cache write, then append-only growth with cache hits again. Cache
 * entries expire in minutes anyway while webhook deliveries land minutes-to-hours
 * apart, so a long-resumed session was usually paying a full re-read regardless.
 */

/** Caps for one thread. `0` on either field disables that cap. */
export interface SessionLimits {
  /** Restart once the thread has been RESUMED this many times. */
  maxTurns: number;
  /** Restart once a turn's peak live context (input + cache read + cache
   *  creation) reaches this many tokens — the size the NEXT resume would
   *  re-read before doing any work. */
  maxContextTokens: number;
}

/** Deliberately tight. A resumed PR thread rarely needs more than a handful of
 *  passes of shared context, and 200k is already ~$0.06/turn just to re-read. */
export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  maxTurns: 8,
  maxContextTokens: 200_000,
};

/** The subset of a stored ThreadSession the caps are evaluated against. */
export interface ThreadBoundState {
  turnCount?: number;
  /** Peak live context of the most recent turn on this session. */
  contextTokens?: number;
}

export type RestartReason = "turns" | "context";

/** Which cap (if any) this thread has hit. Turns are checked first so the reason
 *  reported is the one an operator can act on by lowering `max_session_turns`. */
export function restartReason(
  state: ThreadBoundState,
  limits: SessionLimits,
): RestartReason | null {
  if (limits.maxTurns > 0 && (state.turnCount ?? 0) >= limits.maxTurns) return "turns";
  if (limits.maxContextTokens > 0 && (state.contextTokens ?? 0) >= limits.maxContextTokens) {
    return "context";
  }
  return null;
}

/** Newest-first digest entries kept per session. Small on purpose twice over:
 *  it is the entire memory a restarted session inherits (so it must stay far
 *  cheaper than the transcript it replaces), and it rides along in every
 *  append-only snapshot written to `sessions.jsonl`, which is only compacted
 *  opportunistically. ~1.2KB worst case per row. */
export const DIGEST_MAX_ENTRIES = 4;
export const DIGEST_MAX_CHARS = 300;

/** Collapse a turn's final output into one bounded line for the digest. */
export function summarizeTurnOutput(stdout: string): string {
  const flat = stdout.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > DIGEST_MAX_CHARS ? `${flat.slice(0, DIGEST_MAX_CHARS - 1)}…` : flat;
}

/** Prepend `entry` (newest first) and cap the digest. Empty entries are dropped
 *  so a silent turn doesn't push a real one out. */
export function appendDigest(digest: string[] | undefined, entry: string): string[] {
  const clean = entry.trim();
  const prev = digest ?? [];
  if (!clean) return prev.slice(0, DIGEST_MAX_ENTRIES);
  return [clean, ...prev].slice(0, DIGEST_MAX_ENTRIES);
}

export interface CarryoverInput {
  /** 1 for the first restart of this thread, 2 for the second, … */
  generation: number;
  previousSessionId: string;
  previousTurns: number;
  reason: RestartReason;
  /** Newest-first turn summaries from the retired session. */
  digest: string[];
}

/**
 * The one message a restarted session inherits. Goes in the USER prompt, never
 * in `--append-system-prompt`: the resident system prefix must stay byte-stable
 * across runs or within-run cache hits (currently 91-99%) collapse.
 */
export function buildCarryoverPrompt(input: CarryoverInput): string {
  const why =
    input.reason === "turns"
      ? `after ${input.previousTurns} resumed turn(s)`
      : "because its live context had grown large";
  const lines = [
    `<errandd-session-carryover generation="${input.generation}">`,
    `This is a FRESH session for this subject. The previous session ` +
      `(${input.previousSessionId.slice(0, 8)}) was retired ${why} to bound context growth. ` +
      `You do NOT have its transcript and cannot recover it.`,
  ];
  if (input.digest.length > 0) {
    lines.push("", "What earlier passes on this subject already did (newest first):");
    for (const d of input.digest) lines.push(`- ${d}`);
  } else {
    lines.push("", "No summary of the earlier passes survived.");
  }
  lines.push(
    "",
    "Treat anything not listed above as NOT yet done, and re-read the live state " +
      "(the PR, its comments, CI) before acting rather than assuming. Do not repeat " +
      "work listed above, and do not re-post a comment you already posted.",
    "</errandd-session-carryover>",
  );
  return lines.join("\n");
}
