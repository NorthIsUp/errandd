import { useMemo } from "react";
import { collapseAllNested, defaultStyles, JsonView } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import { DiffCodeBlock } from "./UnifiedDiff";
import { CopyButton } from "./CopyButton";
import "./tool-output.css";

export function isShellToolName(name: string) {
  return /^(?:bash|shell|exec_command|command_execution)$/i.test(name);
}

export function toolOutputText(toolName: string, output: Record<string, unknown>) {
  const shell = isShellToolName(toolName);
  const textKey =
    shell && typeof output.text === "string"
      ? "text"
      : shell && typeof output.stdout === "string"
        ? "stdout"
        : null;
  const raw = textKey ? (output[textKey] as string) : JSON.stringify(output, null, 2);
  const extra = textKey
    ? Object.fromEntries(Object.entries(output).filter(([key]) => key !== textKey))
    : {};
  return { shell, raw, extra };
}
function parseJson(raw: string): { value: unknown } | null {
  try {
    const value: unknown = JSON.parse(raw);
    return { value };
  } catch {
    return null;
  }
}
const jsonStyles = {
  ...defaultStyles,
  container: "errandd-json-tree",
  label: "errandd-json-key",
  stringValue: "errandd-json-string",
  numberValue: "errandd-json-number",
  booleanValue: "errandd-json-number",
  nullValue: "errandd-json-null",
};

/** Parsing is only for presentation. Clipboard always receives the unmodified
 * original stdout, including indentation, trailing whitespace and newlines. */
export function ToolOutput({
  toolName,
  output,
}: {
  toolName: string;
  output: Record<string, unknown>;
}) {
  const { raw, extra, parsed } = useMemo(() => {
    const rendered = toolOutputText(toolName, output);
    return { ...rendered, parsed: rendered.shell ? parseJson(rendered.raw) : null };
  }, [toolName, output]);
  return (
    <div
      className="bg-background relative rounded border p-2 pr-10 font-mono text-sm"
      data-output-format={parsed ? "json" : "text"}
    >
      <CopyButton text={raw} label="output" />
      {parsed ? (
        <div className="errandd-json-output" role="region" aria-label="JSON output">
          {parsed.value !== null && typeof parsed.value === "object" ? (
            <JsonView
              data={parsed.value}
              shouldExpandNode={collapseAllNested}
              style={jsonStyles}
              aria-label="JSON tree"
            />
          ) : (
            <code>{JSON.stringify(parsed.value)}</code>
          )}
        </div>
      ) : (
        <DiffCodeBlock code={raw} copyLabel={null}>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap">{raw}</pre>
        </DiffCodeBlock>
      )}
      {Object.keys(extra).length > 0 && (
        <details className="errandd-output-metadata">
          <summary>Result metadata</summary>
          <pre>{JSON.stringify(extra, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
