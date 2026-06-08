import type { ToolPart as ToolPartData } from "../../lib/transcriptParts";
import { Tool } from "../prompt-kit/tool";

/**
 * A `tool` part — a tool_use call paired with its tool_result. The shared
 * `ToolPart` type mirrors prompt-kit `Tool`'s `toolPart` prop, so it passes
 * straight through. Auto-opens while still streaming or on error.
 */
export function ToolPart({ tool }: { tool: ToolPartData }) {
  const defaultOpen = tool.state === "input-streaming" || tool.state === "output-error";
  return <Tool toolPart={tool} defaultOpen={defaultOpen} />;
}
