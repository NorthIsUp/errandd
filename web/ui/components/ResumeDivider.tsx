import { RotateCcw } from "lucide-react";

/**
 * Visual marker that the user re-engaged with a previously-quiet session.
 * Rendered between transcript messages.
 */
export function ResumeDivider({ at }: { at: string }) {
  const ts = new Date(at);
  const stamp = Number.isNaN(ts.getTime())
    ? at
    : `${ts.toLocaleDateString()} ${ts.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}`;
  return (
    <div className="flex items-center gap-3 my-3 text-xs text-base-content/60">
      <div className="flex-1 border-t border-dashed border-base-300" />
      <span className="inline-flex items-center gap-1.5 font-medium">
        <RotateCcw size={12} aria-hidden />
        resumed · {stamp}
      </span>
      <div className="flex-1 border-t border-dashed border-base-300" />
    </div>
  );
}
