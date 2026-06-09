import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueueTree } from "../hooks/useQueueTree";
import { useScheduledRoutines } from "../hooks/useScheduledRoutines";
import { BOTTOM_NAV } from "../nav";
import { deferredUntilForThread } from "../lib/queuedUntil";
import type { SidebarTree, TreeSource } from "../lib/tree";
import type { V3View } from "../router";
import { SectionTree, type SortMode } from "./SectionTree";
import { ThemePicker } from "./ThemePicker";
import { cn } from "./ui/utils";

const COLLAPSE_KEY = "clawdcode:v3:collapsed";
const SORT_KEY = "clawdcode:v3:sort";

function loadSort(): SortMode {
  try {
    return localStorage.getItem(SORT_KEY) === "num" ? "num" : "recent";
  } catch {
    return "recent";
  }
}

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
  const { tree, messages, loading, error, connected } = useQueueTree();
  // Schedules come from scheduled JOBS + their run SESSIONS, not the hook queue
  // (cron runs never enter the queue), so we splice that section in over the
  // queue-sourced (empty) one. The other four sections stay queue-sourced.
  const { section: scheduledSection, turnByThread } = useScheduledRoutines();
  const [collapsed, setCollapsed] = useState<CollapseMap>(loadCollapsed);

  // Merge: replace the live tree's "routines" (Schedules) section with the
  // jobs+sessions-sourced one, preserving section order. Then join the per-thread
  // turn count (from the sessions store) onto each chat leaf so the row can show
  // how many turns the conversation has.
  const mergedTree = useMemo<SidebarTree>(() => {
    const merged = tree.map((s) => (s.source === "routines" ? scheduledSection : s));
    if (turnByThread.size === 0) {
      return merged;
    }
    return merged.map((section) => ({
      ...section,
      items: section.items.map((item) => ({
        ...item,
        routines: item.routines.map((ref) => {
          const turns = turnByThread.get(ref.threadId);
          return turns == null ? ref : { ...ref, turnCount: turns };
        }),
      })),
    }));
  }, [tree, scheduledSection, turnByThread]);

  // threadId → epoch-ms it resumes (deferred/rate-limited rows). Drives the
  // "queued · HH:MM" badge on the relevant thread rows.
  const deferredByThread = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    for (const m of messages) {
      const until = deferredUntilForThread(messages, m.threadId);
      if (until > 0) {
        map.set(m.threadId, until);
      }
    }
    return map;
  }, [messages]);

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

  const [sortMode, setSortMode] = useState<SortMode>(loadSort);
  const changeSort = useCallback((m: SortMode) => {
    setSortMode(m);
    try {
      localStorage.setItem(SORT_KEY, m);
    } catch {
      // ignore unavailable storage
    }
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
        <ThemePicker />
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
            sections={mergedTree}
            activeThreadId={activeThreadId}
            onSelectThread={onSelectThread}
            collapsed={collapsed}
            onToggleSection={toggleSection}
            sortMode={sortMode}
            onSortChange={changeSort}
            deferredByThread={deferredByThread}
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
