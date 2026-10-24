import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { createContext, type ReactNode, useCallback, use, useState } from "react";
import { createPortal } from "react-dom";
import { z } from "zod";
import "./toolCards.css";
import { isShellToolName } from "../components/ToolOutput";
import type { ToolPart } from "../../shared/transcriptParts";
import {
  ChainOfThoughtGroup,
  ThoughtStep,
  ToolStep,
} from "../v3/components/parts/ChainOfThoughtGroup";

/** Reuse the actual dashboard rail, with its stylesheet isolated from the
 * framework's chat CSS. No copied Bash markup or parallel status styles. */
function ToolTheme({ children }: { children: ReactNode }) {
  const [shadow, setShadow] = useState<ShadowRoot | null>(null);
  const attach = useCallback((host: HTMLDivElement | null) => {
    if (host) {
      setShadow(host.shadowRoot ?? host.attachShadow({ mode: "open" }));
    }
  }, []);
  return (
    <div ref={attach} className="demo-native-tool">
      {shadow
        ? createPortal(
            <>
              <link rel="stylesheet" href="/v3/app.css" />
              <div
                data-theme="tidepool"
                className="bg-base-100 text-base-content"
                style={{ padding: "2px", fontFamily: "ui-sans-serif, system-ui, sans-serif" }}
              >
                {children}
              </div>
            </>,
            shadow,
          )
        : children}
    </div>
  );
}

const InThoughtGroupContext = createContext(false);

/** assistant-ui owns the grouping; the existing Errandd steps supply the rail. */
export function AssistantThoughtGroup({ children }: { children: ReactNode }) {
  return (
    <ToolTheme>
      <InThoughtGroupContext value={true}>{children}</InThoughtGroupContext>
    </ToolTheme>
  );
}

export function AssistantReasoningCard({ text }: { text: string }) {
  return <ThoughtStep markdown={text} />;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function decode(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function frameworkTool({
  name,
  id,
  args,
  result,
  phase,
  failed = false,
}: {
  name: string;
  id: string;
  args: unknown;
  result: unknown;
  phase: "streaming" | "executing" | "complete";
  failed?: boolean;
}): ToolPart {
  const output = decode(result);
  const input = record(decode(args));
  const error = record(output)?.error;
  const isError = failed || error !== undefined;
  const states: Record<typeof phase, ToolPart["state"]> = {
    streaming: "input-streaming",
    executing: "input-available",
    complete: "output-available",
  };
  const tool: ToolPart = {
    type: name,
    toolCallId: id,
    state: isError ? "output-error" : states[phase],
  };
  if (input) {
    tool.input = input;
  } else if (typeof args === "string" && args) {
    tool.input = { partial: args };
  }
  if (result !== undefined) {
    const resultRecord = record(output);
    const rawShell =
      typeof result === "string" &&
      isShellToolName(name) &&
      typeof resultRecord?.text !== "string" &&
      typeof resultRecord?.stdout !== "string";
    tool.output = rawShell ? { text: result } : (resultRecord ?? { text: output });
  }
  if (isError) {
    const detail = error ?? output;
    tool.errorText =
      typeof detail === "string" ? detail : (JSON.stringify(detail) ?? "Tool failed");
  }
  return tool;
}

export function ErranddToolCard({ tool }: { tool: ToolPart }) {
  return (
    <ToolTheme>
      <ChainOfThoughtGroup parts={[{ id: tool.toolCallId ?? tool.type, kind: "tool", tool }]} />
    </ToolTheme>
  );
}

const routineSchema = z.object({ routine: z.string(), mode: z.string().optional() });
/** One shared custom React card, registered by tool name in both frameworks. */
export function RoutineCard({ tool }: { tool: ToolPart }) {
  const parameters = routineSchema.safeParse(tool.input);
  if (!parameters.success || tool.state === "output-error") {
    return <ErranddToolCard tool={tool} />;
  }
  const result = tool.output;
  const files = Array.isArray(result?.changedFiles)
    ? result.changedFiles.filter((file): file is string => typeof file === "string")
    : [];
  return (
    <article className="demo-routine-card" data-custom-card="routine">
      <header>
        <span>Routine preview</span>
        <strong>{tool.state === "output-available" ? "Ready" : "Checking…"}</strong>
      </header>
      <h3>{parameters.data.routine}</h3>
      {typeof result?.checks === "number" && <p>{result.checks} checks completed</p>}
      {files.length > 0 && (
        <ul>
          {files.map((file) => (
            <li key={file}>
              <code>{file}</code>
            </li>
          ))}
        </ul>
      )}
      <a href="/v3/">Open routines →</a>
    </article>
  );
}

function assistantTool(props: ToolCallMessagePartProps) {
  return frameworkTool({
    name: props.toolName,
    id: props.toolCallId,
    args: props.argsText,
    result: props.result,
    phase:
      props.result === undefined
        ? record(decode(props.argsText))
          ? "executing"
          : "streaming"
        : "complete",
    failed: props.isError ?? false,
  });
}
export function AssistantToolCard(props: ToolCallMessagePartProps) {
  const grouped = use(InThoughtGroupContext);
  const tool = assistantTool(props);
  return grouped ? <ToolStep tool={tool} /> : <ErranddToolCard tool={tool} />;
}
export function AssistantRoutineCard(props: ToolCallMessagePartProps) {
  return <RoutineCard tool={assistantTool(props)} />;
}
