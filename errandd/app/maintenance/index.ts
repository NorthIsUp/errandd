/**
 * Maintenance harness — the ONE place data migrations and cleanups live.
 *
 * Instead of scattering "open file, if its contents look like X then rewrite it"
 * logic across the codebase, every one-time data migration and every recurring
 * housekeeping task is registered in `registry.ts` and run from here.
 *
 *   - **Migrations** run ONCE, in order, and are recorded in a ledger
 *     (`.claude/errandd/maintenance.jsonl`) so they never re-run. Forward-only:
 *     if one fails, later migrations are held back until it succeeds.
 *   - **Cleanups** run EVERY boot (and on the hourly tick). They must be
 *     idempotent — a no-op when there's nothing to do.
 *
 * `runMaintenance()` is called once at daemon startup; `runCleanups()` is also
 * called from the hourly housekeeping tick. Both are best-effort: a failing
 * cleanup is logged and the rest still run.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CLEANUPS, MIGRATIONS } from "./registry";

const DIR = join(process.cwd(), ".claude", "errandd");
const LEDGER = join(DIR, "maintenance.jsonl");

/** A unit of maintenance work. `run` is idempotent and returns a one-line
 *  human summary (empty string ⇒ "nothing to do", suppressed from logs). */
export interface MaintenanceTask {
  /** Stable unique id. Migrations are applied in array order; the id is what's
   *  recorded in the ledger, so never rename a shipped migration's id. */
  id: string;
  description: string;
  run: () => Promise<string>;
}

export type Migration = MaintenanceTask;
export type Cleanup = MaintenanceTask;

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [maintenance] ${msg}`);
}

/** Ledger of applied migration ids (one `{id, at}` per line). */
async function loadApplied(): Promise<Set<string>> {
  const applied = new Set<string>();
  let text: string;
  try {
    text = await readFile(LEDGER, "utf-8");
  } catch {
    return applied; // no ledger yet
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const id = (JSON.parse(trimmed) as { id?: unknown }).id;
      if (typeof id === "string") applied.add(id);
    } catch {
      // skip a torn line
    }
  }
  return applied;
}

async function recordApplied(id: string): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await appendFile(LEDGER, `${JSON.stringify({ id, at: new Date().toISOString() })}\n`);
}

/** Apply any pending migrations in order (forward-only), recording each. */
async function runMigrations(): Promise<void> {
  const applied = await loadApplied();
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    try {
      const summary = await m.run();
      await recordApplied(m.id);
      log(`migration ${m.id}: ${summary || "done"}`);
    } catch (err) {
      // Forward-only: hold back later migrations until this one succeeds next boot.
      log(`migration ${m.id} FAILED — halting further migrations: ${String(err)}`);
      return;
    }
  }
}

/** Run every cleanup (best-effort, idempotent). Safe to call repeatedly. */
export async function runCleanups(): Promise<void> {
  for (const c of CLEANUPS) {
    try {
      const summary = await c.run();
      if (summary) log(`cleanup ${c.id}: ${summary}`);
    } catch (err) {
      log(`cleanup ${c.id} failed: ${String(err)}`);
    }
  }
}

/** Full startup pass: pending migrations, then all cleanups. */
export async function runMaintenance(): Promise<void> {
  await runMigrations();
  await runCleanups();
}
