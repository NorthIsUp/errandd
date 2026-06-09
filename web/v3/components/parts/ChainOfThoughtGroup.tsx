import { Brain, CheckCircle, Loader2, Settings, Terminal, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { ChatPart, ToolPart as ToolPartData } from "../../lib/transcriptParts";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtStep,
  ChainOfThoughtTrigger,
} from "../prompt-kit/chain-of-thought";
import { Markdown } from "../prompt-kit/markdown";

/**
 * Render a run of consecutive `reasoning` + `tool` parts as a single "train of
 * thought": each thought and each tool call becomes a collapsible node hanging
 * off one vertical timeline rail (prompt-kit `ChainOfThought`), instead of the
 * old flat stack of full-width cards. Real assistant text, FYI/system blocks,
 * and sources stay as normal messages BETWEEN rails (see `PartList`).
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

/** A tool node: state dot + name + arg hint + status, expands to input/output. */
function ToolStep({ tool }: { tool: ToolPartData }) {
  const open = tool.state === "input-streaming" || tool.state === "output-error";
  const hint = toolHint(tool.input);
  return (
    <ChainOfThoughtStep defaultOpen={open}>
      <ChainOfThoughtTrigger
        leftIcon={stateIcon(tool.state)}
        className="text-[13px] text-base-content/80"
      >
        <span className="font-mono font-medium">{tool.type}</span>
        {hint && <span className="ml-2 text-base-content/45">{hint}</span>}
        <span className="ml-2">{stateBadge(tool.state)}</span>
      </ChainOfThoughtTrigger>
      <ChainOfThoughtContent>
        <ToolDetails tool={tool} />
      </ChainOfThoughtContent>
    </ChainOfThoughtStep>
  );
}

/** Input / output / error body for a tool node (mirrors prompt-kit `Tool`). */
function ToolDetails({ tool }: { tool: ToolPartData }) {
  const { state, input, output } = tool;
  return (
    <div className="space-y-2 text-sm">
      {input && Object.keys(input).length > 0 && (
        <Block label="Input">
          {Object.entries(input).map(([key, value]) => (
            <div key={key} className="mb-1 break-words">
              <span className="text-base-content/50">{key}:</span>{" "}
              <span>{formatValue(value)}</span>
            </div>
          ))}
        </Block>
      )}
      {output && (
        <Block label="Output">
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap">{formatValue(output)}</pre>
        </Block>
      )}
      {state === "output-error" && tool.errorText && (
        <div className="rounded border border-error/40 bg-error/10 p-2 text-error">
          {tool.errorText}
        </div>
      )}
      {state === "input-streaming" && (
        <div className="text-base-content/50">Processing tool call…</div>
      )}
    </div>
  );
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-medium text-base-content/50">{label}</h4>
      <div className="rounded border border-base-300 bg-base-200/50 p-2 font-mono text-[12px] leading-relaxed">
        {children}
      </div>
    </div>
  );
}

function stateIcon(state: ToolPartData["state"]) {
  switch (state) {
    case "input-streaming":
      return <Loader2 className="size-3.5 animate-spin text-info" />;
    case "input-available":
      return <Settings className="size-3.5 text-warning" />;
    case "output-available":
      return <CheckCircle className="size-3.5 text-success" />;
    case "output-error":
      return <XCircle className="size-3.5 text-error" />;
    default:
      return <Terminal className="size-3.5 text-base-content/50" />;
  }
}

function stateBadge(state: ToolPartData["state"]) {
  const base = "rounded-full px-1.5 py-0.5 text-[10px] font-medium";
  switch (state) {
    case "input-streaming":
      return <span className={`${base} bg-info/15 text-info`}>Running</span>;
    case "input-available":
      return <span className={`${base} bg-warning/15 text-warning`}>Ready</span>;
    case "output-available":
      return <span className={`${base} bg-success/15 text-success`}>Done</span>;
    case "output-error":
      return <span className={`${base} bg-error/15 text-error`}>Error</span>;
    default:
      return <span className={`${base} bg-base-300 text-base-content/60`}>Pending</span>;
  }
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

/** Tool input/output is JSON-derived; render strings raw, everything else as
 *  pretty JSON (objects, numbers, booleans, null). */
function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "null";
}
