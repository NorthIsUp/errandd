import { splitCveSystemContext } from "../../../shared/cveSystemContext";
import type { Job } from "../../jobs";
import { getHookQueue } from "../../hookQueue";
import { queuedHookParts } from "./queuedHookParts";
/**
 * Transcript → structured chat parts for the v3 chat pane (spec §6/§7).
 *
 * Resolves a `threadId` to its Claude `sessionId` (via the session manager),
 * reads the session's jsonl transcript, and parses the raw content blocks into
 * the shared `ChatPart[]` union (`web/v3/lib/transcriptParts.ts`). Also exposes
 * a byte-offset `tail()` so the SSE stream can re-parse only the lines appended
 * since the last read.
 *
 * Both frontend and backend consume shared ChatPart definitions. IDs stay
 * stable across polling and reconnection.
 */
import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { clearThread, saveThread, storedParts, threadCursor } from "./threadStore";
import { normalizeTranscriptEntry, resolveTranscriptFile } from "../../runtime/transcripts";
import type {
  ChatPart,
  SourceLink,
  ThreadMessagesResponse,
  ThreadStreamEvent,
  ToolPart,
} from "../../../shared/transcriptParts";
import { peekThreadSession } from "../../sessionManager";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Part shapes are the SHARED source of truth (`shared/transcriptParts.ts`) — the
// parser below produces these, the frontend chat pane consumes them, no
// hand-mirrored copy. Re-exported so existing importers (e.g. server.ts) that
// pull `ChatPart` / `ThreadMessagesResponse` from here keep working.
export type { ChatPart, SourceLink, ThreadMessagesResponse, ThreadStreamEvent, ToolPart };

/** Resolve a v3 threadId → its jsonl transcript path, or null if unknown.
 *
 *  Hook threads are `<job>:hook:<scope>` and map to a sessionId via the session
 *  manager. Scheduled-run threads, by contrast, ARE the session UUID directly
 *  (the Schedules sidebar uses `session.id` as the threadId), so a bare UUID is
 *  the sessionId — read its transcript without a mapping lookup. */
