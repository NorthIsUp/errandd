import { join } from "path";

const META_FILE = join(process.cwd(), ".claude", "claudeclaw", "session-meta.json");

export interface SessionMetaEntry { title?: string; closed?: boolean; goal?: string; }
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

export async function setSessionClosed(id: string, closed: boolean): Promise<void> {
  const store = await getSessionMeta();
  const entry = store.sessions[id] ?? {};
  entry.closed = closed;
  store.sessions[id] = entry;
  await save(store);
}

/** Merge a meta store entry onto a session-info-like object. */
export function mergeMeta<T extends { id: string }>(
  session: T,
  store: SessionMetaStore,
): T & { title?: string; closed: boolean } {
  const entry = store.sessions[session.id] ?? {};
  return { ...session, title: entry.title, closed: entry.closed === true };
}
