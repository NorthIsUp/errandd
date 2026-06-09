/**
 * Transcript → structured chat parts for the v3 chat pane (spec §6/§7).
 *
 * Resolves a `threadId` to its Claude `sessionId` (via the session manager),
 * reads the session's jsonl transcript, and parses the raw content blocks into
 * the shared `ChatPart[]` union (`web/v3/lib/transcriptParts.ts`). Also exposes
 * a byte-offset `tail()` so the SSE stream can re-parse only the lines appended
 * since the last read.
 *
 * The `ChatPart` shapes are re-declared here (not imported) because `src/` must
 * not depend on `web/` build sources; the two definitions are kept in sync by
 * contract — `web/v3/lib/transcriptParts.ts` is the single source of truth for
 * the frontend and this file mirrors it byte-for-byte at the type level.
 */
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeProjectDir } from "../../../shared/claudeProjectDir";
import type {
  ChatPart,
  SourceLink,
  ThreadMessagesResponse,
  ThreadStreamEvent,
  ToolPart,
} from "../../../shared/transcriptParts";
import { getThreadSession } from "../../sessionManager";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Part shapes are the SHARED source of truth (`shared/transcriptParts.ts`) — the
// parser below produces these, the frontend chat pane consumes them, no
// hand-mirrored copy. Re-exported so existing importers (e.g. server.ts) that
// pull `ChatPart` / `ThreadMessagesResponse` from here keep working.
export type { ChatPart, SourceLink, ThreadMessagesResponse, ThreadStreamEvent, ToolPart };

/** Resolve a v3 threadId → its jsonl transcript path, or null if unknown. */
export async function resolveThreadFile(
  threadId: string,
): Promise<{ sessionId: string; filePath: string } | null> {
  const session = await getThreadSession(threadId);
  if (!(session && UUID_RE.test(session.sessionId))) {
    return null;
  }
  const filePath = join(claudeProjectDir(), `${session.sessionId}.jsonl`);
  return { sessionId: session.sessionId, filePath };
}

// ---- raw jsonl line shapes (loose — transcripts evolve) --------------------

interface RawBlock {
  type?: string;
  text?: string;
  thinking?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface RawEntry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

/** Epoch ms of a transcript entry, or `{}` when the timestamp is missing. */
function atOf(entry: RawEntry): { at?: number } {
  const t = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isNaN(t) ? {} : { at: t };
}

/** A user turn that opens/wakes a thread from a hook delivery — rendered as a
 *  collapsible System trigger card rather than a raw text wall. Matches both
 *  the first-run lead ("Triggered by …") and the resume lead. */
const TRIGGER_RE = /^(Triggered by |New event on |\d+ new events on )/;

/**
 * The agent's (or a synthetic skip session's) terminal status line, e.g.
 * "[skip] PR #12: …" / "[ok] …" / "[skip:fyi] …" / "[skip:ignore] …". The
 * optional `:suffix` distinguishes prefilter/label drops from a plain skip. */
const STATUS_LINE_RE = /^\s*\[(skip|ok|pass|done)(?::([a-z]+))?\]/i;

/**
 * FYI status markers — a `[skip:fyi]` (prefilter / bot-noise drop) or
 * `[skip:ignore]` (`claw:ignore` label) line was never sent to the agent, so
 * its part is flagged `notInContext` and rendered in the blue FYI box. A plain
 * `[skip]` / `[ok]` stays an in-context system notice. */
const FYI_STATUS_SUFFIXES = new Set(["fyi", "ignore"]);

/** Pending tool_use awaiting its tool_result, keyed by tool_use id. */
type PendingTool = { partIndex: number; tool: ToolPart };

/**
 * Strip ClawdCode-injected prefix blocks from a user turn so the pane shows
 * the operator's actual text. Mirrors the cleanup in services/sessions.ts.
 */
function cleanUserText(raw: string): string {
  return raw
    .replace(/^\[[\d-]+ [\d:]+ UTC[^\]]*\]\n/m, "")
    .replace(/^\[(?:WhatsApp|Slack|Discord)[^\]]*\]\n/m, "")
    .replace(/^## Slack Directives[\s\S]*?(?=\n[A-Z[]|\n$)/m, "")
    .trim();
}

