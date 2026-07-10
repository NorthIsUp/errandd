import { dirname, join } from "path";
import { unlink, readdir, rename, mkdir } from "fs/promises";
import { getAgentsDir } from "./config";

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "errandd");
const SESSION_FILE = join(HEARTBEAT_DIR, "session.json");

export interface GlobalSession {
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
  turnCount: number;
  compactWarned: boolean;
  messageCount?: number;
}

// Module-level cache is for the GLOBAL session only.
// Agent sessions bypass this cache — they read/write directly.
let current: GlobalSession | null = null;

// Serialized writer for the GLOBAL session (P0-10).
//
// The global session is process-wide mutable state shared by every
// per-thread execClaude run AND the global stream run. Without
// serialization, two concurrent read-mutate-write sequences (e.g. two
// incrementTurn / incrementMessageCount calls, or an increment racing a
// getSession lastUsedAt bump) interleave their load → mutate → Bun.write,
// so one of the increments is silently lost and lastUsedAt gets clobbered.
//
// We funnel every global read-modify-write through a single promise-chain
// mutex: each critical section is appended to `globalWriteChain`, so they
// run strictly one-at-a-time. The chain never rejects (errors are swallowed
// for chaining purposes) — the caller still observes its own fn's result /
// throw.
let globalWriteChain: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` exclusively with respect to all other global-session mutations.
 * Critical sections execute in call order, one at a time.
 */
function withGlobalLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = globalWriteChain.then(fn, fn);
  // Keep the chain alive even if `fn` throws, but don't let the chain itself
  // become a rejected promise that triggers unhandled-rejection warnings.
  globalWriteChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function sessionPathFor(agentName?: string): string {
  if (agentName) return join(getAgentsDir(), agentName, "session.json");
  return SESSION_FILE;
}

async function loadSession(agentName?: string): Promise<GlobalSession | null> {
  if (agentName) {
    try {
      return (await Bun.file(sessionPathFor(agentName)).json()) as GlobalSession;
    } catch {
      return null;
    }
  }
  if (current) return current;
  try {
    current = (await Bun.file(SESSION_FILE).json()) as GlobalSession;
    return current;
  } catch {
    return null;
  }
}

async function saveSession(session: GlobalSession, agentName?: string): Promise<void> {
  if (!agentName) current = session;
  await Bun.write(sessionPathFor(agentName), JSON.stringify(session, null, 2) + "\n");
}

/** Returns the existing session or null. Never creates one. */
export async function getSession(
  agentName?: string
): Promise<{ sessionId: string; turnCount: number; compactWarned: boolean } | null> {
  const body = async () => {
    const existing = await loadSession(agentName);
    if (existing) {
      // Backfill missing fields from older session.json files
      if (typeof existing.turnCount !== "number") existing.turnCount = 0;
      if (typeof existing.compactWarned !== "boolean") existing.compactWarned = false;
      existing.lastUsedAt = new Date().toISOString();
      await saveSession(existing, agentName);
      return { sessionId: existing.sessionId, turnCount: existing.turnCount, compactWarned: existing.compactWarned };
    }
    return null;
  };
  return agentName ? body() : withGlobalLock(body);
}

/** Save a session ID obtained from Claude Code's output. */
export async function createSession(sessionId: string, agentName?: string): Promise<void> {
  const body = () =>
    saveSession({
      sessionId,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      turnCount: 0,
      compactWarned: false,
    }, agentName);
  return agentName ? body() : withGlobalLock(body);
}

/** Returns session metadata without mutating lastUsedAt. */
export async function peekSession(agentName?: string): Promise<GlobalSession | null> {
  return await loadSession(agentName);
}

/** Increment the turn counter after a successful Claude invocation. */
export async function incrementTurn(agentName?: string): Promise<number> {
  const body = async () => {
    const existing = await loadSession(agentName);
    if (!existing) return 0;
    if (typeof existing.turnCount !== "number") existing.turnCount = 0;
    existing.turnCount += 1;
    await saveSession(existing, agentName);
    return existing.turnCount;
  };
  return agentName ? body() : withGlobalLock(body);
}

/** Increment the message counter for rotation tracking. Call once per actual Claude invocation, not on reads. */
export async function incrementMessageCount(agentName?: string): Promise<void> {
  const body = async () => {
    const existing = await loadSession(agentName);
    if (!existing) return;
    existing.messageCount = (existing.messageCount ?? 0) + 1;
    await saveSession(existing, agentName);
  };
  return agentName ? body() : withGlobalLock(body);
}

/** Mark that the compact warning has been sent for the current session. */
export async function markCompactWarned(agentName?: string): Promise<void> {
  const body = async () => {
    const existing = await loadSession(agentName);
    if (!existing) return;
    existing.compactWarned = true;
    await saveSession(existing, agentName);
  };
  return agentName ? body() : withGlobalLock(body);
}

export async function resetSession(agentName?: string): Promise<void> {
  const body = async () => {
    if (!agentName) current = null;
    try {
      await unlink(sessionPathFor(agentName));
    } catch {
      // already gone
    }
  };
  return agentName ? body() : withGlobalLock(body);
}

// --- Fallback session management ---
// Fallback sessions are stored alongside primary sessions but keyed separately.
// They persist across rate-limit events so the fallback provider accumulates context.

const FALLBACK_SESSION_FILE = join(HEARTBEAT_DIR, "session_fallback.json");

function fallbackSessionPathFor(agentName?: string, threadId?: string): string {
  if (threadId) return join(HEARTBEAT_DIR, "fallback-sessions", `${encodeURIComponent(threadId)}.json`);
  if (agentName) return join(getAgentsDir(), agentName, "session_fallback.json");
  return FALLBACK_SESSION_FILE;
}

async function loadFallbackSession(agentName?: string, threadId?: string): Promise<GlobalSession | null> {
  try {
    return (await Bun.file(fallbackSessionPathFor(agentName, threadId)).json()) as GlobalSession;
  } catch {
    return null;
  }
}

async function saveFallbackSession(session: GlobalSession, agentName?: string, threadId?: string): Promise<void> {
  const path = fallbackSessionPathFor(agentName, threadId);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(session, null, 2) + "\n");
}

export async function getFallbackSession(
  agentName?: string,
  threadId?: string
): Promise<{ sessionId: string; turnCount: number } | null> {
  const existing = await loadFallbackSession(agentName, threadId);
  if (existing) {
    if (typeof existing.turnCount !== "number") existing.turnCount = 0;
    existing.lastUsedAt = new Date().toISOString();
    await saveFallbackSession(existing, agentName, threadId);
    return { sessionId: existing.sessionId, turnCount: existing.turnCount };
  }
  return null;
}

export async function createFallbackSession(sessionId: string, agentName?: string, threadId?: string): Promise<void> {
  await saveFallbackSession({
    sessionId,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    turnCount: 0,
    compactWarned: false,
  }, agentName, threadId);
}

export async function incrementFallbackTurn(agentName?: string, threadId?: string): Promise<number> {
  const existing = await loadFallbackSession(agentName, threadId);
  if (!existing) return 0;
  if (typeof existing.turnCount !== "number") existing.turnCount = 0;
  existing.turnCount += 1;
  await saveFallbackSession(existing, agentName, threadId);
  return existing.turnCount;
}

export async function resetFallbackSession(agentName?: string, threadId?: string): Promise<void> {
  try {
    await unlink(fallbackSessionPathFor(agentName, threadId));
  } catch {
    // already gone
  }
}

export async function backupSession(): Promise<string | null> {
  return withGlobalLock(async () => {
    const existing = await loadSession();
    if (!existing) return null;

    // Find next backup index
    let files: string[];
    try {
      files = await readdir(HEARTBEAT_DIR);
    } catch {
      files = [];
    }
    const indices = files
      .filter((f) => /^session_\d+\.backup$/.test(f))
      .map((f) => Number(/^session_(\d+)\.backup$/.exec(f)![1]));
    const nextIndex = indices.length > 0 ? Math.max(...indices) + 1 : 1;

    const backupName = `session_${nextIndex}.backup`;
    const backupPath = join(HEARTBEAT_DIR, backupName);
    try {
      await rename(SESSION_FILE, backupPath);
    } catch {
      // Session file already gone (e.g. concurrent reset) — nothing to back
      // up. Clear the in-memory cache anyway so the next run starts fresh.
      current = null;
      return null;
    }
    current = null;

    return backupName;
  });
}
