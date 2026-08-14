/**
 * Smoke test for the coding-agent CLI the daemon shells out to.
 *
 * Born from a 28-hour silent outage: the Claude CLI self-updated into a state
 * volume that was 100% full, the write hit ENOSPC, and the resulting truncated
 * binary (97,828,864 of 308,795,592 bytes) died with a SIGBUS panic on every
 * invocation — it is a Bun single-file executable that mmaps its own tail, so
 * a short file faults instead of erroring. Every routine logged `exit_code: 1`
 * in ~1ms, no session was ever created, and nothing anywhere said "your CLI is
 * broken".
 *
 * So: run `<cli> --version` on a short leash, require exit 0 AND a parseable
 * version, and keep the verdict where the status payload can read it. The
 * check is cheap enough to repeat (a healthy CLI answers in tens of ms) —
 * which matters because the damage happens at runtime, after boot, whenever
 * the CLI's own auto-updater rewrites the binary underneath us.
 */

import { getRuntime } from "./runtime/select";

export interface CliHealth {
  /** `--version` exited 0 and printed something version-shaped. */
  ok: boolean;
  /** Parsed version, e.g. "2.1.231" from "2.1.231 (Claude Code)". */
  version: string | null;
  /** Epoch ms of the check that produced this verdict. */
  checkedAt: number;
  /** Human-readable failure — exit code / signal plus the real stderr. */
  error: string | null;
  /** Binary that was probed, so an alert names the file to replace. */
  executable: string;
}

/** A hung CLI must not wedge boot; the healthy path answers in ~50ms. */
export const CLI_CHECK_TIMEOUT_MS = 15_000;

/** Keep alert/log text bounded — a panic dump can be long. */
const MAX_ERROR_CHARS = 2_000;

export interface CheckCliOptions {
  executable?: string;
  timeoutMs?: number;
}

/** First version-shaped token: "2.1.231 (Claude Code)" → "2.1.231". */
export function parseCliVersion(output: string): string | null {
  return /\d+\.\d+[\w.+-]*/.exec(output)?.[0] ?? null;
}

function truncate(text: string): string {
  const clean = text.trim();
  return clean.length > MAX_ERROR_CHARS ? `${clean.slice(0, MAX_ERROR_CHARS)}…` : clean;
}

/**
 * Run `<executable> --version` and judge the result. Never throws: a spawn
 * failure (missing binary, EACCES) is a verdict, not an exception.
 */
export async function checkCli(opts: CheckCliOptions = {}): Promise<CliHealth> {
  const executable = opts.executable ?? getRuntime().executablePath;
  const timeoutMs = opts.timeoutMs ?? CLI_CHECK_TIMEOUT_MS;
  const checkedAt = Date.now();
  try {
    const proc = Bun.spawn([executable, "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    // A truncated Bun executable SIGBUSes instantly, but a half-written one can
    // also hang — and a hang must not wedge boot. Race the read, not just the
    // process: a child that leaks the pipe to a grandchild keeps the stream
    // open long after a kill.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol("timeout");
    const read = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const outcome = await Promise.race([
      read,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (outcome === timedOut) {
      proc.kill("SIGKILL");
      return {
        ok: false,
        version: null,
        checkedAt,
        error: `${executable} --version did not answer within ${timeoutMs}ms`,
        executable,
      };
    }
    const [stdout, stderr, exitCode] = outcome;
    // Bun reports a fatal signal via `signalCode`; the panic text is the useful
    // part either way, so report both.
    const signal = proc.signalCode;
    const version = parseCliVersion(stdout);
    if (exitCode === 0 && version) {
      return { ok: true, version, checkedAt, error: null, executable };
    }
    const detail = truncate([stderr, stdout].filter(Boolean).join("\n")) || "(no output)";
    const how = signal ? `killed by ${signal}` : `exit ${exitCode}`;
    const why =
      exitCode === 0 && !version
        ? `${executable} --version printed no version (${how}): ${detail}`
        : `${executable} --version failed (${how}): ${detail}`;
    return { ok: false, version: null, checkedAt, error: why, executable };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      version: null,
      checkedAt,
      error: `${executable} --version could not run: ${truncate(msg)}`,
      executable,
    };
  }
}

// ── Cached verdict ──────────────────────────────────────────────────
// /api/state and /api/home are polled by the dashboard, so the payload reads
// this cache rather than spawning per request. A TTL refresh on read is what
// makes a mid-life CLI self-update visible without a restart.

let cached: CliHealth | null = null;
let inFlight: Promise<CliHealth> | null = null;

/** How stale a cached verdict may get before a read re-probes. */
export const CLI_HEALTH_TTL_MS = 5 * 60_000;

/** Last verdict without probing — null until the first check runs. */
export function getCachedCliHealth(): CliHealth | null {
  return cached;
}

type CliHealthListener = (health: CliHealth, previous: CliHealth | null) => void;
const listeners = new Set<CliHealthListener>();

/** Notified on every refresh; the daemon uses this to alert on a break. */
export function onCliHealthChecked(fn: CliHealthListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Probe (respecting the TTL unless `force`) and cache. Concurrent callers
 * share one in-flight probe so a burst of dashboard polls spawns once.
 */
export async function refreshCliHealth(
  opts: CheckCliOptions & { force?: boolean } = {},
): Promise<CliHealth> {
  const { force = false, ...checkOpts } = opts;
  if (!force && cached && Date.now() - cached.checkedAt < CLI_HEALTH_TTL_MS) {
    return cached;
  }
  if (inFlight) return inFlight;
  inFlight = checkCli(checkOpts)
    .then((health) => {
      const previous = cached;
      cached = health;
      for (const fn of listeners) {
        try {
          fn(health, previous);
        } catch {
          /* a listener must never break the probe */
        }
      }
      return health;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Tests only — drop the cached verdict and listeners. */
export function resetCliHealth(): void {
  cached = null;
  inFlight = null;
  listeners.clear();
}