/** Flatten a tool_result `content` (string | block[]) to plain text. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Incremental parser state. `parse()` feeds lines through this so the same
 * code serves both the full snapshot and the streaming tail (open tool_use
 * blocks from an earlier batch still pair with results in a later batch).
 */
export class TranscriptParser {
  readonly parts: ChatPart[] = [];
  private pendingTools = new Map<string, PendingTool>();
  private lineIndex = 0;

  /** Feed raw jsonl text; appends new parts to `this.parts`. Returns the
   *  parts produced/updated by this batch (snapshot uses `this.parts`). */
  feed(text: string): void {
    for (const line of text.split("\n")) {
      this.feedLine(line);
    }
  }

  private feedLine(line: string): void {
    const idx = this.lineIndex++;
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let entry: RawEntry;
    try {
      entry = JSON.parse(trimmed) as RawEntry;
    } catch {
      return;
    }
    if (entry.type === "user") {
      this.handleUser(entry, idx);
    } else if (entry.type === "assistant") {
      this.handleAssistant(entry, idx);
    }
  }

  private handleUser(entry: RawEntry, idx: number): void {
    const content = entry.message?.content;
    if (typeof content === "string") {
      this.pushUserText(cleanUserText(content), `${idx}:0`, entry);
      return;
    }
    if (!Array.isArray(content)) {
      return;
    }
    // First, resolve any tool_result blocks against open tool_use parts.
    for (const b of content as RawBlock[]) {
      if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
        this.resolveToolResult(b);
      }
    }
    // Then surface any user-authored text (skip turns that are only results).
    const text = cleanUserText(
      (content as RawBlock[])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n"),
    );
    this.pushUserText(text, `${idx}:t`, entry);
  }

  /** A hook-trigger turn becomes a collapsible System card; anything else the
   *  operator typed stays a normal user text turn. */
  private pushUserText(text: string, id: string, entry: RawEntry): void {
    if (!text) {
      return;
    }
    if (TRIGGER_RE.test(text)) {
      this.parts.push({ kind: "system", id, text, ...atOf(entry) });
    } else {
      this.parts.push({ kind: "text", id, role: "user", markdown: text, ...atOf(entry) });
    }
  }

  private resolveToolResult(b: RawBlock): void {
    const pending = this.pendingTools.get(b.tool_use_id as string);
    if (!pending) {
      return;
    }
    const out = toolResultText(b.content);
    pending.tool.output = out ? { text: out } : undefined;
    pending.tool.state = b.is_error ? "output-error" : "output-available";
    if (b.is_error && out) {
      pending.tool.errorText = out;
    }
    // Re-emit the updated part in place (it's the same object reference).
    const existing = this.parts[pending.partIndex];
    if (existing && existing.kind === "tool") {
      existing.tool = pending.tool;
    }
    this.pendingTools.delete(b.tool_use_id as string);
  }

  private handleAssistant(entry: RawEntry, idx: number): void {
    const content = entry.message?.content;
    if (!Array.isArray(content)) {
      return;
    }
    const at = atOf(entry);
    let block = 0;
    for (const b of content as RawBlock[]) {
      const id = `${idx}:${block++}`;
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
        // The agent's terminal status line ("[skip]/[ok] …") reads as a system
        // notice, not a chat message. A `[skip:fyi]` / `[skip:ignore]` variant
        // was never sent to the agent → flag it `notInContext` so the chat pane
        // routes it to the blue FYI box.
        const statusMatch = STATUS_LINE_RE.exec(b.text);
        if (statusMatch) {
          const suffix = statusMatch[2]?.toLowerCase();
          const fyi = suffix != null && FYI_STATUS_SUFFIXES.has(suffix);
          this.parts.push({
            kind: "system",
            id,
            text: b.text.trim(),
            ...at,
            ...(fyi ? { notInContext: true } : {}),
          });
        } else {
          this.parts.push({ kind: "text", id, role: "assistant", markdown: b.text, ...at });
        }
      } else if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
        this.parts.push({ kind: "reasoning", id, markdown: b.thinking, ...at });
      } else if (b?.type === "tool_use" && typeof b.id === "string") {
        const tool: ToolPart = {
          type: typeof b.name === "string" ? b.name : "tool",
          state: "input-available",
          input: (b.input ?? {}) as Record<string, unknown>,
          toolCallId: b.id,
        };
        const part: ChatPart = { kind: "tool", id, tool, ...at };
        this.pendingTools.set(b.id, { partIndex: this.parts.length, tool });
        this.parts.push(part);
      }
    }
  }
}

