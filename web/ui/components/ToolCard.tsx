import { ChevronRight, Wrench } from "lucide-react";
import { useState } from "react";

/**
 * Inline tool-call card. Compact summary by default, click to expand and see
 * the result body. Used both for parsed historical tool fragments and for
 * live `agent_spawn` events (which only have a description, no result).
 */
export function ToolCard({
  name,
  call,
  result,
  pending,
}: {
  name: string;
  call?: string;
  result?: string;
  pending?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasBody = (result?.trim().length ?? 0) > 0;
  return (
    <div className="my-2 rounded-box border border-base-300 bg-base-200 text-sm">
      <button
        type="button"
        onClick={() => hasBody && setOpen((o) => !o)}
        aria-expanded={open}
        className={`flex w-full items-center gap-2 px-3 py-2 text-left ${
          hasBody ? "hover:bg-base-300 cursor-pointer" : "cursor-default"
        }`}
      >
        <Wrench size={14} className="text-base-content/60 shrink-0" />
        <span className="font-mono font-medium shrink-0">{name}</span>
        {call && (
          <span className="font-mono text-xs text-base-content/70 truncate flex-1 min-w-0">
            ({call})
          </span>
        )}
        {pending && <span className="loading loading-spinner loading-xs shrink-0" />}
        {hasBody && (
          <ChevronRight
            size={14}
            className={`ml-auto shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
      </button>
      {open && hasBody && (
        <pre className="px-3 pb-2 pt-0 text-xs font-mono whitespace-pre-wrap break-words text-base-content/80 max-h-48 overflow-y-auto">
          {result}
        </pre>
      )}
    </div>
  );
}
