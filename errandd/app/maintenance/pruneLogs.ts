/**
 * Age out the daemon's own run logs.
 *
 * Every routine run writes `<name>-<timestamp>.log` into `~/.claude/errandd/logs`
 * and nothing ever removed them: 190,142 files / 1.6GiB on the deployed pod,
 * a fifth of what filled the state volume. Unlike transcripts these are pure
 * operational noise once a month old — no archive, just delete.
 */
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Run logs older than this are deleted. Override: ERRANDD_LOG_RETENTION_DAYS. */
export const DEFAULT_LOG_RETENTION_DAYS = 30;

/** Matches config.ts's LOGS_DIR. Resolved per call so tests can point elsewhere. */
function defaultLogsDir(): string {
  return join(process.cwd(), ".claude", "errandd", "logs");
}

/** `0` or a negative value keeps logs forever. */
export function logRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.ERRANDD_LOG_RETENTION_DAYS ?? "").trim();
  if (!raw) {
    return DEFAULT_LOG_RETENTION_DAYS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_LOG_RETENTION_DAYS;
}

export interface LogFile {
  name: string;
  mtimeMs: number;
}

/** Pure half — which logs the cutoff condemns. */
export function selectExpired(files: LogFile[], cutoffMs: number): string[] {
  return files.filter((f) => f.mtimeMs < cutoffMs).map((f) => f.name);
}

/**
 * Delete run logs older than `ERRANDD_LOG_RETENTION_DAYS`. Idempotent; returns a
 * one-line summary (empty when nothing expired) per the maintenance-harness
 * contract.
 */
export async function pruneLogs(logsDir = defaultLogsDir()): Promise<string> {
  const days = logRetentionDays();
  if (days <= 0) {
    return ""; // retention disabled
  }

  let entries;
  try {
    entries = await readdir(logsDir, { withFileTypes: true });
  } catch {
    return ""; // no logs dir yet
  }

  const files: LogFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    try {
      files.push({ name: entry.name, mtimeMs: (await stat(join(logsDir, entry.name))).mtimeMs });
    } catch {
      // vanished mid-walk — a routine is still rotating its own log
    }
  }

  const expired = selectExpired(files, Date.now() - days * DAY_MS);
  let removed = 0;
  let reclaimed = 0;
  for (const name of expired) {
    const full = join(logsDir, name);
    try {
      const size = (await stat(full)).size;
      await unlink(full);
      removed += 1;
      reclaimed += size;
    } catch {
      // already gone, or held open — next tick
    }
  }

  if (removed === 0) {
    return "";
  }
  const mib = (reclaimed / 1024 / 1024).toFixed(0);
  return `deleted ${removed} run log(s) older than ${days}d, reclaimed ~${mib}MiB`;
}
