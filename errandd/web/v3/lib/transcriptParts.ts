/**
 * Frontend re-export of the shared transcript-part types.
 *
 * The shapes now live in `shared/transcriptParts.ts` (the single source of
 * truth imported by both the backend parser and this chat pane). This file
 * stays as the stable import path for the v3 frontend components.
 */
export type {
  ChatPart,
  SourceLink,
  ThreadMessagesResponse,
  ThreadStreamEvent,
  ToolPart,
} from "../../../shared/transcriptParts";
