/**
 * Cleanup: keep the daemon's managed git repos (the jobs-repo clones) healthy
 * with `git maintenance`.
 *
 * `git maintenance start` would install an OS scheduler (launchd/cron/systemd),
 * which doesn't exist inside the container — so instead we `register` each repo
 * (idempotent; enables the incremental task set) and `run --auto` it here on the
 * hourly maintenance tick. `--auto` only does work when thresholds are met, so
 * it's cheap. This handles gc / incremental-repack / commit-graph / loose-objects
 * / pack-refs; branch CURRENCY is still the 5-min `pullRepo` auto-sync's job
 * (maintenance keeps the object store lean + the next fetch fast, it doesn't
 * advance branches).
 *
 * Enumerates `getJobsDirs()` each run, so new clones are picked up automatically
 * and removed ones drop out — no per-clone wiring needed.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Run a git subcommand in `cwd`, swallowing output. Returns true on exit 0. */
async function git(cwd: string, args: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export async function gitMaintenance(): Promise<string> {
  const { getJobsDirs } = await import("../config");
  const repos = getJobsDirs().filter((d) => existsSync(join(d, ".git")));
  if (repos.length === 0) {
    return "";
  }
  let ran = 0;
  for (const dir of repos) {
    // register is idempotent (no-op if already enrolled); it enables the
    // incremental task set so `run` knows what to do. (No --quiet: register
    // doesn't accept it; output is swallowed by the spawn anyway.)
    await git(dir, ["maintenance", "register"]);
    if (await git(dir, ["maintenance", "run", "--auto", "--quiet"])) {
      ran += 1;
    }
  }
  return ran > 0 ? `git maintenance ran on ${ran}/${repos.length} managed repo(s)` : "";
}
