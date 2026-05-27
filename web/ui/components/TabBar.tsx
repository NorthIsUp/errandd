import type { LucideIcon } from "lucide-react";
import type { TabId } from "../router";

export interface TabSpec {
  id: TabId;
  label: string;
  Icon: LucideIcon;
}

export function TabBar({
  tabs,
  active,
  onSelect,
  variant,
}: {
  tabs: TabSpec[];
  active: TabId;
  onSelect: (id: TabId) => void;
  /** "top": pill row (desktop). "dock": bottom dock (mobile). */
  variant: "top" | "dock";
}) {
  if (variant === "dock") {
    return (
      <nav aria-label="Tabs" className="dock dock-safe bg-base-100 border-t border-base-300">
        {tabs.map(({ id, label, Icon }) => {
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
    <div role="tablist" className="tabs tabs-box bg-base-100">
      {tabs.map(({ id, label, Icon }) => (
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
    </div>
  );
}
