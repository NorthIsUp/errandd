/**
 * Repo-pointing git env vars override `cwd` (and `-C`) entirely, so inheriting
 * them makes every git command silently operate on whatever repo the parent
 * process was in — a git hook, a `git rebase --exec`, an IDE. `hk` runs the
 * test suite from the repo's own pre-push hook, where git exports GIT_DIR:
 * that is how `git init --bare` in a temp dir once created a bare repo on top
 * of this checkout and rewrote its `.git/config`.
 *
 * Every git shell-out in the daemon goes through this.
 */
const REPO_POINTING_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
] as const;

export function gitEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const key of REPO_POINTING_VARS) {
    delete env[key];
  }
  return env;
}
