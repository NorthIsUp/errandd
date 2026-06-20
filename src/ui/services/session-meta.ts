import { mkdir, readdir, stat, unlink } from "fs/promises";
import { join } from "path";

const META_FILE = join(process.cwd(), ".claude", "clawdcode", "session-meta.json");
// Full webhook payloads can be tens of KB, so they live in per-session files
// rather than bloating the shared session-meta.json. Used by the chat
// full-JSON disclosure, the "copy hook JSON" button, and hook reprocessing.
const HOOK_PAYLOAD_DIR = join(process.cwd(), ".claude", "clawdcode", "hook-payloads");
// Retain hook payloads for 30 days, then prune so the volume doesn't grow
// unbounded. Swept opportunistically on write (throttled hourly).
const HOOK_PAYLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
let _lastHookPrune = 0;

export interface StoredHookPayload {
  event: string;
  payload: unknown;
}

/** Session IDs are UUIDs; guard anyway so a crafted id can't escape the dir. */
function hookPayloadPath(id: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null;
  return join(HOOK_PAYLOAD_DIR, `${id}.json`);
}

/** Delete hook-payload files older than the 30-day TTL. Throttled to run at
 *  most once an hour; all errors are swallowed (best-effort housekeeping). */
export async function pruneHookPayloads(now = Date.now()): Promise<void> {
  if (now - _lastHookPrune < 60 * 60 * 1000) return;
  _lastHookPrune = now;
  const files = await readdir(HOOK_PAYLOAD_DIR).catch(() => null);
  if (files === null) return; // dir doesn't exist yet — nothing to prune
  await Promise.all(
    files.map(async (f) => {
      if (!f.endsWith(".json")) return;
      const p = join(HOOK_PAYLOAD_DIR, f);
      try {
        const s = await stat(p);
        if (now - s.mtimeMs > HOOK_PAYLOAD_TTL_MS) await unlink(p);
      } catch {
        // ignore unreadable / already-removed
      }
    }),
  );
}

export async function setSessionHookPayload(
  id: string,
  event: string,
  payload: unknown,
): Promise<void> {
  const path = hookPayloadPath(id);
  if (!path) return;
  await mkdir(HOOK_PAYLOAD_DIR, { recursive: true });
  await Bun.write(path, JSON.stringify({ event, payload } satisfies StoredHookPayload));
  void pruneHookPayloads();
}

export async function getSessionHookPayload(id: string): Promise<StoredHookPayload | null> {
  const path = hookPayloadPath(id);
  if (!path) return null;
  try {
    const data = (await Bun.file(path).json()) as StoredHookPayload;
    return data && typeof data === "object" && "payload" in data ? data : null;
  } catch {
    return null;
  }
}

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * What kicked off this session. Set once at session creation by the
 * daemon's hook-fire / cron-fire paths and rendered as the "Trigger"
 * column on the Runs view.
 *
 * A given job can have BOTH a schedule and hook config; we want the row
 * to reflect what actually started THIS run, not the union of what the
 * job is configured for — so this lives on the session, not the job.
 */
export type SessionTrigger =
  | {
      kind: "hook";
      event: string;
      action?: string;
      repo?: string;
      pr?: { number: number; url?: string };
      actor?: string;
    }
  | { kind: "schedule"; cron: string }
  | { kind: "manual" };

export type SessionResult = "ok" | "error" | "skipped" | "pass";

export interface SessionMetaEntry {
  title?: string;
  closed?: boolean;
  goal?: string;
  model?: string;
  effort?: EffortLevel;
  trigger?: SessionTrigger;
  /** Outcome of the last run on this session. Per-session rather than
   *  per-job so a later success doesn't repaint every historical row. */
  result?: SessionResult;
  /** Epoch ms when `result` was recorded. */
  resultAt?: number;
}
export interface SessionMetaStore { sessions: Record<string, SessionMetaEntry>; }

export function normalizeTitle(raw: string): string {
  return raw.trim().slice(0, 120);
}

