/**
 * Shared transcript-part types for the v3 chat pane (spec §6).
 *
 * The backend (`src/ui/services/threadParts.ts`) parses a session's jsonl
 * transcript into this `ChatPart[]` shape; the frontend chat pane
 * (`ChatPane.tsx` + `parts/*`) renders each part with the matching prompt-kit
 * component. This file is the single source of truth imported by both sides —
 * do not re-declare these shapes elsewhere.
 */

/** A reference link surfaced under an assistant turn (hook origin, file:line). */
export type SourceLink = {
  href: string;
  label: string;
  title?: string;
};

/**
 * A tool invocation paired with its result. Mirrors the prop shape consumed by
 * prompt-kit's `Tool` component (`ToolPart`), so a renderer can pass it through
 * with minimal adaptation.
 */
export type ToolPart = {
  /** Tool name, e.g. "Bash", "Read", "mcp__…". */
  type: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error";
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  toolCallId?: string;
  errorText?: string;
};

/**
 * One renderable block of a thread transcript. `id` is stable per part (derived
 * from the transcript line + block index) so React keys and streaming
 * append/update deltas line up.
 */
export type ChatPart =
  | { kind: "system"; id: string; text: string }
  | {
      kind: "text";
      id: string;
      role: "user" | "assistant";
      markdown: string;
    }
  | { kind: "reasoning"; id: string; markdown: string }
  | { kind: "tool"; id: string; tool: ToolPart }
  | { kind: "sources"; id: string; sources: SourceLink[] };

/** Page of parts returned by GET /api/v3/threads/:id/messages. */
export type ThreadMessagesResponse = {
  threadId: string;
  parts: ChatPart[];
  /** Total parts available (for pagination), if known. */
  total?: number;
};

/** SSE event shapes emitted by GET /api/v3/threads/:id/stream. */
export type ThreadStreamEvent =
  | { type: "snapshot"; parts: ChatPart[] }
  | { type: "append"; parts: ChatPart[] }
  | { type: "update"; part: ChatPart }
  | { type: "status"; status: "queued" | "running" | "done" | "error" };
