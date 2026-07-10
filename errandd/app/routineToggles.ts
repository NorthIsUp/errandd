/**
 * Durable on/off overlay for routines — errandd's own opinion about whether a
 * routine should fire, kept SEPARATE from the routine's `.md` file so toggling
 * one from the Errands view never rewrites (or has to push) the jobs repo.
 *
 * A routine's identity is `repo-slug + filename` (routines can come from several
 * jobs repos, so the bare filename isn't unique). `routineKey()` is the single
 * source of that key; local (non-repo) routines have an empty slug and key on
 * the filename alone.
 *
 * Storage matches the settings.json idiom (a small JSON file under the state
 * dir, not a new store tech): only the DISABLED keys are persisted, so the
 * default — absent from the set — is ENABLED. Existing routines therefore keep
 * running until someone explicitly turns one off.
 *
 * The set is hydrated once from disk and cached in memory; `loadJobs()` (the
 * single chokepoint both the scheduler and the hook matcher read through) awaits
 * the hydrate and drops any disabled routine, so a disabled routine fires
 * neither on cron nor on a webhook event.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const TOGGLES_FILE = join(process.cwd(), ".claude", "errandd", "routine-toggles.json");

/** In-memory cache of disabled keys. `null` until first hydrate. */
let cache: Set<string> | null = null;

/** Build the overlay key for a routine. Strips a trailing `.md` so callers can
 *  pass either a filename (`foo.md`, from the file listing) or a job stem
 *  (`foo`, from loadJobs) and land on the same key. Repo routines are
 *  `<slug>/<stem>`; local (no-slug) routines are just `<stem>`. */
export function routineKey(slug: string | null | undefined, name: string): string {
  const stem = name.replace(/\.md$/, "");
  return slug ? `${slug}/${stem}` : stem;
}

/** Hydrate the disabled-set from disk once, then return the cached set.
 *  Fails OPEN (empty set = everything enabled) on a missing/corrupt file — a
 *  broken overlay must never silently disable routines. */
export async function loadRoutineToggles(): Promise<Set<string>> {
  if (cache) return cache;
  try {
    if (existsSync(TOGGLES_FILE)) {
      const raw = JSON.parse(await Bun.file(TOGGLES_FILE).text()) as { disabled?: unknown };
      const disabled = Array.isArray(raw.disabled)
        ? raw.disabled.filter((x): x is string => typeof x === "string")
        : [];
      cache = new Set(disabled);
    } else {
      cache = new Set();
    }
  } catch {
    cache = new Set();
  }
  return cache;
}

/** True when the routine is enabled (default). Hydrates on first call. */
export async function isRoutineEnabled(key: string): Promise<boolean> {
  return !(await loadRoutineToggles()).has(key);
}

/** Persist a single routine's enabled state, then update the in-memory cache.
 *  `enabled: true` removes the key (back to the default); `false` records it. */
export async function setRoutineEnabled(key: string, enabled: boolean): Promise<void> {
  const set = await loadRoutineToggles();
  if (enabled) {
    set.delete(key);
  } else {
    set.add(key);
  }
  await mkdir(dirname(TOGGLES_FILE), { recursive: true });
  await Bun.write(TOGGLES_FILE, `${JSON.stringify({ disabled: [...set].sort() }, null, 2)}\n`);
}

/** Test-only: drop the in-memory cache so the next call re-reads disk
 *  (simulates a restart). */
export function __resetRoutineTogglesForTests(): void {
  cache = null;
}
