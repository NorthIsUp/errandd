import { writeFile, unlink, readFile } from "fs/promises";
import { join } from "path";

const PID_FILE = join(process.cwd(), ".claude", "errandd", "daemon.pid");

export function getPidPath(): string {
  return PID_FILE;
}

/** Reject process-group IDs and malformed PID files before any signal is sent. */
export function parseDaemonPid(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 && pid <= 2_147_483_647 ? pid : null;
}

/**
 * Check if a daemon is already running in this directory.
 * If a stale PID file exists (process dead), it gets cleaned up.
 * Returns the running PID if alive, or null.
 */
export async function checkExistingDaemon(): Promise<number | null> {
  let raw: string;
  try {
    raw = (await readFile(PID_FILE, "utf-8")).trim();
  } catch {
    return null; // no pid file
  }

  const pid = parseDaemonPid(raw);
  if (pid === null) {
    await cleanupPidFile();
    return null;
  }

  try {
    process.kill(pid, 0); // signal 0 = just check if alive
    return pid;
  } catch {
    // process is dead, clean up stale pid file
    await cleanupPidFile();
    return null;
  }
}

export async function writePidFile(): Promise<void> {
  await writeFile(PID_FILE, String(process.pid) + "\n");
}

export async function cleanupPidFile(): Promise<void> {
  try {
    await unlink(PID_FILE);
  } catch {
    // already gone
  }
}
