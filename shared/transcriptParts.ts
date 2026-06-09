/**
 * Shared transcript-part types for the v3 chat pane (spec §6).
 *
 * The single source of truth for the transcript-part shapes. The backend
 * (`src/ui/services/threadParts.ts`) parses a session's jsonl transcript into
 * this `ChatPart[]` shape; the frontend chat pane (`ChatPane.tsx` + `parts/*`)
 * renders each part with the matching prompt-kit component. Both sides import
 * from here (the frontend via the `web/v3/lib/transcriptParts.ts` re-export) so
 * the shapes never drift — do not re-declare these elsewhere.
 *
 * Pure types, no runtime — bundles to the browser.
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
export type ChatPart = (
  | { kind: "system"; id: string; text: string }
  | {
      kind: "text";
      id: string;
      role: "user" | "assistant";
      markdown: string;
    }
  | { kind: "reasoning"; id: string; markdown: string }
  | { kind: "tool"; id: string; tool: ToolPart }
  | { kind: "sources"; id: string; sources: SourceLink[] }
) & {
  /** Epoch ms of the transcript entry this part came from (for timestamps). */
  at?: number;
  /**
   * True = this block is FYI only and was NOT part of the model's context — a
   * pre-filtered (dropped) hook, a suppressed bot body, the full untruncated
   * payload, or a `[skip:fyi]` / `[skip:ignore]` reason. The chat pane renders
   * these in a distinct blue "Not sent to the agent (FYI)" box.
   *
   * Mirrors the backend's recorded-decision shape: a `DeliveryRoutine` with
   * `prefilter: true` yields a synthetic `[skip:fyi]` session, which the parser
   * (`src/ui/services/threadParts.ts`) maps to a `system` part with this flag.
   *
   * Absent (falsy) = normal in-context block. Truncated essentials are still
   * in-context, so they do NOT set this flag.
   */
  notInContext?: boolean;
};

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
