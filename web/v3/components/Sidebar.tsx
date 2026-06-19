import { useCallback, useEffect, useMemo, useState } from "react";
import { agoShort, useBuildInfo } from "../hooks/useBuildInfo";
import { useQueueTree } from "../hooks/useQueueTree";
import { useScheduledRoutines } from "../hooks/useScheduledRoutines";
import { useUsage } from "../hooks/useUsage";
import { BOTTOM_NAV } from "../nav";
import type { SidebarTree } from "../lib/tree";
import type { V3View } from "../router";
import { SectionTree, type SortMode } from "./SectionTree";
import { ThemePicker } from "./ThemePicker";
import { cn } from "./ui/utils";

// The map records which nodes are *open* (`openMap[key] === true`). Everything
// defaults to closed, so an unknown/new key reads as closed — that's how a
// first-time visitor (no saved state) sees a fully collapsed tree. The key is
// bumped from the legacy `:collapsed` map (inverted, sections-only) so old data
// can't leak the wrong defaults.
const OPEN_KEY = "clawdcode:v3:open";
const SORT_KEY = "clawdcode:v3:sort";

function loadSort(): SortMode {
  try {
    return localStorage.getItem(SORT_KEY) === "num" ? "num" : "recent";
  } catch {
    return "recent";
  }
}

/**
 * Open-state for every collapsible node in the sidebar tree, keyed by a stable
 * id (`nodeKey()` in SectionTree namespaces sections / repo groups / items so
 * they can't collide). `openMap[key] === true` ⇒ open; absent/false ⇒ closed.
 */
export type OpenMap = Record<string, boolean>;

function loadOpen(): OpenMap {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    if (raw) {
      return JSON.parse(raw) as OpenMap;
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
  const build = useBuildInfo();
  // Schedules come from scheduled JOBS + their run SESSIONS, not the hook queue
  // (cron runs never enter the queue), so we splice that section in over the
  // queue-sourced (empty) one. The other four sections stay queue-sourced.
  const { section: scheduledSection, turnByThread } = useScheduledRoutines();
  const usageByThread = useUsage();
  // Read persisted open-state before first paint (lazy init) so the tree never
  // flashes open-then-closed on load.
  const [openMap, setOpenMap] = useState<OpenMap>(loadOpen);

  // Merge: replace the live tree's "routines" (Schedules) section with the
  // jobs+sessions-sourced one, preserving section order. Then join the per-thread
  // turn count (from the sessions store) onto each chat leaf so the row can show
  // how many turns the conversation has.
  const mergedTree = useMemo<SidebarTree>(() => {
    const merged = tree.map((s) => (s.source === "routines" ? scheduledSection : s));
    if (turnByThread.size === 0 && usageByThread.size === 0) {
      return merged;
    }
    return merged.map((section) => ({
      ...section,
      items: section.items.map((item) => ({
        ...item,
        routines: item.routines.map((ref) => {
          const turns = turnByThread.get(ref.threadId);
          const tokens = usageByThread.get(ref.threadId);
          if (turns == null && tokens == null) {
            return ref;
          }
          return {
            ...ref,
            ...(turns == null ? {} : { turnCount: turns }),
            ...(tokens == null ? {} : { tokens }),
          };
        }),
      })),
    }));
  }, [tree, scheduledSection, turnByThread, usageByThread]);

  // threadId → epoch-ms it resumes (deferred/rate-limited rows). Drives the
  // "queued · HH:MM" badge on the relevant thread rows.
  const deferredByThread = useMemo<Map<string, number>>(() => {
    // Single pass: min(notBefore) per thread among deferred rows. (Was O(n²) —
    // it called deferredUntilForThread, which itself scans all messages, once
    // per message.)
    const now = Date.now();
    const map = new Map<string, number>();
    for (const m of messages) {
      if (m.status === "pending" && typeof m.notBefore === "number" && m.notBefore > now) {
        const cur = map.get(m.threadId);
        map.set(m.threadId, cur === undefined ? m.notBefore : Math.min(cur, m.notBefore));
      }
    }
    return map;
  }, [messages]);

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(openMap));
    } catch {
      // ignore unavailable storage
    }
  }, [openMap]);

  // Toggle any node (section / repo group / item) by its stable key. Absent keys
  // are closed, so the first toggle opens them; closing deletes the key so the
  // store stays a clean set of only-open nodes (no unbounded stale growth).
  const toggleNode = useCallback((key: string) => {
    setOpenMap((prev) => {
      if (prev[key]) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: true };
    });
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
        {build.version ? (
          <span
            className="ml-auto select-text text-right font-mono text-[10px] leading-tight text-base-content/45"
            title={`build ${build.version}${build.sha ? ` · ${build.sha}` : " · image build"}${
              build.startedAt
                ? `\ndeployed ${new Date(build.startedAt).toLocaleString()} (${agoShort(build.startedAt)} ago)`
                : ""
            }`}
          >
            v{build.version}
            {build.startedAt ? (
              <span className="text-base-content/30"> · {agoShort(build.startedAt)}</span>
            ) : null}
          </span>
        ) : null}
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
            openMap={openMap}
            onToggleNode={toggleNode}
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