export async function resolveThreadFile(
  threadId: string,
): Promise<{ sessionId: string; filePath: string } | null> {
  if (UUID_RE.test(threadId)) {
    return { sessionId: threadId, filePath: await resolveTranscriptFile(threadId) };
  }
  const session = await peekThreadSession(threadId);
  if (!(session && UUID_RE.test(session.sessionId))) {
    return null;
  }
  const filePath = await resolveTranscriptFile(session.sessionId);
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
 * FYI status markers — a config-driven skip line was never sent to the agent,
 * so its part is flagged `notInContext` and rendered in the blue FYI box:
 *   - `[skip:fyi]`    → prefilter / bot-noise drop
 *   - `[skip:ignore]` → `claw:ignore` label
 *   - `[skip:rule]`   → matcher rule (user/branch/self filter) didn't match
 * A plain `[skip]` / `[ok]` is the AGENT'S OWN output and stays in-context. */
const FYI_STATUS_SUFFIXES = new Set(["fyi", "ignore", "rule"]);

/** A plain `[skip]` whose reason reads like a config-filter rejection (older
 *  transcripts didn't tag filter skips as `[skip:rule]`) — these are SYSTEM
 *  skips that never reached the model. Mirrors the matcher's skip-reason wording. */
const FILTER_REASON_RE =
  /not in the .*filter|no (?:pr|sentry|datadog) rule matched|does(?:n't| not) match|excluded by|skip[_ ]?self|draft|claw:ignore|label/i;

/** A model usage-cap notice ("You've hit your Sonnet limit · resets …") emitted
 *  as a run's only output. Anchored at the start so it matches the standalone
 *  notice, not a review that mentions "limit" in prose → render it as a system
 *  block, not an assistant chat message. */
const LIMIT_NOTICE_RE = /^\s*you(?:'|')ve hit your\s.{0,30}\blimit\b/i;

/** Pending tool_use awaiting its tool_result, keyed by tool_use id. */
interface PendingTool {
  partIndex: number;
  tool: ToolPart;
}

/**
 * Strip Errandd-injected prefix blocks from a user turn so the pane shows
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
      .map((b: unknown) => {
        if (typeof b === "string") return b;
        if (b !== null && typeof b === "object" && "text" in b) {
          const t = (b as Record<string, unknown>).text;
          if (typeof t === "string") return t;
        }
        return "";
      })
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
  get nextLineIndex(): number { return this.lineIndex; }
  restore(parts: ChatPart[], lineIndex: number): void {
    this.reset();
    this.parts.push(...parts);
    this.lineIndex = lineIndex;
    for (const [partIndex, part] of parts.entries()) {
      if (part.kind === "tool" && part.tool.state === "input-available" && part.tool.toolCallId) {
        this.pendingTools.set(part.tool.toolCallId, { partIndex, tool: part.tool });
      }
    }
  }
  private fileIdentity: string | null = null;
  private changedParts = new Set<ChatPart>();

  /** A session rotation must replace, rather than append to, the old snapshot. */
  bindFile(path: string, inode: number): boolean {
    const identity = `${path}:${inode}`;
    const changed = this.fileIdentity !== null && this.fileIdentity !== identity;
    if (changed) this.reset();
    this.fileIdentity = identity;
    return changed;
  }

  reset(): void {
    this.parts.length = 0;
    this.pendingTools.clear();
    this.changedParts.clear();
    this.lineIndex = 0;
  }

  private append(part: ChatPart): void {
    this.parts.push(part);
    this.changedParts.add(part);
  }

  /** Feed raw jsonl text; appends new parts to `this.parts`. Returns the
   *  parts produced/updated by this batch (snapshot uses `this.parts`). */
  feed(text: string): ChatPart[] {
    this.changedParts.clear();
    const lines = text.split("\n");
    // A terminating newline is a delimiter, not another transcript record.
    // Counting it per poll changes IDs compared with a fresh snapshot.
    if (lines.at(-1) === "") lines.pop();
    for (const line of lines) this.feedLine(line);
    return [...this.changedParts];
  }

  private feedLine(line: string): void {
    const idx = this.lineIndex++;
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let entry: RawEntry;
    try {
      entry = normalizeTranscriptEntry(JSON.parse(trimmed) as Record<string, unknown>);
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
        .map((b) => b.text!)
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
    const split = splitCveSystemContext(text);
    if (split) {
      this.pushUserText(split.message, id, entry);
      this.append({ kind: "system", contextType: "repository-analysis", id: `${id}:repository`, text: split.context, ...atOf(entry) });
      return;
    }
    if (TRIGGER_RE.test(text)) {
      this.append({ kind: "system", id, text, ...atOf(entry) });
    } else {
      this.append({ kind: "text", id, role: "user", markdown: text, ...atOf(entry) });
    }
  }

  private resolveToolResult(b: RawBlock): void {
    const pending = this.pendingTools.get(b.tool_use_id!);
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
    if (existing?.kind === "tool") {
      existing.tool = pending.tool;
      this.changedParts.add(existing);
    }
    this.pendingTools.delete(b.tool_use_id!);
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
          const verb = statusMatch[1]?.toLowerCase();
          const suffix = statusMatch[2]?.toLowerCase();
          // FYI (never reached the model) when it's a tagged filter/ignore skip,
          // OR a plain `[skip]` whose reason reads like a config-filter rejection
          // (older transcripts didn't tag those) — both are SYSTEM skips, not the
          // agent's own decision.
          const fyi =
            (suffix != null && FYI_STATUS_SUFFIXES.has(suffix)) ||
            (verb === "skip" && suffix == null && FILTER_REASON_RE.test(b.text));
          this.append({
            kind: "system",
            id,
            text: b.text.trim(),
            ...at,
            ...(fyi ? { notInContext: true } : {}),
          });
        } else if (LIMIT_NOTICE_RE.test(b.text)) {
          // A run that hit a model usage cap emits the limit message ("You've hit
          // your Sonnet limit · resets …") as its only output. That's a system
          // condition, not the agent's reply — render it as a muted system
          // notice, not a chat bubble. Anchored at the start so a review that
          // merely mentions "limit" in prose is unaffected.
          this.append({ kind: "system", id, text: b.text.trim(), ...at });
        } else {
          this.append({ kind: "text", id, role: "assistant", markdown: b.text, ...at });
        }
      } else if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
        this.append({ kind: "reasoning", id, markdown: b.thinking, ...at });
      } else if (b?.type === "tool_use" && typeof b.id === "string") {
        const tool: ToolPart = {
          type: typeof b.name === "string" ? b.name : "tool",
          state: "input-available",
          input: (b.input ?? {}) as Record<string, unknown>,
          toolCallId: b.id,
        };
        const part: ChatPart = { kind: "tool", id, tool, ...at };
        this.pendingTools.set(b.id, { partIndex: this.parts.length, tool });
        this.append(part);
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
    clearThread(resolved?.sessionId ?? threadId);
    return { parser, byteOffset: 0 };
  }
  const info = await stat(resolved.filePath);
  const saved = threadCursor(resolved.sessionId);
  let offset = 0;
  if (saved?.schemaVersion === 1 && saved.path === resolved.filePath && saved.inode === info.ino &&
      info.size >= saved.size && (info.size !== saved.size || info.mtimeMs === saved.mtime)) {
    parser.restore(storedParts(resolved.sessionId).parts, saved.lineIndex);
    offset = saved.byteOffset;
  }
  parser.bindFile(resolved.filePath, info.ino);
  // tail updates the durable read model with only appended/changed parts.
  const result = await tail(threadId, offset, parser, offset === 0);
  return { parser, byteOffset: result.byteOffset };
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
  jobs: Pick<Job, "name" | "prompt">[] = [],
  ticketProject?: string,
  ticketTeam?: string,
  securityIssueTrackerUrl?: string,
): Promise<ThreadMessagesResponse & { byteOffset: number }> {
  const resolved = await resolveThreadFile(threadId);
  if (!(resolved && existsSync(resolved.filePath))) {
    clearThread(resolved?.sessionId ?? threadId);
    const parts = queuedHookParts(getHookQueue().list({ threadId, limit: 200 }), jobs, ticketProject, ticketTeam, securityIssueTrackerUrl);
    const start = offset === -1 ? Math.max(0, parts.length - limit) : offset;
    return { threadId, parts: parts.slice(start, start + limit), total: parts.length, byteOffset: 0 };
  }
  const info = await stat(resolved.filePath);
  let cursor = threadCursor(resolved.sessionId);
  if (cursor?.schemaVersion !== 1 || cursor.path !== resolved.filePath || cursor.inode !== info.ino ||
      cursor.size !== info.size || cursor.mtime !== info.mtimeMs) {
    await seedParser(threadId);
    cursor = threadCursor(resolved.sessionId);
  }
  const page = storedParts(resolved.sessionId, limit, offset);
  if (page.total === 0) {
    const parts = queuedHookParts(getHookQueue().list({ threadId, limit: 200 }), jobs, ticketProject, ticketTeam, securityIssueTrackerUrl);
    const start = offset === -1 ? Math.max(0, parts.length - limit) : offset;
    return { threadId, parts: parts.slice(start, start + limit), total: parts.length, byteOffset: cursor?.byteOffset ?? 0 };
  }
  return { threadId, ...page, byteOffset: cursor?.byteOffset ?? 0 };
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
  replaceStored = false,
): Promise<{ parts: ChatPart[]; byteOffset: number; reset?: true }> {
  const resolved = await resolveThreadFile(threadId);
  if (!(resolved && existsSync(resolved.filePath))) {
    clearThread(resolved?.sessionId ?? threadId);
    return { parts: [], byteOffset };
  }
  const file = await open(resolved.filePath, "r");
  try {
    const info = await file.stat();
    let reset = parser.bindFile(resolved.filePath, info.ino);
    if (info.size < byteOffset) {
      parser.reset();
      reset = true;
    }
    if (reset) byteOffset = 0;
    const remaining = info.size - byteOffset;
    const persist = (parts: ChatPart[], offset: number) => saveThread(resolved.sessionId, {
      schemaVersion: 1, path: resolved.filePath, inode: info.ino, size: info.size, mtime: info.mtimeMs,
      byteOffset: offset, lineIndex: parser.nextLineIndex,
    }, parts, reset || replaceStored);
    if (remaining <= 0) {
      if (reset || replaceStored) persist([], byteOffset);
      return { parts: [], byteOffset, ...(reset ? { reset: true } : {}) };
    }

    // Read only appended bytes, never the entire growing transcript.
    const buffer = Buffer.alloc(remaining);
    const { bytesRead } = await file.read(buffer, 0, remaining, byteOffset);
    const bytes = buffer.subarray(0, bytesRead);
    const lastNl = bytes.lastIndexOf(10);
    if (lastNl < 0) { persist([], byteOffset); return { parts: [], byteOffset, ...(reset ? { reset: true } : {}) }; }
    const consumed = bytes.subarray(0, lastNl + 1);
    const parts = parser.feed(consumed.toString("utf-8"));
    persist(parts, byteOffset + consumed.length);
    return { parts, byteOffset: byteOffset + consumed.length, ...(reset ? { reset: true } : {}) };
  } finally {
    await file.close();
  }
}
