import { MoonStar, SunMedium } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BOTTOM_NAV } from "../App";
import { useQueueTree } from "../hooks/useQueueTree";
import type { TreeSource } from "../lib/tree";
import type { V3View } from "../router";
import { SectionTree } from "./SectionTree";
import { cn } from "./ui/utils";

const COLLAPSE_KEY = "clawdcode:v3:collapsed";

type CollapseMap = Record<string, boolean>;

function loadCollapsed(): CollapseMap {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (raw) {
      return JSON.parse(raw) as CollapseMap;
    }
  } catch {
    // ignore corrupt/unavailable storage
  }
  return {};
}

/**
 * v3 sidebar (spec §4). Two stacked zones inside the shell's `<aside>`:
 *
 *   ┌──────────────────────┐
 *   │ 🦞 ClawdCode      v3  │  header
 *   ├──────────────────────┤
 *   │ ▸ SCHEDULES          │  hook-source tree (live, from the queue SSE)
 *   │ ▾ PULL REQUESTS      │
 *   │     repo#12 · main   │
 *   │       pr-review  ◉   │
 *   ├──────────────────────┤
 *   │ Del  Rout  Set  About│  bottom nav (switches the main route)
 *   └──────────────────────┘
 *
 * Drop-in replacement for App.tsx's `SidebarPlaceholder`: same prop shape, so
 * integration only swaps the import. Selecting a thread calls `onSelectThread`
 * (→ `#/chat/<id>`); a bottom-nav item calls `onSelectView` (→ `#/<view>`).
 */
export type SidebarProps = {
  activeView: V3View;
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onSelectView: (view: V3View) => void;
};

export function Sidebar({
  activeView,
  activeThreadId,
  onSelectThread,
  onSelectView,
}: SidebarProps) {
  const { tree, loading, error, connected } = useQueueTree();
  const [collapsed, setCollapsed] = useState<CollapseMap>(loadCollapsed);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
    } catch {
      // ignore unavailable storage
    }
  }, [collapsed]);

  const toggleSection = useCallback((source: TreeSource) => {
    setCollapsed((prev) => ({ ...prev, [source]: !prev[source] }));
  }, []);

  // Theme toggle — v3 commits to Abyssal (dark) / Tidepool (light), persisted.
  const [theme, setTheme] = useState<string>(
    () => document.documentElement.getAttribute("data-theme") || "abyssal",
  );
  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === "tidepool" ? "abyssal" : "tidepool";
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem("clawdcode:v3:theme", next);
        document
          .querySelector('meta[name="theme-color"]')
          ?.setAttribute("content", next === "tidepool" ? "#f4efe4" : "#101a1e");
      } catch {
        // ignore unavailable storage
      }
      return next;
    });
  }, []);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-base-300 px-3 py-3">
        <span
          className="select-none text-xl"
          aria-hidden
          style={{
            filter:
              "drop-shadow(0 0 9px color-mix(in oklab, var(--color-primary) 55%, transparent))",
          }}
        >
          🦞
        </span>
        <span className="font-serif text-2xl leading-none tracking-tight">
          clawd<span className="text-primary">code</span>
        </span>
        <button
          type="button"
          onClick={toggleTheme}
          title={theme === "tidepool" ? "Switch to Abyssal (dark)" : "Switch to Tidepool (light)"}
          className="ml-auto grid size-6 place-items-center rounded-md text-base-content/50 transition-colors hover:bg-base-200 hover:text-base-content"
        >
          {theme === "tidepool" ? (
            <SunMedium className="size-3.5" />
          ) : (
            <MoonStar className="size-3.5" />
          )}
        </button>
        <span
          className={cn(
            "inline-flex items-center gap-1 font-mono text-[10px] tracking-wide",
            connected ? "text-success" : "text-base-content/40",
          )}
          title={connected ? "live queue stream connected" : "queue stream offline"}
        >
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              connected ? "v3-biolum bg-success" : "bg-base-content/30",
            )}
          />
          v3
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error ? (
          <p className="px-3 py-4 text-xs text-error">Failed to load hook queue: {error.message}</p>
        ) : loading ? (
          <p className="px-3 py-4 text-xs text-base-content/50">Loading hook sources…</p>
        ) : (
          <SectionTree
            sections={tree}
            activeThreadId={activeThreadId}
            onSelectThread={onSelectThread}
            collapsed={collapsed}
            onToggleSection={toggleSection}
          />
        )}
      </div>

      <nav className="grid grid-cols-5 gap-1 border-t border-base-300 p-2">
        {BOTTOM_NAV.map(({ view, label, Icon }) => (
          <button
            key={view}
            type="button"
            onClick={() => onSelectView(view)}
            className={cn(
              "flex flex-col items-center gap-1 rounded-md py-2 text-[11px] transition-colors",
              activeView === view
                ? "bg-base-200 text-primary"
                : "text-base-content/70 hover:bg-base-200",
            )}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </nav>
    </>
  );
}
