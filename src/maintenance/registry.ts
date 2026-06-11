/**
 * THE one place every migration + cleanup is declared. To add data-maintenance
 * work, register an entry here — don't scatter ad-hoc file-poking elsewhere.
 *
 * Each entry's `run()` delegates to the owning subsystem (sessionManager, the
 * queues, …) so the logic stays with its data; this file is just the registry
 * the harness (`index.ts`) reads.
 */
import { migrateLegacySessionStore, pruneStaleSessions } from "../sessionManager";
import { gitMaintenance } from "./gitMaintenance";
import type { Cleanup, Migration } from "./index";
import { recoverClobberedThreads } from "./recoverClobberedThreads";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Run-once, ordered, ledgered. Never rename a shipped id. */
export const MIGRATIONS: Migration[] = [
  {
    id: "0001-sessions-json-to-jsonl",
    description: "Convert the legacy single-blob sessions.json to the append-only sessions.jsonl store",
    run: migrateLegacySessionStore,
  },
];

/** Run every boot + hourly tick. Must be idempotent (no-op when nothing to do). */
export const CLEANUPS: Cleanup[] = [
  {
    id: "prune-hook-queue",
    description: "Drop hook-queue rows older than 7 days",
    run: async () => {
      const { getHookQueue } = await import("../hookQueue");
      const n = getHookQueue().prune(WEEK_MS);
      return n > 0 ? `pruned ${n} hook-queue row(s)` : "";
    },
  },
  {
    id: "prune-interactive-queue",
    description: "Drop interactive-message-queue rows older than 7 days",
    run: async () => {
      const { getInteractiveQueue } = await import("../messaging/interactiveQueue");
      const n = getInteractiveQueue().prune(WEEK_MS);
      return n > 0 ? `pruned ${n} interactive-queue row(s)` : "";
    },
  },
  {
    id: "prune-stale-sessions",
    description: "Drop thread sessions idle > 30 days (keeps the session store bounded)",
    run: async () => {
      const n = await pruneStaleSessions();
      return n > 0 ? `pruned ${n} stale thread session(s)` : "";
    },
  },
  {
    id: "recover-clobbered-threads",
    description: "Re-map threads whose history was overwritten by a skip placeholder back to their real transcript",
    run: recoverClobberedThreads,
  },
  {
    id: "git-maintenance",
    description: "Keep the managed jobs-repo clones healthy (git maintenance register + run --auto)",
    run: gitMaintenance,
  },
  {
    id: "prune-sentry-seen",
    description: "Drop Sentry first-seen ledger rows older than 90 days (lets a long-silent issue re-triage)",
    run: async () => {
      const { pruneSentrySeen, DEFAULT_SENTRY_SEEN_TTL_MS } = await import("../hooks/sentrySeen");
      const n = pruneSentrySeen(DEFAULT_SENTRY_SEEN_TTL_MS);
      return n > 0 ? `pruned ${n} sentry-seen row(s)` : "";
    },
  },
];
