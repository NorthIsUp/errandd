import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the directory where Claude Code stores a project's JSONL transcripts:
 * `~/.claude/projects/<sanitized-cwd>`.
 *
 * Reproduces Claude Code's project-dir sanitizer: every slash, backslash, and
 * dot in the absolute cwd becomes a dash. This is the SINGLE source of truth —
 * `threadParts.ts`, `usage.ts`, `sessions.ts`, and `skip.ts` all call it instead
 * of carrying their own copy.
 *
 * NOTE: the `.replace(/\//g, "-")` variant used by the discord/telegram session
 * code is NOT the same sanitizer (it leaves dots and backslashes intact) and
 * must not be substituted here.
 */
export function claudeProjectDir(cwd: string = process.cwd()): string {
  const sanitized = cwd.replace(/[/\\.]/g, "-");
  return join(homedir(), ".claude", "projects", sanitized);
}