/** Parse a full jsonl transcript into ChatPart[]. */
export function parseTranscript(text: string): ChatPart[] {
  const parser = new TranscriptParser();
  parser.feed(text);
  return parser.parts;
}

/**
 * Seed a fresh `TranscriptParser` from a thread's current transcript and
 * return it alongside the byte offset to continue tailing from. Used by the
 * SSE stream so the snapshot and the live tail share one parser (open
 * tool_use blocks pair correctly across the boundary).
 */
export async function seedParser(
  threadId: string,
): Promise<{ parser: TranscriptParser; byteOffset: number }> {
  const parser = new TranscriptParser();
  const resolved = await resolveThreadFile(threadId);
  if (!(resolved && existsSync(resolved.filePath))) {
    return { parser, byteOffset: 0 };
  }
  const content = await readFile(resolved.filePath, "utf-8");
  parser.feed(content);
  return { parser, byteOffset: Buffer.byteLength(content, "utf-8") };
}

/**
 * Read a thread's full transcript as ChatPart[], paginated. `offset === -1`
 * returns the last `limit` parts (tail). Returns `{ parts, total }` plus the
 * current byte size so a caller can start a tail from here.
 */
export async function getThreadParts(
  threadId: string,
  limit = 200,
  offset = 0,
): Promise<ThreadMessagesResponse & { byteOffset: number }> {
  const resolved = await resolveThreadFile(threadId);
  if (!(resolved && existsSync(resolved.filePath))) {
    return { threadId, parts: [], total: 0, byteOffset: 0 };
  }
  const content = await readFile(resolved.filePath, "utf-8");
  const byteOffset = Buffer.byteLength(content, "utf-8");
  const all = parseTranscript(content);
  const total = all.length;
  const parts =
    offset === -1 ? all.slice(Math.max(0, total - limit)) : all.slice(offset, offset + limit);
  return { threadId, parts, total, byteOffset };
}

/**
 * Tail helper for SSE (spec §7): re-read the transcript from `byteOffset` and
 * return the parts produced by the newly-appended lines. `parser` carries the
 * cross-batch state (open tool_use blocks) so a `tool_result` that lands in a
 * later batch still pairs with its earlier `tool_use`.
 *
 * NOTE: because new tool_results mutate already-emitted tool parts in place,
 * the caller should treat any returned `tool` part whose `toolCallId` it has
 * already seen as an `update`, and everything else as `append`.
 */
export async function tail(
  threadId: string,
  byteOffset: number,
  parser: TranscriptParser,
): Promise<{ parts: ChatPart[]; byteOffset: number }> {
  const resolved = await resolveThreadFile(threadId);
  if (!(resolved && existsSync(resolved.filePath))) {
    return { parts: [], byteOffset };
  }
  const st = await stat(resolved.filePath);
  if (st.size <= byteOffset) {
    return { parts: [], byteOffset };
  }
  // Read the appended bytes, but only CONSUME up to the last newline. The claude
  // CLI appends jsonl incrementally, so a poll can fire mid-write: the trailing
  // partial line would fail JSON.parse and be dropped, and advancing byteOffset
  // past it would lose that transcript entry forever (a missing message, or a
  // tool_result that never pairs → a spinner stuck forever). Leave the partial
  // line unconsumed; the next tail re-reads it once it's complete.
  const fh = await readFile(resolved.filePath);
  const slice = fh.subarray(byteOffset).toString("utf-8");
  const lastNl = slice.lastIndexOf("\n");
  if (lastNl < 0) {
    // No complete line appended yet — wait for the rest.
    return { parts: [], byteOffset };
  }
  const consumed = slice.slice(0, lastNl + 1);
  const before = parser.parts.length;
  parser.feed(consumed);
  const newParts = parser.parts.slice(before);
  return { parts: newParts, byteOffset: byteOffset + Buffer.byteLength(consumed, "utf-8") };
}
