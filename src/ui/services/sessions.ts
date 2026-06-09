import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { claudeProjectDir } from "../../../shared/claudeProjectDir";
import { getAgentsDir } from "../../config";
import {
  getSessionMeta,
  mergeMeta,
  type SessionResult,
  type SessionTrigger,
} from "./session-meta";

export interface SessionInfo {
  id: string;
  /** The thread this session belongs to (`<job>:hook:<scope>`, a run id, etc.).
   *  `id` is the Claude session UUID; consumers that key off the v3 threadId
   *  (e.g. the sidebar joining turnCount onto a chat leaf) need this. Only set
   *  for thread-map sessions; UUID-keyed sessions have `id === threadId`. */
  threadId?: string;
  agent: string;
  channel: "web" | "discord" | "agent" | "job" | "unknown";
  lastUsedAt: string;
  createdAt: string;
  turnCount: number;
  firstMessage: string;
  lastMessage: string;
  title?: string;
  closed: boolean;
  /** Set when this session is a standalone job's thread — the job file is `<jobName>.md`. */
  jobName?: string;
  /** What kicked off this session (hook delivery, schedule, manual). */
  trigger?: SessionTrigger;
  /** Per-session outcome of the most recent run. */
  result?: SessionResult;
  /** Epoch ms when `result` was recorded. */
  resultAt?: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  uuid?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISCORD_SNOWFLAKE_RE = /^\d{17,19}$/;

function extractUserText(line: string): string {
  if (!line.trim()) return "";
  try {
    const entry = JSON.parse(line);
    if (entry.type !== "user") return "";
    const msg = entry.message;
    let raw = "";
    if (typeof msg?.content === "string") {
      raw = msg.content;
    } else if (Array.isArray(msg?.content)) {
      raw = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text as string)
        .join("\n");
    }
    // Strip ClawdCode-injected prefix blocks, keep the user's actual text in full.
    raw = raw
      .replace(/^\[[\d-]+ [\d:]+ UTC[^\]]*\]\n/m, "")
      .replace(/^\[(?:WhatsApp|Slack|Discord)[^\]]*\]\n/m, "")
      .replace(/^## Slack Directives[\s\S]*?(?=\n[A-Z\[]|\n$)/m, "")
      .trim();
    return raw;
  } catch {
    return "";
  }
}

// Single file read to get both the first and last user message (for sidebar preview).
async function peekMessages(sessionId: string): Promise<{ first: string; last: string; firstFull: string }> {
  if (!UUID_RE.test(sessionId)) return { first: "", last: "", firstFull: "" };
  const filePath = join(claudeProjectDir(), `${sessionId}.jsonl`);
  if (!existsSync(filePath)) return { first: "", last: "", firstFull: "" };
  let first = "";
  let last = "";
  let firstFull = "";
  try {
    const content = await readFile(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const text = extractUserText(line);
      if (text) {
        if (!first) {
          first = text.substring(0, 100);
          // Hold onto ~2 KB so we can recover the hook trigger header for
          // legacy sessions that pre-date per-session trigger
          // persistence — the delivery UUID alone is 36 chars and pushes
          // the scope past the 100-char preview cap.
          firstFull = text.substring(0, 2048);
        }
        last = text.substring(0, 100);
      }
    }
  } catch {}
  return { first, last, firstFull };
}

/** Recover a hook trigger from a session's first user message. Used for
 *  legacy sessions that pre-date per-session trigger persistence.
 *  Returns null when the message doesn't look like a hook fire. */
