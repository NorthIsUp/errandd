import { Brain } from "lucide-react";
import type { ChatPart, ToolPart as ToolPartData } from "../../lib/transcriptParts";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtStep,
  ChainOfThoughtTrigger,
} from "../prompt-kit/chain-of-thought";
import { Markdown } from "../prompt-kit/markdown";
import { ToolContent, toolStateBadge, toolStateIcon } from "../prompt-kit/tool";

/**
 * Render a run of consecutive `reasoning` + `tool` parts as a single "train of
 * thought": each thought and each tool call becomes a collapsible node hanging
 * off one vertical timeline rail (prompt-kit `ChainOfThought`), instead of the
 * old flat stack of full-width cards. Real assistant text, FYI/system blocks,
 * and sources stay as normal messages BETWEEN rails (see `PartList`).
 *
 * The thinking body renders through prompt-kit `Markdown` and the tool body
 * through prompt-kit `ToolContent` — the rail composes those vendored pieces
 * rather than hand-rolling parallel copies (the standalone prompt-kit `Tool`
 * and `Reasoning` ship their OWN collapsible chrome, which can't express the
 * shared-rail UX, so we reuse their bodies under the rail's trigger/content).
 *
 * A `CotPart` is any part eligible for the rail. The grouping itself lives in
 * `PartList`; this component only renders one already-collected group.
 */
export type CotPart = Extract<ChatPart, { kind: "reasoning" | "tool" }>;

export function ChainOfThoughtGroup({ parts }: { parts: CotPart[] }) {
  return (
    <ChainOfThought className="my-1">
      {parts.map((part) =>
        part.kind === "reasoning" ? (
          <ThoughtStep key={part.id} markdown={part.markdown} />
        ) : (
          <ToolStep key={part.id} tool={part.tool} />
        ),
      )}
    </ChainOfThought>
  );
}

/** A thinking node: Brain dot + first-line preview, expands to the full body. */
function ThoughtStep({ markdown }: { markdown: string }) {
  return (
    <ChainOfThoughtStep>
      <ChainOfThoughtTrigger
        leftIcon={<Brain className="size-3.5 text-primary/70" />}
        className="text-[13px] font-medium text-base-content/80"
      >
        {previewLine(markdown) || "Thought"}
      </ChainOfThoughtTrigger>
      <ChainOfThoughtContent>
        <div className="border-l-2 border-base-300 pl-3 text-sm leading-relaxed text-base-content/70">
          <Markdown>{markdown}</Markdown>
        </div>
      </ChainOfThoughtContent>
    </ChainOfThoughtStep>
  );
}

/** A tool node: state dot + name + arg hint + status, expands to the prompt-kit
 *  `ToolContent` body (input/output/error). Collapsed by default; auto-opens
 *  only while streaming or on error. */
function ToolStep({ tool }: { tool: ToolPartData }) {
  const open = tool.state === "input-streaming" || tool.state === "output-error";
  const hint = toolHint(tool.input);
  return (
    <ChainOfThoughtStep defaultOpen={open}>
      <ChainOfThoughtTrigger
        leftIcon={toolStateIcon(tool.state, "size-3.5")}
        className="text-[13px] text-base-content/80"
      >
        <span className="font-mono font-medium">{tool.type}</span>
        {hint && <span className="ml-2 text-base-content/45">{hint}</span>}
        <span className="ml-2">{toolStateBadge(tool.state, true)}</span>
      </ChainOfThoughtTrigger>
      <ChainOfThoughtContent>
        <div className="overflow-hidden rounded-lg border border-base-300 text-sm">
          <ToolContent toolPart={tool} className="space-y-2" />
        </div>
      </ChainOfThoughtContent>
    </ChainOfThoughtStep>
  );
}

/** A short, representative one-liner for a tool's args (e.g. the command/path). */
function toolHint(input: Record<string, unknown> | undefined): string {
  if (!input) {
    return "";
  }
  const preferred = ["command", "file_path", "path", "pattern", "query", "url", "prompt"];
  for (const key of preferred) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) {
      return truncate(v.trim(), 56);
    }
  }
  const firstString = Object.values(input).find((v) => typeof v === "string" && v.trim());
  return typeof firstString === "string" ? truncate(firstString.trim(), 56) : "";
}

/** First non-empty line of a markdown body, stripped of heading/quote marks. */
function previewLine(markdown: string): string {
  const line = markdown
    .split("\n")
    .map((l) => l.replace(/^[#>\-*\s]+/, "").trim())
    .find((l) => l.length > 0);
  return line ? truncate(line, 72) : "";
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
