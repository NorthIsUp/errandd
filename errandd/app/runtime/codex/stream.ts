import type { RuntimeStreamHandlers, RuntimeUsage } from "../types";

type RecordValue = Record<string, unknown>;
const rec = (v: unknown): RecordValue =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as RecordValue) : {};
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const TOOL_TYPES = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);

function usageOf(value: unknown): RuntimeUsage {
  const raw = rec(value);
  const usage: RuntimeUsage = {};
  if (typeof raw.input_tokens === "number") {
    usage.inputTokens = raw.input_tokens;
  }
  if (typeof raw.output_tokens === "number") {
    usage.outputTokens = raw.output_tokens;
  }
  if (typeof raw.cached_input_tokens === "number") {
    usage.cacheReadTokens = raw.cached_input_tokens;
  }
  if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }
  return usage;
}

class CodexStream {
  private sessionId = "";
  private text = "";
  private tools = new Set<string>();
  constructor(private handlers: RuntimeStreamHandlers) {}

  async dispatch(event: RecordValue): Promise<void> {
    const h = this.handlers;
    switch (event.type) {
      case "thread.started":
        this.sessionId = str(event.thread_id);
        if (this.sessionId) {
          await h.onSession?.(this.sessionId);
        }
        break;
      case "item.started":
      case "item.completed":
        await this.item(rec(event.item), event.type === "item.completed");
        break;
      case "turn.completed":
        await h.onResult?.({
          text: this.text,
          sessionId: this.sessionId || undefined,
          contextTokens: 0,
          usage: usageOf(event.usage),
        });
        break;
      default:
        break;
    }
  }

  private async item(item: RecordValue, completed: boolean): Promise<void> {
    if (item.type === "agent_message" && completed) {
      this.text = str(item.text);
      if (this.text) {
        await this.handlers.onAssistant?.([{ type: "text", text: this.text }], str(item.id));
      }
      return;
    }
    if (!TOOL_TYPES.has(str(item.type))) {
      return;
    }
    await this.startTool(item);
    if (completed) {
      const failed =
        item.status === "failed" ||
        (typeof item.exit_code === "number" && item.exit_code !== 0) ||
        !!item.error;
      await this.handlers.onToolResult?.(
        str(item.id),
        item.aggregated_output ?? item.result ?? item.changes ?? item.error ?? "",
        failed,
      );
    }
  }

  private async startTool(item: RecordValue): Promise<void> {
    const id = str(item.id);
    if (this.tools.has(id)) {
      return;
    }
    this.tools.add(id);
    const input =
      item.type === "command_execution"
        ? { command: str(item.command) }
        : item.type === "mcp_tool_call"
          ? rec(item.arguments)
          : item;
    await this.handlers.onAssistant?.(
      [
        {
          type: "tool_use",
          id,
          name: item.type === "mcp_tool_call" ? str(item.tool) : str(item.type),
          input,
        },
      ],
      id,
    );
    await this.handlers.onToolUseHint?.();
  }
}

/** Translate Codex exec JSONL into the shared runtime stream contract. */
export async function parseCodexRuntimeStream(
  stdout: ReadableStream<Uint8Array>,
  handlers: RuntimeStreamHandlers,
): Promise<void> {
  const state = new CodexStream(handlers);
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const dispatch = async (line: string): Promise<void> => {
    try {
      await state.dispatch(rec(JSON.parse(line)));
    } catch {
      // Malformed records and consumer exceptions do not truncate stdout.
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        await dispatch(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      await dispatch(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}
