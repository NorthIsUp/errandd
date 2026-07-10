/**
 * Cleanup: heal threads whose chat history was overwritten by a skip
 * placeholder (the bug fixed in PR #141, where a skip event after real activity
 * called createThreadSession and clobbered the mapping).
 *
 * Recovery is reliable because the session store is APPEND-ONLY: the earlier
 * real-session line is still in `sessions.jsonl`, just superseded by the skip
 * line. So we don't guess from transcript content (which would be ambiguous —
 * `pr-comments` and `pr-review` share a PR scope). We find threads whose CURRENT
 * mapping is a skip placeholder (turnCount 0 + a `[skip…]`-only transcript) that
 * superseded a real session, and re-map them back. Idempotent: once re-mapped,
 * the thread's latest record is the real session, so it's no longer a candidate.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeProjectDir } from "../../shared/claudeProjectDir";
import {
  type LogEntry,
  type ThreadSession,
  readSessionLog,
  remapThreadSession,
} from "../sessionManager";

/** A thread whose current mapping (a turnCount-0 placeholder) superseded an
 *  earlier real session — the candidate to heal back to `real`. */
export interface ClobberCandidate {
  threadId: string;
  placeholderSessionId: string;
  real: ThreadSession;
}

/**
 * Pure: from the full append-only log, find threads whose CURRENT record is a
 * turnCount-0 placeholder that superseded an earlier DIFFERENT session with real
 * turns. (Whether the placeholder is truly a skip is confirmed separately by
 * reading its transcript — kept out of here so this stays pure/testable.)
 */
export function findClobberCandidates(log: LogEntry[]): ClobberCandidate[] {
  const records = new Map<string, ThreadSession[]>();
  const deleted = new Set<string>();
  for (const entry of log) {
    if ("deleted" in entry) {
      deleted.add(entry.threadId);
    } else {
      deleted.delete(entry.threadId);
      const arr = records.get(entry.threadId) ?? [];
      arr.push(entry.session);
      records.set(entry.threadId, arr);
    }
  }

  const out: ClobberCandidate[] = [];
  for (const [threadId, recs] of records) {
    if (deleted.has(threadId)) continue;
    const current = recs[recs.length - 1];
    if (!current || current.turnCount > 0) continue;
    for (let i = recs.length - 2; i >= 0; i--) {
      const r = recs[i];
      if (r && r.sessionId !== current.sessionId && r.turnCount > 0) {
        out.push({ threadId, placeholderSessionId: current.sessionId, real: r });
        break;
      }
    }
  }
  return out;
}

const SKIP_MARKER_RE = /^\s*\[skip/i;

/** True when the session's transcript is a skip placeholder (its assistant text
 *  is a `[skip…]` notice) rather than a real conversation. Guards against
 *  re-mapping a legitimately fresh session that just hasn't taken a turn yet. */
async function isSkipPlaceholder(sessionId: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(claudeProjectDir(), `${sessionId}.jsonl`), "utf-8");
  } catch {
    return false; // no transcript → can't confirm; don't touch it
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(trimmed) as typeof entry;
    } catch {
      continue;
    }
    if (entry?.type !== "assistant") continue;
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
    for (const b of blocks as { type?: string; text?: string }[]) {
      if (b?.type === "text" && typeof b.text === "string" && SKIP_MARKER_RE.test(b.text)) {
        return true;
      }
    }
  }
  return false;
}

export async function recoverClobberedThreads(): Promise<string> {
  const candidates = findClobberCandidates(await readSessionLog());
  const recovered: string[] = [];
  for (const { threadId, placeholderSessionId, real } of candidates) {
    // Confirm the current mapping really is a skip placeholder (not a fresh
    // session that just hasn't taken a turn) before re-pointing the thread.
    if (!(await isSkipPlaceholder(placeholderSessionId))) continue;
    await remapThreadSession(threadId, real.sessionId, {
      turnCount: real.turnCount,
      createdAt: real.createdAt,
      lastUsedAt: real.lastUsedAt,
    });
    recovered.push(`${threadId} → ${real.sessionId} (${real.turnCount} turns)`);
  }

  if (recovered.length === 0) return "";
  const head = recovered.slice(0, 5).join("; ");
  return `recovered ${recovered.length} clobbered thread(s): ${head}${recovered.length > 5 ? " …" : ""}`;
}