export async function getSessionMeta(): Promise<SessionMetaStore> {
  try {
    const data: unknown = await Bun.file(META_FILE).json();
    return (data !== null && typeof data === "object" && "sessions" in data) ? data as SessionMetaStore : { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

async function save(store: SessionMetaStore): Promise<void> {
  await Bun.write(META_FILE, JSON.stringify(store, null, 2) + "\n");
}

/**
 * Read-modify-write a single session's meta entry under a serialized lock so
 * the full-store rewrite is atomic w.r.t. concurrent setters (two setters
 * racing would otherwise both read the store, mutate disjoint entries, and
 * the second write would clobber the first). `mutate` receives the entry
 * (defaulting to {}) and mutates it in place. The thin public setters below
 * wrap this so callers don't change.
 */
let _metaWriteChain: Promise<unknown> = Promise.resolve();
async function updateSessionMeta(
  id: string,
  mutate: (entry: SessionMetaEntry) => void,
): Promise<void> {
  const run = _metaWriteChain.then(async () => {
    const store = await getSessionMeta();
    const entry = store.sessions[id] ?? {};
    mutate(entry);
    store.sessions[id] = entry;
    await save(store);
  });
  _metaWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function setSessionTitle(id: string, title: string): Promise<void> {
  await updateSessionMeta(id, (entry) => {
    const t = normalizeTitle(title);
    if (t) entry.title = t; else delete entry.title;
  });
}

export async function setSessionGoal(id: string, goal: string): Promise<void> {
  await updateSessionMeta(id, (entry) => {
    const g = goal.trim();
    if (g) entry.goal = g; else delete entry.goal;
  });
}

export async function getSessionGoal(id: string): Promise<string> {
  const store = await getSessionMeta();
  return store.sessions[id]?.goal ?? "";
}

export async function getSessionModel(id: string): Promise<string> {
  const store = await getSessionMeta();
  return store.sessions[id]?.model ?? "";
}

export async function setSessionModel(id: string, model: string): Promise<void> {
  await updateSessionMeta(id, (entry) => {
    const m = model.trim();
    if (m) entry.model = m; else delete entry.model;
  });
}

const VALID_EFFORT_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

export function isValidEffort(s: string): s is EffortLevel {
  return VALID_EFFORT_LEVELS.has(s);
}

export async function getSessionEffort(id: string): Promise<string> {
  const store = await getSessionMeta();
  return store.sessions[id]?.effort ?? "";
}

export async function setSessionEffort(id: string, effort: string): Promise<void> {
  const e = effort.trim();
  // Validate before taking the write lock so an invalid value throws to the
  // caller without queuing a no-op critical section.
  if (e && !isValidEffort(e)) {
    throw new Error(`Invalid effort level: "${e}". Use: low, medium, high, xhigh, max`);
  }
  await updateSessionMeta(id, (entry) => {
    if (e) entry.effort = e as EffortLevel; else delete entry.effort;
  });
}

export async function setSessionClosed(id: string, closed: boolean): Promise<void> {
  await updateSessionMeta(id, (entry) => {
    entry.closed = closed;
  });
}

/** Record what kicked this session off. Idempotent — repeated calls
 *  during the resume-on-same-PR path overwrite with the same value. */
export async function setSessionTrigger(id: string, trigger: SessionTrigger): Promise<void> {
  await updateSessionMeta(id, (entry) => {
    entry.trigger = trigger;
  });
}

/** Record the outcome of the most recent run on this session. The Runs
 *  view's status column reads this in preference to the per-job
 *  `lastResult` so historical rows keep their own status. */
export async function setSessionResult(id: string, result: SessionResult): Promise<void> {
  await updateSessionMeta(id, (entry) => {
    entry.result = result;
    entry.resultAt = Date.now();
  });
}

/** Merge a meta store entry onto a session-info-like object. */
export function mergeMeta<T extends { id: string }>(
  session: T,
  store: SessionMetaStore,
): T & {
  title?: string;
  closed: boolean;
  trigger?: SessionTrigger;
  result?: SessionResult;
  resultAt?: number;
} {
  const entry = store.sessions[session.id] ?? {};
  return {
    ...session,
    title: entry.title,
    closed: entry.closed === true,
    ...(entry.trigger ? { trigger: entry.trigger } : {}),
    ...(entry.result ? { result: entry.result } : {}),
    ...(entry.resultAt ? { resultAt: entry.resultAt } : {}),
  };
}
