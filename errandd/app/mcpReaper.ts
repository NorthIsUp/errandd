/**
 * Reap orphaned MCP server processes.
 *
 * The agent CLI spawns each configured *stdio* MCP server as a child of the
 * session. errandd kills the session process itself (SIGTERM, then SIGKILL),
 * but that signal does not reach the session's own children — so every
 * abnormally-ended session leaves its MCP servers behind, reparented to init.
 *
 * They do not idle quietly. Measured on the deployed daemon: an MCP server
 * attached to a live session sits at ~110-130MB, but once orphaned onto a dead
 * stdio pipe it grows to 0.5-2.2GB. Five of them reached 5.7GB and OOM-killed
 * the 10Gi container roughly every five minutes, taking the whole dashboard
 * down with it.
 *
 * SAFETY NET, not the primary defence. claude-spawn.ts now spawns sessions
 * `detached` and sweeps the process group on every exit path, which stops the
 * orphaning at source.
 *
 * This file used to claim group-kill was impossible because `setsid` doesn't
 * exist on macOS. Two things wrong with that, and the second is the one worth
 * remembering. It named the setsid *binary* when Bun's `detached` calls the
 * setsid(2) *syscall*, which macOS has anyway — but more to the point, this
 * daemon runs in a Linux container. A local-dev portability worry was allowed
 * to set the memory behaviour of production, where it never applied, and even
 * had it been true the answer was a platform guard rather than a permanent
 * leak. Measured cost before anyone checked: 2.64GB of orphans on average,
 * peaking at 6.87GB against a 10Gi limit.
 *
 * Kept because a group sweep cannot cover every case: a session the kernel
 * OOM-kills, or one that segfaults before the daemon sees it exit, still
 * leaves debris, as does anything spawned outside claude-spawn.ts.
 */

const PPID_INIT = 1;

/**
 * Grace period before an init-parented process counts as orphaned.
 *
 * A pure safety margin, not a correctness requirement: a live session's MCP
 * servers are its *children*, so `ppid === 1` already means the session is
 * gone. Was 60s, which — paired with the 60s reap tick — let an orphan live up
 * to ~2 minutes. Measured on the deployed daemon 2026-08-18: seven orphans aged
 * 29-74s holding 3.4GB, about 90% of the container's 3.7GB RSS. 15s keeps a
 * margin against a `ps` snapshot catching a process mid-reparent while cutting
 * that steady-state garbage roughly fourfold.
 */
const MIN_AGE_SECONDS = 15;

/** A process as read from `ps`. */
export interface ProcSnapshot {
  pid: number;
  ppid: number;
  /** Elapsed seconds since start. */
  ageSeconds: number;
  command: string;
}

/**
 * Parse `ps -eo pid=,ppid=,etimes=,args=` output. `etimes` (elapsed seconds) is
 * procps-only; on a platform without it `ps` fails and the caller no-ops, which
 * is the right outcome — orphan accumulation is a long-running-daemon problem.
 */
export function parsePs(stdout: string): ProcSnapshot[] {
  const out: ProcSnapshot[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      ageSeconds: Number(m[3]),
      command: (m[4] ?? "").trim(),
    });
  }
  return out;
}

/**
 * Orphaned MCP servers: parented to init, old enough that the reparenting
 * wasn't a momentary race, and identifiable as an MCP server.
 *
 * Deliberately narrow. `ppid === 1` alone would also match a container's
 * legitimate long-running init children (and, under a shared process namespace,
 * processes belonging to sibling containers entirely) — so the command must
 * also name itself an MCP server. `self` is never a candidate.
 */
export function selectOrphanedMcp(procs: ProcSnapshot[], self: number): ProcSnapshot[] {
  return procs.filter(
    (p) =>
      p.ppid === PPID_INIT &&
      p.pid !== self &&
      p.pid !== PPID_INIT &&
      p.ageSeconds >= MIN_AGE_SECONDS &&
      /mcp/i.test(p.command) &&
      // `ps` itself, and the shell running it, can match "mcp" via our own
      // command line — never target a process that is just reporting on them.
      !/\bps\b|grep|mcpReaper/.test(p.command),
  );
}

/** Read the process table. Returns null when `ps` is unavailable/unsupported. */
async function readProcs(): Promise<ProcSnapshot[] | null> {
  try {
    const proc = Bun.spawn(["ps", "-eo", "pid=,ppid=,etimes=,args="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) {
      return null;
    }
    return parsePs(text);
  } catch {
    return null;
  }
}

/**
 * Kill orphaned MCP servers. Idempotent; returns a one-line summary (empty when
 * there was nothing to do) per the maintenance-harness contract.
 */
export async function reapOrphanedMcp(): Promise<string> {
  const procs = await readProcs();
  if (!procs) {
    return "";
  }
  const orphans = selectOrphanedMcp(procs, process.pid);
  if (orphans.length === 0) {
    return "";
  }

  let killed = 0;
  for (const orphan of orphans) {
    try {
      // SIGKILL, not SIGTERM: these are already wedged on a dead stdio pipe and
      // a polite signal gives them another interval to keep growing.
      process.kill(orphan.pid, "SIGKILL");
      killed += 1;
    } catch {
      // already gone, or not ours to signal
    }
  }
  return killed > 0 ? `reaped ${killed} orphaned MCP server process(es)` : "";
}
