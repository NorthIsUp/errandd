"use client"

import { Button } from "../ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible"
import { cn } from "../ui/utils"
import { MonospaceMarkdown } from "./markdown"
import {
  CheckCircle,
  ChevronDown,
  Loader2,
  Settings,
  XCircle,
} from "lucide-react"
import { useState } from "react"

export type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"

export interface ToolPart {
  type: string
  state: ToolState
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  toolCallId?: string
  errorText?: string
}

export interface ToolProps {
  toolPart: ToolPart
  defaultOpen?: boolean
  className?: string
}

// Restyled to DaisyUI semantic tokens (info/warning/success/error) so the
// tool-call status follows the active theme instead of a hardcoded palette.
// Exported so the chain-of-thought rail can reuse the exact same status glyphs
// instead of re-deriving them. `iconClass` lets the dense rail pass a smaller
// glyph (size-3.5) while the standalone card keeps the default size-4.
export function toolStateIcon(state: ToolState, iconClass = "size-4") {
  switch (state) {
    case "input-streaming":
      return <Loader2 className={cn(iconClass, "animate-spin text-info")} />
    case "input-available":
      return <Settings className={cn(iconClass, "text-warning")} />
    case "output-available":
      return <CheckCircle className={cn(iconClass, "text-success")} />
    case "output-error":
      return <XCircle className={cn(iconClass, "text-error")} />
    default:
      return <Settings className={cn(iconClass, "text-muted-foreground")} />
  }
}

/** `compact` shrinks the pill for the dense chain-of-thought rail (the standalone
 *  `Tool` card uses the default, roomier padding). */
export function toolStateBadge(state: ToolState, compact = false) {
  const baseClasses = cn(
    "rounded-full font-medium",
    compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-xs",
  )
  switch (state) {
    case "input-streaming":
      return (
        <span className={cn(baseClasses, "bg-info/15 text-info")}>
          Processing
        </span>
      )
    case "input-available":
      return (
        <span className={cn(baseClasses, "bg-warning/15 text-warning")}>
          Ready
        </span>
      )
    case "output-available":
      return (
        <span className={cn(baseClasses, "bg-success/15 text-success")}>
          Completed
        </span>
      )
    case "output-error":
      return (
        <span className={cn(baseClasses, "bg-error/15 text-error")}>Error</span>
      )
    default:
      return (
        <span className={cn(baseClasses, "bg-base-300 text-base-content/70")}>
          Pending
        </span>
      )
  }
}

/** Render a tool arg / result value: strings raw, everything else pretty JSON. */
export function formatToolValue(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (typeof value === "string") return value
  if (typeof value === "object") {
    return JSON.stringify(value, null, 2)
  }
  return String(value)
}

/** A string arg renders as block markdown (its own line, monospace markdown) when
 *  it's multi-line or long enough to wall up inline — the Agent tool's `prompt` is
 *  the motivating case. Short scalars (subagent_type, a one-line description) stay
 *  inline next to the key. */
export function isBlockValue(value: unknown): value is string {
  return typeof value === "string" && (value.includes("\n") || value.length > 120)
}

export interface ToolContentProps {
  toolPart: ToolPart
  className?: string
}

/**
 * The Input / Output / Error body of a tool call, factored out of {@link Tool}
 * so the chain-of-thought rail can render the SAME body inside its own
 * collapsible trigger instead of hand-rolling a parallel copy. Output stays in
 * a `<pre>` — tool results are raw text (logs, diffs, JSON), not markdown.
 */
export function ToolContent({ toolPart, className }: ToolContentProps) {
  const { state, input, output, toolCallId } = toolPart
  return (
    <div className={cn("bg-background space-y-3 p-3", className)}>
      {input && Object.keys(input).length > 0 && (
        <div>
          <h4 className="text-muted-foreground mb-2 text-sm font-medium">
            Input
          </h4>
          <div className="bg-background rounded border p-2 font-mono text-sm">
            {Object.entries(input).map(([key, value]) =>
              isBlockValue(value) ? (
                <div key={key} className="mb-1">
                  <span className="text-muted-foreground">{key}:</span>
                  <MonospaceMarkdown className="mt-1">{value}</MonospaceMarkdown>
                </div>
              ) : (
                <div key={key} className="mb-1 break-words">
                  <span className="text-muted-foreground">{key}:</span>{" "}
                  <span>{formatToolValue(value)}</span>
                </div>
              )
            )}
          </div>
        </div>
      )}

      {output && (
        <div>
          <h4 className="text-muted-foreground mb-2 text-sm font-medium">
            Output
          </h4>
          <div className="bg-background max-h-60 overflow-auto rounded border p-2 font-mono text-sm">
            <pre className="whitespace-pre-wrap">{formatToolValue(output)}</pre>
          </div>
        </div>
      )}

      {state === "output-error" && toolPart.errorText && (
        <div>
          <h4 className="mb-2 text-sm font-medium text-error">Error</h4>
          <div className="bg-error/10 rounded border border-error/40 p-2 text-sm">
            {toolPart.errorText}
          </div>
        </div>
      )}

      {state === "input-streaming" && (
        <div className="text-muted-foreground text-sm">
          Processing tool call...
        </div>
      )}

      {toolCallId && (
        <div className="text-muted-foreground border-t border-base-300 pt-2 text-xs">
          <span className="font-mono">Call ID: {toolCallId}</span>
        </div>
      )}
    </div>
  )
}

const Tool = ({ toolPart, defaultOpen = false, className }: ToolProps) => {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  return (
    <div
      className={cn(
        "border-border mt-3 overflow-hidden rounded-lg border",
        className
      )}
    >
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="bg-background h-auto w-full justify-between rounded-b-none px-3 py-2 font-normal"
          >
            <div className="flex items-center gap-2">
              {toolStateIcon(toolPart.state)}
              <span className="font-mono text-sm font-medium">
                {toolPart.type}
              </span>
              {toolStateBadge(toolPart.state)}
            </div>
            <ChevronDown className={cn("h-4 w-4", isOpen && "rotate-180")} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent
          className={cn(
            "border-border border-t",
            "data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden"
          )}
        >
          <ToolContent toolPart={toolPart} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

export { Tool }
