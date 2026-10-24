import { hookOrigin } from "./hookOrigin";
import type { Message } from "@ag-ui/client";
import type { ChatPart, SourceLink } from "./transcriptParts";
import { webhookDisplayMarkdown } from "./webhookDisplay";

export interface CapturedChat {
  id: string;
  title: string;
  threadId: string;
  sourceUrl: string;
  totalParts: number;
  parts: ChatPart[];
  sources: SourceLink[];
}
export interface ChatExamples {
  version: 1;
  sourceOrigin: string;
  capturedAt: string;
  examples: CapturedChat[];
}

/** Shorten text only for the comparison view; the private capture is intact. */
export function displayExamples(examples: CapturedChat[], compact: boolean): CapturedChat[] {
  if (!compact) return examples;
  // Cutting through HTML tags/attributes corrupts the rendered comment.
  // Preserve HTML-bearing messages even in compact mode.
  const excerpt = (text: string) => text.length > 1600 && !/<\/?[a-z][^>]*>/i.test(text)
    ? `${text.slice(0, 600)}\n\n[Comparison excerpt: ${text.length - 1200} characters omitted; disable shortened text to read the full capture.]\n\n${text.slice(-600)}`
    : text;
  return examples.map((example) => ({ ...example, parts: example.parts.map((part) => {
    if (part.kind === "text") return { ...part, markdown: excerpt(part.markdown) };
    if (part.kind === "system") return { ...part, text: excerpt(part.text) };
    return part;
  }) }));
}

/** Keep the stock comparison on standard AG-UI messages. FYI and source
 * annotations stay outside the conversation instead of becoming agent turns. */
export function toStockMessages(examples: CapturedChat[]): Message[] {
  const messages: Message[] = [];
  for (const example of examples) {
    for (const part of example.parts) {
      if (part.notInContext || part.kind === "sources") continue;
      const id = `${example.id}:${part.id}`;
      switch (part.kind) {
        case "text": {
          const origin = part.role === "user" ? hookOrigin(part.markdown, example.threadId) : null;
          messages.push({ id, role: part.role, content: part.role === "user" ? webhookDisplayMarkdown(part.markdown) : part.markdown,
            ...(origin ? { metadata: { errandd: { origin } } } : {}) });
          break;
        }
        case "system":
          messages.push({ id, role: "system", content: part.text });
          break;
        case "reasoning":
          messages.push({ id, role: "reasoning", content: part.markdown });
          break;
        case "tool": {
          const callId = `${example.id}:${part.tool.toolCallId || part.id}`;
          messages.push({ id, role: "assistant", toolCalls: [{ id: callId, type: "function", function: { name: part.tool.type, arguments: JSON.stringify(part.tool.input ?? {}) } }] });
          if (part.tool.state === "output-available" || part.tool.state === "output-error") {
            messages.push({ id: `${id}:result`, role: "tool", toolCallId: callId, content: part.tool.state === "output-error" ? JSON.stringify({ ...part.tool.output, error: part.tool.errorText || part.tool.output || "Tool failed" }) : JSON.stringify(part.tool.output ?? {}) });
          }
          break;
        }
      }
    }
  }
  return messages;
}

export function exampleMetrics(examples: CapturedChat[]) {
  const parts = examples.flatMap((example) => example.parts);
  return {
    parts: parts.length,
    tools: parts.filter((part) => part.kind === "tool").length,
    errors: parts.filter((part) => part.kind === "tool" && part.tool.state === "output-error").length,
    fyi: parts.filter((part) => part.notInContext).length,
    reasoning: parts.filter((part) => part.kind === "reasoning").length,
    edits: parts.filter((part) => part.kind === "tool" && /edit|write|patch/i.test(part.tool.type)).length,
    sources: examples.reduce((count, example) => count + example.sources.length, 0),
  };
}
