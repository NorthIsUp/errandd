import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { claudeProjectDir } from "../../shared/claudeProjectDir";

const SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INDEX_TTL_MS = 1000;
let index: { root: string; at: number; paths: Map<string, string> } | null = null;
let inFlight: { root: string; promise: Promise<Map<string, string>> } | null = null;

/** Share one directory scan across a session-list request's parallel readers. */
async function codexPaths(root: string): Promise<Map<string, string>> {
  if (index?.root === root && Date.now() - index.at < INDEX_TTL_MS) return index.paths;
  if (inFlight?.root === root) return inFlight.promise;
  const promise = (async () => {
    const paths = new Map<string, string>();
    if (existsSync(root)) {
      for await (const file of new Glob("**/*.jsonl").scan({ cwd: root, absolute: true })) {
        const id = SESSION_ID.exec(file.slice(0, -".jsonl".length))?.[0];
        if (id) paths.set(id.toLowerCase(), file);
      }
    }
    index = { root, at: Date.now(), paths };
    return paths;
  })();
  inFlight = { root, promise };
  try {
    return await promise;
  } finally {
    if (inFlight?.promise === promise) inFlight = null;
  }
}

/** Locate a transcript without copying files into another runtime's state. */
export async function resolveTranscriptFile(sessionId: string): Promise<string> {
  const claudePath = join(claudeProjectDir(), `${sessionId}.jsonl`);
  if (existsSync(claudePath)) return claudePath;
  // Session ids are UUIDs, never glob patterns supplied by an API caller.
  if (!SESSION_ID.test(sessionId) || sessionId.length !== 36) return claudePath;
  const root = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  return (await codexPaths(root)).get(sessionId.toLowerCase()) ?? claudePath;
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Adapt Codex rollout response items to the transcript parser's common blocks.
 * Event-message duplicates and internal developer/system instructions stay out
 * of the operator's conversation history. Claude entries pass through intact.
 */
export function normalizeTranscriptEntry(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.type !== "response_item") {
    return raw;
  }
  const item = rec(raw.payload);
  const base = { timestamp: raw.timestamp, uuid: item.id };
  if (item.type === "message" && (item.role === "user" || item.role === "assistant")) {
    const blocks = (Array.isArray(item.content) ? item.content : [])
      .map(rec)
      .filter((b) => ["input_text", "output_text", "text"].includes(String(b.type)))
      .map((b) => ({ type: "text", text: b.text }));
    return { ...base, type: item.role, message: { content: blocks } };
  }
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    let input: unknown = item.input ?? item.arguments ?? {};
    input = parseInput(input);
    return {
      ...base,
      type: "assistant",
      message: { content: [{ type: "tool_use", id: item.call_id, name: item.name, input }] },
    };
  }
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    return {
      ...base,
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: item.call_id, content: item.output }],
      },
    };
  }
  return {};
}

function parseInput(input: unknown): unknown {
  if (typeof input !== "string") {
    return input;
  }
  try {
    return JSON.parse(input);
  } catch {
    return { input };
  }
}
