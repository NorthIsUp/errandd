import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

export interface Crumb {
  label: ReactNode;
  onClick?: (() => void) | undefined;
}

export function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav
      aria-label="breadcrumb"
      className="text-sm text-base-content/70 overflow-x-auto whitespace-nowrap"
    >
      <ol className="inline-flex items-center gap-1">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          const key = `${i}:${typeof c.label === "string" ? c.label : ""}`;
          return (
            <li key={key} className="inline-flex items-center gap-1">
              {i > 0 && <ChevronRight size={14} className="opacity-50" />}
              {c.onClick && !last ? (
                <button type="button" onClick={c.onClick} className="link link-hover font-medium">
                  {c.label}
                </button>
              ) : (
                <span className={last ? "font-medium text-base-content" : ""}>{c.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
