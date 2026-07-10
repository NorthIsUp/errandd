import { Fragment } from "react";
import type { LucideIcon } from "lucide-react";
import type { TabId } from "../router";

export interface TabSpec {
  id: TabId;
  label: string;
  Icon: LucideIcon;
}

/**
 * Tabs may be passed as a flat `TabSpec[]` (no grouping) or as
 * `TabSpec[][]` to denote logical groups — a thin vertical divider
 * renders between groups in the top variant. Dock variant flattens.
 */
function normalizeGroups(tabs: TabSpec[] | TabSpec[][]): TabSpec[][] {
  if (tabs.length === 0) return [];
  return Array.isArray(tabs[0]) ? (tabs as TabSpec[][]) : [tabs as TabSpec[]];
}

export function TabBar({
  tabs,
  active,
  onSelect,
  variant,
}: {
  tabs: TabSpec[] | TabSpec[][];
  active: TabId;
  onSelect: (id: TabId) => void;
  /** "top": pill row (desktop). "dock": bottom dock (mobile). */
  variant: "top" | "dock";
}) {
  const groups = normalizeGroups(tabs);

  if (variant === "dock") {
    // Dock has no room for visual dividers — flatten and render.
    const flat = groups.flat();
    return (
      <nav aria-label="Tabs" className="dock dock-safe bg-base-100 border-t border-base-300">
        {flat.map(({ id, label, Icon }) => {
          const sel = id === active;
          return (
            <button
              key={id}
              type="button"
              aria-current={sel ? "page" : undefined}
              onClick={() => onSelect(id)}
              className={sel ? "dock-active text-primary" : ""}
            >
              <Icon size={20} aria-hidden />
              <span className="dock-label">{label}</span>
            </button>
          );
        })}
      </nav>
    );
  }
  return (
    <div role="tablist" className="tabs tabs-box bg-base-100 items-center">
      {groups.map((group, i) => (
        <Fragment key={`g${i}`}>
          {i > 0 && (
            <span
              aria-hidden
              className="mx-1 h-5 w-px bg-base-300 self-center"
            />
          )}
          {group.map(({ id, label, Icon }) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={id === active}
              onClick={() => onSelect(id)}
              className={`tab gap-2 ${id === active ? "tab-active" : ""}`}
            >
              <Icon size={16} aria-hidden />
              <span>{label}</span>
            </button>
          ))}
        </Fragment>
      ))}
    </div>
  );
}
