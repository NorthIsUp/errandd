// errandd's normalized runtime stream → AG-UI events (https://ag-ui.com).
//
// AG-UI is a standard protocol for the agent→frontend channel. Because we
// already normalize both coding-agent CLIs (claude, pi) into one
// RuntimeStreamHandlers event model, emitting AG-UI is a thin adapter over that
// seam — it works for whichever runtime ERRANDD_RUNTIME selects.
//
// Wire facts (verified against docs.ag-ui.com/sdk/js/core/events): event `type`
// values are SCREAMING_SNAKE_CASE; fields are camelCase (messageId, delta,
// toolCallId, toolCallName, content). The route wraps these mid-stream events
// with RUN_STARTED / RUN_FINISHED / RUN_ERROR.

import { randomUUID } from "node:crypto";
import type { RuntimeBlock, RuntimeStreamHandlers } from "../runtime/types";

export type AguiEvent = { type: string } & Record<string, unknown>;
export type AguiSend = (event: AguiEvent) => void;

/** Read a string `text` field off a content block, else "". */
function blockText(b: unknown): string {
  if (b && typeof b === "object" && "text" in b) {
    const t = (b).text;
    return typeof t === "string" ? t : "";
  }
  return "";
}

/** Flatten a normalized tool-result payload (string | block[] | object) to
 *  text — AG-UI's TOOL_CALL_RESULT.content is a string. */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(blockText).join("");
  if (content == null) return "";
  try {
    return JSON.stringify(content) ?? "";
  } catch {
    return "[unserializable]";
  }
}

export interface AguiAdapter {
  handlers: RuntimeStreamHandlers;
  /** Final assistant text, for RUN_FINISHED.result. */
  resultText: () => string;
}

/**
 * Map errandd's normalized RuntimeStreamHandlers → AG-UI events.
 *
 * The normalized stream yields WHOLE assistant messages (not token deltas), so
 * each assistant text turn is emitted as a self-contained
 * TEXT_MESSAGE_START → _CONTENT → _END triplet, and each tool call as
 * TOOL_CALL_START → _ARGS → _END. Emitting closed triplets (rather than leaving
 * a message/tool "open") also satisfies AG-UI's event-sequence rules for free.
 */
export function createAguiAdapter(send: AguiSend): AguiAdapter {
  let finalText = "";

  const handlers: RuntimeStreamHandlers = {
    onAssistant(blocks: RuntimeBlock[], messageId: string) {
      // One AG-UI message per assistant turn: concat this turn's text blocks.
      const text = blocks
        .filter((b): b is Extract<RuntimeBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text) {
        const mid = messageId || randomUUID();
        send({ type: "TEXT_MESSAGE_START", messageId: mid, role: "assistant" });
        send({ type: "TEXT_MESSAGE_CONTENT", messageId: mid, delta: text });
        send({ type: "TEXT_MESSAGE_END", messageId: mid });
        finalText = text;
      }
      for (const b of blocks) {
        if (b.type !== "tool_use") continue;
        send({
          type: "TOOL_CALL_START",
          toolCallId: b.id,
          toolCallName: b.name,
          ...(messageId ? { parentMessageId: messageId } : {}),
        });
        send({ type: "TOOL_CALL_ARGS", toolCallId: b.id, delta: JSON.stringify(b.input ?? {}) });
        send({ type: "TOOL_CALL_END", toolCallId: b.id });
      }
    },

    onToolResult(toolCallId: string, content: unknown, isError: boolean) {
      send({
        type: "TOOL_CALL_RESULT",
        messageId: randomUUID(),
        toolCallId,
        content: contentToText(content),
        role: "tool",
        ...(isError ? { isError: true } : {}),
      });
    },

    onResult(ev) {
      if (ev.text) finalText = ev.text;
    },
  };

  return { handlers, resultText: () => finalText };
}

/**
 * Pull the prompt from an AG-UI RunAgentInput ({messages:[…]}, last user turn)
 * or a plain {prompt} body. Returns "" when neither is present.
 */
export function extractPrompt(body: unknown): string {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof b.prompt === "string" && b.prompt.trim()) return b.prompt.trim();

  const messages = Array.isArray(b.messages) ? b.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = (messages[i] && typeof messages[i] === "object" ? messages[i] : {}) as Record<string, unknown>;
    if (m.role !== "user") continue;
    if (typeof m.content === "string" && m.content.trim()) return m.content.trim();
    if (Array.isArray(m.content)) {
      const t = m.content.map(blockText).join("");
      if (t.trim()) return t.trim();
    }
  }
  return "";
}
