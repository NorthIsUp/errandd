import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Path to the `claude` CLI we should spawn.
 *
 * On macOS/Linux it's just `claude` (resolved via PATH).
 *
 * On Windows, `claude` resolves to a `.cmd` shim that re-exec's via npm; we
 * want the underlying `claude.exe` binary so child processes get a real
 * console handle (the `.cmd` path breaks colored output + signal handling
 * inside detached daemons). Falls back to plain `claude` if `where` or the
 * conventional install path fails.
 */
function resolve(): string {
  if (process.platform !== "win32") return "claude";
  try {
    const out = execSync("where claude", { encoding: "utf8" });
    const cmdPath = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.toLowerCase().endsWith(".cmd"));
    if (!cmdPath) return "claude";
    const exePath = join(
      dirname(cmdPath),
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    );
    return existsSync(exePath) ? exePath : "claude";
  } catch {
    return "claude";
  }
}

export const CLAUDE_EXECUTABLE = resolve();

/**
 * Build a sanitized env for spawning the `claude` CLI as a long-running daemon
 * subprocess. Drops env vars injected by a parent Claude Code / Claude Desktop
 * session that would break a detached child's auth:
 *
 * - `CLAUDECODE` — marks "we're nested inside Claude Code"; triggers the
 *   CLI's transcript-aware reentry behaviour we don't want from a daemon.
 * - `CLAUDE_CODE_OAUTH_TOKEN` — parent's frozen OAuth access token. Without
 *   the matching refresh token (which lives in the platform-native credential
 *   store, not the env) it expires after ~8h and the daemon's spawned
 *   `claude` processes start returning HTTP 401 silently. Stripping it lets
 *   the CLI fall back to its per-platform credential code path (Keychain on
 *   macOS, `~/.claude/.credentials.json` on Linux/WSL2, Credential Manager on
 *   Windows) which handles refresh automatically.
 * - `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` — tells the CLI "the host process
 *   manages provider auth — don't read local credentials." In a detached
 *   daemon there is no host; the CLI errors with `Not logged in`.
 */
export function cleanSpawnEnv(): Record<string, string> {
  const stripped = new Set([
    "CLAUDECODE",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  ]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (stripped.has(key)) continue;
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
