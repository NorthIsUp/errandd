import { join } from "path";

const META_FILE = join(process.cwd(), ".claude", "clawdcode", "session-meta.json");

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

export type SessionResult = "ok" | "error" | "skipped";

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
    const data = await Bun.file(META_FILE).json();
    return data && typeof data === "object" && data.sessions ? data : { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

async function save(store: SessionMetaStore): Promise<void> {
  await Bun.write(META_FILE, JSON.stringify(store, null, 2) + "\n");
}

export async function setSessionTitle(id: string, title: string): Promise<void> {
  const store = await getSessionMeta();
  const entry = store.sessions[id] ?? {};
  const t = normalizeTitle(title);
  if (t) entry.title = t; else delete entry.title;
  store.sessions[id] = entry;
  await save(store);
}

export async function setSessionGoal(id: string, goal: string): Promise<void> {
  const store = await getSessionMeta();
  const entry = store.sessions[id] ?? {};
  const g = goal.trim();
  if (g) entry.goal = g; else delete entry.goal;
  store.sessions[id] = entry;
  await save(store);
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
  const store = await getSessionMeta();
  const entry = store.sessions[id] ?? {};
  const m = model.trim();
  if (m) entry.model = m; else delete entry.model;
  store.sessions[id] = entry;
  await save(store);
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
  const store = await getSessionMeta();
  const entry = store.sessions[id] ?? {};
  const e = effort.trim();
  if (e) {
    if (!isValidEffort(e)) throw new Error(`Invalid effort level: "${e}". Use: low, medium, high, xhigh, max`);
    entry.effort = e;
  } else {
    delete entry.effort;
  }
  store.sessions[id] = entry;
  await save(store);
}

export async function setSessionClosed(id: string, closed: boolean): Promise<void> {
  const store = await getSessionMeta();
  const entry = store.sessions[id] ?? {};
  entry.closed = closed;
  store.sessions[id] = entry;
  await save(store);
}

/** Record what kicked this session off. Idempotent — repeated calls
 *  during the resume-on-same-PR path overwrite with the same value. */
export async function setSessionTrigger(id: string, trigger: SessionTrigger): Promise<void> {
  const store = await getSessionMeta();
  const entry = store.sessions[id] ?? {};
  entry.trigger = trigger;
  store.sessions[id] = entry;
  await save(store);
}

/** Record the outcome of the most recent run on this session. The Runs
 *  view's status column reads this in preference to the per-job
 *  `lastResult` so historical rows keep their own status. */
export async function setSessionResult(id: string, result: SessionResult): Promise<void> {
  const store = await getSessionMeta();
  const entry = store.sessions[id] ?? {};
  entry.result = result;
  entry.resultAt = Date.now();
  store.sessions[id] = entry;
  await save(store);
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
