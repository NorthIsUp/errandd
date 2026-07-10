import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";

/**
 * Single-row disclosure built on a <details>-like model but driven by state so
 * the trigger and the body can live in different parts of the DOM (e.g.
 * spanning multiple table cells).
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-base-300 rounded-box bg-base-100">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 sm:px-3 py-2 text-left hover:bg-base-200 rounded-box"
      >
        <ChevronRight
          size={16}
          className={`transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
        />
        <div className="flex-1 min-w-0">{summary}</div>
      </button>
      {open && <div className="px-2 sm:px-3 pb-3 pt-1">{children}</div>}
    </div>
  );
}