function recoverTriggerFromFirstMessage(firstFull: string): SessionTrigger | null {
  const head = firstFull.match(/^Triggered by GitHub (\S+).*?for scope `([^`]+)`/);
  if (!head) return null;
  const event = head[1] ?? "";
  const scope = head[2] ?? "";
  const prMatch = scope.match(/^pr-(\d+)/);
  const pr = prMatch?.[1] ? { number: Number.parseInt(prMatch[1], 10) } : undefined;
  const repo = firstFull.match(/\*\*repo\*\*:\s*([^\s\n]+)/)?.[1];
  const sender = firstFull.match(/\*\*sender\*\*:\s*([^\s\n]+)/)?.[1];
  const actionMatch = firstFull.match(/\*\*event\*\*:\s*\S+\s*\(([^)]+)\)/);
  return {
    kind: "hook",
    event,
    ...(actionMatch?.[1] ? { action: actionMatch[1] } : {}),
    ...(repo ? { repo } : {}),
    ...(pr ? { pr } : {}),
    ...(sender ? { actor: sender } : {}),
  };
}

export async function listSessions(includeClosed = false): Promise<SessionInfo[]> {
  const cwd = process.cwd();
  const sessionFile = join(cwd, ".claude", "clawdcode", "session.json");

  const sessions: SessionInfo[] = [];
  const knownIds = new Set<string>();
  // Side-channel for the longer first-message snippet so we can recover a
  // trigger for sessions that pre-date per-session trigger persistence.
  const firstFullById = new Map<string, string>();

  // Global web session
  try {
    if (existsSync(sessionFile)) {
      const data = JSON.parse(await readFile(sessionFile, "utf-8"));
      if (UUID_RE.test(data.sessionId)) {
        const { first, last, firstFull } = await peekMessages(data.sessionId);
        firstFullById.set(data.sessionId, firstFull);
        sessions.push({
          id: data.sessionId,
          agent: "global",
          channel: "web",
          lastUsedAt: data.lastUsedAt || data.createdAt,
          createdAt: data.createdAt,
          turnCount: data.turnCount ?? 0,
          firstMessage: first,
          lastMessage: last,
          closed: false,
        });
        knownIds.add(data.sessionId);
      }
    }
  } catch {}

  // Per-agent sessions — agents/<name>/session.json
  try {
    const agentsDir = getAgentsDir();
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const agentSessionFile = join(agentsDir, entry.name, "session.json");
      if (!existsSync(agentSessionFile)) continue;
      try {
        const data = JSON.parse(await readFile(agentSessionFile, "utf-8"));
        if (!UUID_RE.test(data.sessionId) || knownIds.has(data.sessionId)) continue;
        const { first, last, firstFull } = await peekMessages(data.sessionId);
        firstFullById.set(data.sessionId, firstFull);
        sessions.push({
          id: data.sessionId,
          agent: entry.name,
          channel: "agent",
          lastUsedAt: data.lastUsedAt || data.createdAt,
          createdAt: data.createdAt,
          turnCount: data.turnCount ?? 0,
          firstMessage: first,
          lastMessage: last,
          closed: false,
        });
        knownIds.add(data.sessionId);
      } catch {}
    }
  } catch {}

  // Thread sessions. A thread ID is either a Discord snowflake, an
  // "agent:<name>" agent-job thread, or a plain job name (standalone job —
  // runJob passes threadId = job.name). Job threads were previously dropped.
  try {
    const { listThreadSessions } = await import("../../sessionManager");
    for (const t of await listThreadSessions()) {
      const threadId = t.threadId;
      if (!UUID_RE.test(t.sessionId) || knownIds.has(t.sessionId)) continue;
      {
        const isSnowflake = DISCORD_SNOWFLAKE_RE.test(threadId);
        const isAgentJob = threadId.startsWith("agent:");
        const { first, last, firstFull } = await peekMessages(t.sessionId);
        firstFullById.set(t.sessionId, firstFull);
        sessions.push({
          id: t.sessionId,
          threadId,
          agent: isAgentJob ? threadId.slice("agent:".length) : "global",
          channel: isSnowflake ? "discord" : "job",
          lastUsedAt: t.lastUsedAt || t.createdAt,
          createdAt: t.createdAt,
          turnCount: t.turnCount ?? 0,
          firstMessage: first,
          lastMessage: last,
          closed: false,
          // A standalone job's thread ID is its job name or <name>:<runId> (per-run).
          // Strip the :<runId> suffix so all runs of a job group under the same name,
          // and <name>.md keeps working as the file link.
          // Agent jobs share one thread across multiple files, so they get no single-file link.
          ...(isSnowflake || isAgentJob ? {} : { jobName: threadId.split(":")[0] }),
        });
        knownIds.add(t.sessionId);
      }
    }
  } catch {}

  // Orphan JSONL sessions not tracked by any session file (up to 20 most recent)
  try {
    const projectDir = claudeProjectDir();
    const files = (await readdir(projectDir)).filter(f => f.endsWith(".jsonl"));
    const candidates = files
      .map(f => basename(f, ".jsonl"))
      .filter(id => UUID_RE.test(id) && !knownIds.has(id))
      .slice(-20);
    for (const id of candidates) {
      try {
        const fileStat = await stat(join(projectDir, `${id}.jsonl`));
        const { first, last, firstFull } = await peekMessages(id);
        firstFullById.set(id, firstFull);
        sessions.push({
          id,
          agent: "unknown",
          channel: "unknown",
          lastUsedAt: fileStat.mtime.toISOString(),
          createdAt: fileStat.birthtime.toISOString(),
          turnCount: 0,
          firstMessage: first,
          lastMessage: last,
          closed: false,
        });
      } catch {}
    }
  } catch {}

  const meta = await getSessionMeta();
  const merged = sessions.map((s) => {
    const withMeta = mergeMeta(s, meta);
    // Legacy sessions don't have a persisted trigger — recover one from
    // the first message's "Triggered by GitHub …" header so the Runs
    // view shows "comment on PR #N" instead of falling through to the
    // job's schedule cron.
    if (!withMeta.trigger) {
      const fallback = recoverTriggerFromFirstMessage(firstFullById.get(s.id) ?? "");
      if (fallback) {
        return { ...withMeta, trigger: fallback };
      }
    }
    return withMeta;
  });
  merged.sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime());
  return includeClosed ? merged : merged.filter((s) => !s.closed);
}

export interface MessagesResult {
  messages: ChatMessage[];
  total: number;
}

export async function readSessionMessages(
  sessionId: string,
  limit = 10,
  offset = 0,
): Promise<MessagesResult> {
  // Validate UUID shape before constructing file path (prevent path traversal).
  if (!UUID_RE.test(sessionId)) return { messages: [], total: 0 };

  const filePath = join(claudeProjectDir(), `${sessionId}.jsonl`);
  if (!existsSync(filePath)) return { messages: [], total: 0 };

  const content = await readFile(filePath, "utf-8");
  const all: ChatMessage[] = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "user") {
        const text = extractUserText(line);
        if (text) {
          all.push({ role: "user", text, timestamp: entry.timestamp ?? "", uuid: entry.uuid });
        }
      } else if (entry.type === "assistant") {
        const parts = (entry.message?.content ?? [])
          .filter((c: any) => c.type === "text" && c.text)
          .map((c: any) => c.text as string);
        if (parts.length > 0) {
          all.push({
            role: "assistant",
            text: parts.join("\n"),
            timestamp: entry.timestamp ?? "",
            uuid: entry.uuid,
          });
        }
      }
    } catch {}
  }

  const total = all.length;
  const messages = offset === -1 ? all.slice(-limit) : all.slice(offset, offset + limit);
  return { messages, total };
}

export async function listAgents(): Promise<Array<{ id: string; name: string }>> {
  const agentsDir = getAgentsDir();
  const agents: Array<{ id: string; name: string }> = [{ id: "mike", name: "mike" }];
  const seen = new Set<string>(["mike"]);

  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      seen.add(entry.name);
      agents.push({ id: entry.name, name: entry.name });
    }
  } catch {}

  return agents;
}
