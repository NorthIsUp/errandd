/**
 * Guarded install/update of the Claude CLI.
 *
 * The outage this exists to prevent: an install wrote the ~310MB binary onto a
 * volume with 5.8M free, ENOSPC truncated it, and the truncated file stayed in
 * place as the daemon's CLI. So every install here (a) checks free space on the
 * mount the CLI actually lives on — not `/`, not `/tmp`, both of which showed
 * 71G free on the pod while the state volume was full — (b) stages into a
 * sibling directory, (c) smoke-tests the staged binary, and only then (d)
 * renames it into place. A failed install leaves the previous CLI untouched.
 *
 * bun, not npm: it is the owner's preference and it is what produced a correct
 * full-size install when recovering the incident by hand.
 */

import { existsSync, renameSync, rmSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { checkCli, type CliHealth } from "./cliHealth";

export const CLI_PACKAGE = "@anthropic-ai/claude-code";

/** Observed size of the 2.1.231 binary: 308,795,592 bytes. */
export const CLI_BINARY_BYTES = 310_000_000;

/**
 * Free space demanded before an install runs. Three times the binary because
 * an install stages a full copy next to the existing one and unpacks a tarball
 * on the way — "it just fits" is how the incident started.
 */
export const CLI_INSTALL_MIN_FREE_BYTES = 3 * CLI_BINARY_BYTES;

export interface DiskHeadroom {
  ok: boolean;
  /** Directory the check was made against. */
  path: string;
  freeBytes: number;
  requiredBytes: number;
  error: string | null;
}

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

/**
 * Free bytes on the filesystem holding `path`, walking up to the nearest
 * existing ancestor (statfs on a not-yet-created directory throws). Returns
 * null when the filesystem can't be interrogated — callers treat that as
 * "unknown", not "fine".
 */
export function freeBytesAt(path: string): number | null {
  let probe = path;
  for (;;) {
    if (existsSync(probe)) {
      try {
        const fs = statfsSync(probe);
        return Number(fs.bavail) * Number(fs.bsize);
      } catch {
        return null;
      }
    }
    const parent = dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
}

export interface HeadroomOptions {
  requiredBytes?: number;
  /** Injectable probe (tests / a caller that already measured). */
  freeBytes?: (path: string) => number | null;
}

/** Refuse rather than write a truncated binary. */
export function checkInstallHeadroom(path: string, opts: HeadroomOptions = {}): DiskHeadroom {
  const requiredBytes = opts.requiredBytes ?? CLI_INSTALL_MIN_FREE_BYTES;
  const probe = opts.freeBytes ?? freeBytesAt;
  const free = probe(path);
  if (free === null) {
    return {
      ok: false,
      path,
      freeBytes: -1,
      requiredBytes,
      error: `cannot determine free space on the filesystem holding ${path}`,
    };
  }
  if (free < requiredBytes) {
    return {
      ok: false,
      path,
      freeBytes: free,
      requiredBytes,
      error:
        `refusing to install ${CLI_PACKAGE}: ${gb(free)} free on the mount holding ${path}, ` +
        `need ${gb(requiredBytes)} (the binary alone is ${gb(CLI_BINARY_BYTES)})`,
    };
  }
  return { ok: true, path, freeBytes: free, requiredBytes, error: null };
}

/** ENOSPC as it shows up in installer output, so we can name it instead of
 *  reporting a generic non-zero exit. */
export function isEnospc(output: string): boolean {
  return /ENOSPC|No space left on device|disk (?:is )?full/i.test(output);
}

/** Root bun installs globals under: `$BUN_INSTALL/bin/<name>`. */
export function defaultInstallRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.BUN_INSTALL ?? join(env.HOME ?? homedir(), ".bun");
}

export interface InstallCliOptions {
  /** Version to pin; omit for the dist-tag default (latest). */
  version?: string;
  /** `$BUN_INSTALL` root to install into. Defaults to the daemon's. */
  root?: string;
  /** Binary name inside `<root>/bin`. */
  binName?: string;
  headroom?: HeadroomOptions;
  /** Injectable installer, for tests. Receives the staging root. */
  runInstall?: (ctx: { root: string; spec: string }) => Promise<{ exitCode: number; output: string }>;
  /** Injectable smoke test, for tests. */
  smoke?: (executable: string) => Promise<CliHealth>;
}

export interface InstallCliResult {
  ok: boolean;
  version: string | null;
  executable: string;
  error: string | null;
  headroom: DiskHeadroom;
}

async function bunAddGlobal(ctx: { root: string; spec: string }) {
  const proc = Bun.spawn(["bun", "add", "-g", ctx.spec], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, BUN_INSTALL: ctx.root },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, output: `${stdout}\n${stderr}`.trim() };
}

/**
 * Install/update the CLI: headroom check → staged install → smoke test →
 * atomic swap. Never leaves a half-written binary where the daemon will spawn
 * it; on any failure the previous install stays in place.
 */
export async function installCli(opts: InstallCliOptions = {}): Promise<InstallCliResult> {
  const root = opts.root ?? defaultInstallRoot();
  const binName = opts.binName ?? "claude";
  const executable = join(root, "bin", binName);
  const spec = opts.version ? `${CLI_PACKAGE}@${opts.version}` : CLI_PACKAGE;

  const headroom = checkInstallHeadroom(root, opts.headroom);
  if (!headroom.ok) {
    return { ok: false, version: null, executable, error: headroom.error, headroom };
  }

  const staging = `${root}.staging`;
  const previous = `${root}.previous`;
  const runInstall = opts.runInstall ?? bunAddGlobal;
  const smoke = opts.smoke ?? ((exe: string) => checkCli({ executable: exe }));
  const fail = (error: string): InstallCliResult => {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, version: null, executable, error, headroom };
  };

  rmSync(staging, { recursive: true, force: true });
  const install = await runInstall({ root: staging, spec });
  if (install.exitCode !== 0) {
    const cause = isEnospc(install.output)
      ? `out of space while installing ${spec} (ENOSPC) — nothing was swapped in`
      : `installing ${spec} failed (exit ${install.exitCode})`;
    return fail(`${cause}: ${install.output || "(no output)"}`);
  }
  if (isEnospc(install.output)) {
    // bun has exited 0 with ENOSPC noise before; a short write is exactly the
    // failure that started this, so treat any mention as fatal.
    return fail(`out of space while installing ${spec} (ENOSPC) — nothing was swapped in`);
  }

  const stagedExe = join(staging, "bin", binName);
  const health = await smoke(stagedExe);
  if (!health.ok) {
    return fail(`staged ${spec} failed its smoke test — install discarded: ${health.error}`);
  }

  // Same-filesystem renames: the old root steps aside, the verified one takes
  // its place, then the old copy is dropped.
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(root)) renameSync(root, previous);
  try {
    renameSync(staging, root);
  } catch (err) {
    if (existsSync(previous)) renameSync(previous, root);
    return fail(`could not swap the verified install into ${root}: ${String(err)}`);
  }
  rmSync(previous, { recursive: true, force: true });
  return { ok: true, version: health.version, executable, error: null, headroom };
}
