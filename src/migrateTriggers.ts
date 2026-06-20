/**
 * One-time, idempotent migration of routine `.md` frontmatter from the old
 * trigger layout to the unified `on:` list.
 *
 * Old form spread triggers across a top-level `schedule:` string, a top-level
 * `recurring:` bool, and an `on:` MAPPING (prs/pr/comments/sentry/datadog/
 * skip_self). New form keeps recurring/notify/enabled/skip_self as top-level
 * scalars and collapses the triggers into a single `on:` LIST of single-key
 * dicts:
 *
 *   on:
 *     - schedule: "0 9 * * *"
 *     - pr: { repo: "*\/*", ... }
 *     - comments: { user: ["*"] }
 *     - sentry: true
 *
 * Runs at daemon boot (before loadJobs) and as `scripts/migrate-triggers.ts`.
 * Detection is conservative so re-running on already-migrated files is a no-op.
 */
import { readdir } from "fs/promises";
import { join } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getAgentsDir, getJobsDirs } from "./config";

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/**
 * Rewrite one file's content to the new form, or return null if it's already
 * new-form (or has no frontmatter). Old-form = a top-level `schedule:` key OR
 * an `on:` that is a mapping (not a list).
 */
export function migrateFrontmatterText(content: string): string | null {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return null;

  let fm: Record<string, unknown> | null;
  try {
    const parsed = parseYaml(m[1] ?? "");
    fm = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null; // unparseable frontmatter — leave it alone
  }
  if (!fm) return null;

  const hasTopSchedule = "schedule" in fm;
  const onIsMapping = fm.on != null && typeof fm.on === "object" && !Array.isArray(fm.on);
  if (!hasTopSchedule && !onIsMapping) return null; // already new-form

  const onList: Record<string, unknown>[] = [];

  // 1. schedule entry first (only when non-empty)
  const sched = typeof fm.schedule === "string" ? fm.schedule.trim() : "";
  if (sched) onList.push({ schedule: sched });
  delete fm.schedule;

  // 2. event triggers, lifted out of the old `on:` mapping
  const oldOn = (onIsMapping ? (fm.on as Record<string, unknown>) : {});
  if (oldOn.prs === true || oldOn.prs === "true") onList.push({ prs: true });
  if (oldOn.pr !== undefined) {
    const prs = Array.isArray(oldOn.pr) ? oldOn.pr : [oldOn.pr];
    for (const p of prs) onList.push({ pr: p });
  }
  if (oldOn.comments !== undefined) onList.push({ comments: oldOn.comments });
  if (oldOn.sentry !== undefined) onList.push({ sentry: oldOn.sentry });
  if (oldOn.datadog !== undefined) onList.push({ datadog: oldOn.datadog });

  // 3. skip_self moves from the old `on:` mapping to a top-level key
  if (onIsMapping && "skip_self" in oldOn && !("skip_self" in fm)) {
    fm.skip_self = oldOn.skip_self;
  }

  if (onList.length > 0) fm.on = onList;
  else delete fm.on;

  const body = (m[2] ?? "").trim();
  return `---\n${stringifyYaml(fm).trim()}\n---\n${body}\n`;
}

/** All directories that may hold routine .md files (mirrors loadJobs). */
async function jobDirs(): Promise<string[]> {
  const dirs = [...getJobsDirs()];
  try {
    for (const agent of await readdir(getAgentsDir())) {
      dirs.push(join(getAgentsDir(), agent, "jobs"));
    }
  } catch {
    /* no agents dir — fine */
  }
  return dirs;
}

/**
 * Migrate every old-form routine file in place. Returns the count rewritten.
 * Idempotent: new-form files are left byte-for-byte unchanged.
 */
export async function migrateTriggers(): Promise<number> {
  let count = 0;
  for (const dir of await jobDirs()) {
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const path = join(dir, f);
      try {
        const content = await Bun.file(path).text();
        const next = migrateFrontmatterText(content);
        if (next && next !== content) {
          await Bun.write(path, next);
          count++;
        }
      } catch {
        /* skip unreadable file */
      }
    }
  }
  return count;
}
