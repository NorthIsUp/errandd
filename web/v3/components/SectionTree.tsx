import { Bug, CalendarClock, ChevronLeft, ChevronRight, Clock, GitPullRequest, Siren, Ticket } from "lucide-react";
import { useMemo, type ComponentType } from "react";
import { fmtLocalHM } from "../lib/queuedUntil";
import { COUNT_STOPS, DAYS_STOPS, pageItems, type ViewMode } from "../lib/paging";
import type { ThreadRef, TreeItem, TreeSection, TreeSource } from "../lib/tree";
import { useSectionView } from "../hooks/useSectionView";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { cn } from "./ui/utils";

/**
 * The hook-source tree (spec §4). Four collapsible sections (Schedules /
 * Errors / Alerts / Pull Requests), each listing its items (PR / Sentry issue
 * / Datadog monitor / routine), each expanding to its routine threads. Every
 * thread row carries a status badge derived from the live queue state (logic
 * ported from web/ui/sections/PrsSection.tsx `QueueStatusBadge`).
 *
 * Collapse state + thread selection live in the parent (Sidebar) so they can be
 * persisted / shared with the router; this component is presentational.
 */

const SECTION_ICON: Record<TreeSource, ComponentType<{ className?: string }>> = {
  routines: CalendarClock,
  sentry: Bug,
  datadog: Siren,
  linear: Ticket,
  github: GitPullRequest,
};

export type SortMode = "recent" | "num";

/**
 * Stable, namespaced open-state keys. Every collapsible node — section, repo
 * group, item disclosure — maps to one of these so its open/closed state
 * persists across reloads and as the live tree changes. Unknown keys read as
 * closed (the openMap only records nodes the user has opened).
 */
const nodeKey = {
  section: (source: TreeSource) => `sec:${source}`,
  repo: (source: TreeSource, repo: string) => `repo:${source}:${repo}`,
  item: (key: string) => `item:${key}`,
};

export type SectionTreeProps = {
  sections: TreeSection[];
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  /** Open-state for every node: `openMap[key] === true` ⇒ node open; everything
   *  else is closed (so a first visit with no saved state is fully collapsed). */
  openMap: Record<string, boolean>;
  /** Toggle a node by its stable `nodeKey`. */
  onToggleNode: (key: string) => void;
  /** PR sort order (Pull Requests section). */
  sortMode: SortMode;
  onSortChange: (mode: SortMode) => void;
  /** threadId → epoch-ms it resumes, for deferred/rate-limited rows. Drives the
   *  "queued · HH:MM" badge. Empty/absent ⇒ no thread is deferred. */
  deferredByThread?: Map<string, number>;
};

export function SectionTree({
  sections,
  activeThreadId,
  onSelectThread,
  openMap,
  onToggleNode,
  sortMode,
  onSortChange,
  deferredByThread,
}: SectionTreeProps) {
  return (
    <div className="flex flex-col">
      {sections.map((section) => {
        const key = nodeKey.section(section.source);
        return (
          <SectionBlock
            key={section.source}
            section={section}
            open={openMap[key] === true}
            onToggle={() => onToggleNode(key)}
            activeThreadId={activeThreadId}
            onSelectThread={onSelectThread}
            openMap={openMap}
            onToggleNode={onToggleNode}
            sortMode={sortMode}
            onSortChange={onSortChange}
            deferredByThread={deferredByThread}
          />
        );
      })}
    </div>
  );
}

/** Order items by the chosen sort: by PR number (desc) or recency (desc). */
function sortItems(items: TreeItem[], mode: SortMode): TreeItem[] {
  const sorted = [...items];
  if (mode === "num") {
    sorted.sort((a, b) => (b.num ?? 0) - (a.num ?? 0));
  } else {
    sorted.sort((a, b) => b.lastAt - a.lastAt);
  }
  return sorted;
}

/** Group GitHub items by org/repo, repos ordered by most-recent activity. */
function groupByRepo(items: TreeItem[]): { repo: string; items: TreeItem[]; lastAt: number }[] {
  const groups = new Map<string, { repo: string; items: TreeItem[]; lastAt: number }>();
  for (const it of items) {
    const repo = it.repo ?? "—";
    let g = groups.get(repo);
    if (!g) {
      g = { repo, items: [], lastAt: 0 };
      groups.set(repo, g);
    }
    g.items.push(it);
    g.lastAt = Math.max(g.lastAt, it.lastAt);
  }
  return [...groups.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** The four hook sources that get a count/days filter + pagination control. */
const FILTERED_SOURCES = new Set<TreeSource>(["sentry", "datadog", "linear", "github"]);

function SectionBlock({
  section,
  open,
  onToggle,
  activeThreadId,
  onSelectThread,
  openMap,
  onToggleNode,
  sortMode,
  onSortChange,
  deferredByThread,
}: {
  section: TreeSection;
  open: boolean;
  onToggle: () => void;
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  openMap: Record<string, boolean>;
  onToggleNode: (key: string) => void;
  sortMode: SortMode;
  onSortChange: (mode: SortMode) => void;
  deferredByThread: Map<string, number> | undefined;
}) {
  const Icon = SECTION_ICON[section.source];
  const totalCount = section.items.length;
  const isGithub = section.source === "github";
  const isFiltered = FILTERED_SOURCES.has(section.source);

  // Per-section view state (only instantiated for the 4 filtered sections).
  const view = useSectionView(section.source);

  // Capture now once per render so days-window math is stable within a render.
  // useMemo with an empty dep array: same as useState(() => Date.now()) but
  // avoids allocating state — acceptable here since this is browser-only code.
  const now = useMemo(() => Date.now(), []);

  // Apply paging to the flat item list for the 4 filtered sections.
  const paged = useMemo(() => {
    if (!isFiltered) {
      return null;
    }
    return pageItems(section.items, view.mode, view.value, view.page, now);
  }, [isFiltered, section.items, view.mode, view.value, view.page, now]);

  // The items to actually render: paginated for filtered sections, raw otherwise.
  const visibleItems = paged ? paged.items : section.items;

  return (
    <Collapsible open={open} className="border-b border-base-300/60 last:border-b-0">
      <CollapsibleTrigger
        onClick={onToggle}
        className="group flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-base-content/60 hover:text-base-content"
      >
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        <Icon className="size-4 shrink-0 opacity-80" />
        <span className="flex-1 truncate font-serif text-[15px] normal-case tracking-normal text-base-content/85">
          {section.label}
        </span>
        {totalCount > 0 && (
          <span className="font-mono text-[10px] font-normal text-base-content/40">
            {paged
              ? // Filtered sections: "X–Y of N" (count mode) or "X of N" (days mode)
                paged.from > 0
                ? `${paged.from}–${paged.to} of ${paged.total}`
                : `${paged.items.length} of ${paged.total}`
              : // Routines section: plain count
                totalCount}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-1">
        {totalCount === 0 ? (
          <p className="px-3 pb-2 pl-9 text-xs text-base-content/35">No activity yet.</p>
        ) : isGithub ? (
          <>
            {/* GitHub: controls + sort bar side-by-side above the repo groups */}
            {paged && (
              <SectionControls
                view={view}
                hasPrev={paged.hasPrev}
                hasNext={paged.hasNext}
              />
            )}
            <SortBar mode={sortMode} onChange={onSortChange} />
            {groupByRepo(visibleItems).map((g) => {
              const key = nodeKey.repo(section.source, g.repo);
              return (
                <RepoGroup
                  key={g.repo}
                  repo={g.repo}
                  items={sortItems(g.items, sortMode)}
                  open={openMap[key] === true}
                  onToggle={() => onToggleNode(key)}
                  activeThreadId={activeThreadId}
                  onSelectThread={onSelectThread}
                  openMap={openMap}
                  onToggleNode={onToggleNode}
                  deferredByThread={deferredByThread}
                />
              );
            })}
          </>
        ) : isFiltered && paged ? (
          <>
            <SectionControls
              view={view}
              hasPrev={paged.hasPrev}
              hasNext={paged.hasNext}
            />
            {visibleItems.map((item) => (
              <ItemBlock
                key={item.key}
                item={item}
                open={openMap[nodeKey.item(item.key)] === true}
                onToggle={() => onToggleNode(nodeKey.item(item.key))}
                activeThreadId={activeThreadId}
                onSelectThread={onSelectThread}
                deferredByThread={deferredByThread}
              />
            ))}
          </>
        ) : (
          section.items.map((item) => (
            <ItemBlock
              key={item.key}
              item={item}
              open={openMap[nodeKey.item(item.key)] === true}
              onToggle={() => onToggleNode(nodeKey.item(item.key))}
              activeThreadId={activeThreadId}
              onSelectThread={onSelectThread}
              deferredByThread={deferredByThread}
            />
          ))
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Per-section control bar: mode toggle (count/days), a slider for the active
 * mode's stops, and prev/next pagination buttons with a page readout.
 *
 * Visual language matches the existing SortBar: tiny mono labels,
 * `text-[10px]`, `pl-9` indent, `bg-primary/15 text-primary` active pill.
 */
function SectionControls({
  view,
  hasPrev,
  hasNext,
}: {
  view: ReturnType<typeof useSectionView>;
  hasPrev: boolean;
  hasNext: boolean;
}) {
  const { mode, value, setMode, setValue, nextPage, prevPage } = view;
  const stops = mode === "count" ? COUNT_STOPS : DAYS_STOPS;
  // Map the current value to its 0-based index in the stops array for the
  // range input. If value isn't in the stops list (shouldn't happen after
  // validation in useSectionView), clamp to 0.
  const stopIndex = Math.max(0, (stops as readonly number[]).indexOf(value));
  const label = mode === "count" ? `${value}` : `${value}d`;

  return (
    <div className="flex flex-col gap-0.5 px-3 pb-1.5 pl-9">
      {/* Row 1: mode toggle + slider + page nav */}
      <div className="flex items-center gap-1 text-[10px]">
        {/* Mode toggle */}
        <span className="font-mono uppercase tracking-wide text-base-content/35">show</span>
        {(["count", "days"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              "rounded px-1.5 py-0.5 font-mono transition-colors",
              mode === m
                ? "bg-primary/15 text-primary"
                : "text-base-content/45 hover:bg-base-200 hover:text-base-content/70",
            )}
          >
            {m}
          </button>
        ))}

        {/* Slider — maps to discrete stops */}
        <input
          type="range"
          min={0}
          max={stops.length - 1}
          step={1}
          value={stopIndex}
          onChange={(e) => {
            const idx = Number(e.target.value);
            const stop = stops[idx];
            if (stop != null) {
              setValue(stop);
            }
          }}
          aria-label={`${mode === "count" ? "Items per page" : "Days window"}: ${label}`}
          className="h-1 w-16 cursor-pointer appearance-none rounded bg-base-300 accent-primary"
        />

        {/* Current slider value label */}
        <span className="w-5 font-mono text-base-content/45 tabular-nums">{label}</span>

        {/* Pagination: newer / older */}
        <button
          type="button"
          onClick={prevPage}
          disabled={!hasPrev}
          aria-label="Newer page"
          className={cn(
            "rounded p-0.5 transition-colors",
            hasPrev
              ? "text-base-content/55 hover:bg-base-200 hover:text-base-content/80"
              : "cursor-not-allowed opacity-30 text-base-content/30",
          )}
        >
          <ChevronLeft className="size-3" />
        </button>
        <button
          type="button"
          onClick={nextPage}
          disabled={!hasNext}
          aria-label="Older page"
          className={cn(
            "rounded p-0.5 transition-colors",
            hasNext
              ? "text-base-content/55 hover:bg-base-200 hover:text-base-content/80"
              : "cursor-not-allowed opacity-30 text-base-content/30",
          )}
        >
          <ChevronRight className="size-3" />
        </button>
      </div>
    </div>
  );
}

/** Sort toggle for the Pull Requests section. */
function SortBar({ mode, onChange }: { mode: SortMode; onChange: (m: SortMode) => void }) {
  return (
    <div className="flex items-center gap-1 px-3 pb-1.5 pl-9 text-[10px]">
      <span className="font-mono uppercase tracking-wide text-base-content/35">sort</span>
      {(
        [
          ["num", "#"],
          ["recent", "recent"],
        ] as const
      ).map(([m, label]) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={cn(
            "rounded px-1.5 py-0.5 font-mono transition-colors",
            mode === m
              ? "bg-primary/15 text-primary"
              : "text-base-content/45 hover:bg-base-200 hover:text-base-content/70",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** A collapsible org/repo group — the repo is the header; rows are `#num — name`. */
function RepoGroup({
  repo,
  items,
  open,
  onToggle,
  activeThreadId,
  onSelectThread,
  openMap,
  onToggleNode,
  deferredByThread,
}: {
  repo: string;
  items: TreeItem[];
  open: boolean;
  onToggle: () => void;
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  openMap: Record<string, boolean>;
  onToggleNode: (key: string) => void;
  deferredByThread: Map<string, number> | undefined;
}) {
  return (
    <Collapsible open={open}>
      <CollapsibleTrigger
        onClick={onToggle}
        className="group flex w-full items-center gap-1.5 px-3 py-1 pl-7 text-left hover:bg-base-200/50"
      >
        <ChevronRight className="size-3 shrink-0 text-base-content/40 transition-transform group-data-[state=open]:rotate-90" />
        <span className="flex-1 truncate font-mono text-[11px] text-base-content/55" title={repo}>
          {repo}
        </span>
        <span className="font-mono text-[10px] text-base-content/35">{items.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {items.map((item) => {
          const key = nodeKey.item(item.key);
          return (
            <ItemBlock
              key={item.key}
              item={item}
              open={openMap[key] === true}
              onToggle={() => onToggleNode(key)}
              activeThreadId={activeThreadId}
              onSelectThread={onSelectThread}
              deferredByThread={deferredByThread}
            />
          );
        })}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ItemBlock({
  item,
  open,
  onToggle,
  activeThreadId,
  onSelectThread,
  deferredByThread,
}: {
  item: TreeItem;
  open: boolean;
  onToggle: () => void;
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  deferredByThread: Map<string, number> | undefined;
}) {
  // Item-level (PR/subject) deferred badge: earliest resume time across this
  // item's threads, so a rate-limited PR reads "queued · HH:MM" at the item row
  // even when collapsed.
  const itemDeferredUntil = deferredByThread
    ? item.routines.reduce((earliest, r) => {
        const until = deferredByThread.get(r.threadId) ?? 0;
        if (until <= 0) {
          return earliest;
        }
        return earliest === 0 ? until : Math.min(earliest, until);
      }, 0)
    : 0;
  // Every item is a disclosure — even a single-routine PR — so you can always
  // see WHICH routine (.md) handled it, not just the PR title.
  return (
    <Collapsible open={open}>
      <CollapsibleTrigger
        onClick={onToggle}
        className="group flex w-full items-center gap-1.5 px-3 py-1 pl-7 text-left text-sm hover:bg-base-200/60"
      >
        <ChevronRight className="size-3 shrink-0 text-base-content/40 transition-transform group-data-[state=open]:rotate-90" />
        <span className="flex-1 truncate font-medium text-base-content/90" title={item.title}>
          {item.title}
        </span>
        {itemDeferredUntil > 0 && <QueuedBadge until={itemDeferredUntil} />}
        <span className="font-mono text-[10px] text-base-content/40">{item.routines.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {item.routines.map((ref) => (
          <ThreadRow
            key={ref.threadId}
            label={ref.jobName}
            ref_={ref}
            active={activeThreadId === ref.threadId}
            onSelect={() => onSelectThread(ref.threadId)}
            indent="pl-12"
            deferredUntil={deferredByThread?.get(ref.threadId) ?? 0}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Compact "queued · HH:MM" badge for a deferred (rate-limited) thread/PR. */
function QueuedBadge({ until }: { until: number }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 font-mono text-[10px] text-warning"
      title={`queued — resumes ${fmtLocalHM(until)}`}
    >
      <Clock className="size-2.5" />
      queued · {fmtLocalHM(until)}
    </span>
  );
}

function ThreadRow({
  label,
  ref_,
  active,
  onSelect,
  indent,
  deferredUntil,
}: {
  label: string;
  ref_: ThreadRef;
  active: boolean;
  onSelect: () => void;
  indent: string;
  /** Epoch-ms the thread resumes when deferred/rate-limited (0 ⇒ not). */
  deferredUntil?: number;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group flex w-full items-center gap-2 py-1 pr-2 text-left text-sm transition-colors",
        indent,
        active
          ? "bg-primary/10 text-primary"
          : "text-base-content/80 hover:bg-base-200/60 hover:text-base-content",
      )}
    >
      <span className="flex-1 truncate" title={label}>
        {label}
      </span>
      {ref_.turnCount != null && ref_.turnCount > 0 && (
        <span
          className="font-mono text-[10px] text-base-content/35 tabular-nums"
          title={`${ref_.turnCount} ${ref_.turnCount === 1 ? "turn" : "turns"} in this conversation`}
        >
          {ref_.turnCount}t
        </span>
      )}
      {deferredUntil && deferredUntil > 0 ? (
        <QueuedBadge until={deferredUntil} />
      ) : (
        <ThreadBadge ref_={ref_} />
      )}
    </button>
  );
}

/**
 * Status badge for a thread, derived from the latest queue row's status +
 * outcome. Ported from PrsSection's `QueueStatusBadge`:
 *   running → info (spinner) · queued/pending → warning · failed → error
 *   done: outcome ok → success · pass → neutral · error → error.
 */
function ThreadBadge({ ref_ }: { ref_: ThreadRef }) {
  const { status, outcome } = ref_;
  // Status language: running = info/blue (in-progress, NOT red — red is reserved
  // for errors), queued = amber, failed/error = red, resolved = teal, pass =
  // faint. `pulse` gives running the live "breathing" dot.
  if (status === "running") {
    return <StatusDot tone="info" label="running" pulse title="agent is running" />;
  }
  if (status === "pending") {
    return <StatusDot tone="warning" label="queued" title="queued — waiting to run" />;
  }
  if (status === "failed") {
    return <StatusDot tone="error" label="failed" title="run failed" />;
  }
  if (outcome === "pass") {
    return <StatusDot tone="faint" label="pass" title="agent ran and chose to no-op" />;
  }
  if (outcome === "error") {
    return <StatusDot tone="error" label="error" title="agent reported an error" />;
  }
  return <StatusDot tone="success" label={outcome ?? "ok"} title="resolved" />;
}

const TONE_DOT: Record<string, string> = {
  primary: "bg-primary",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
  faint: "bg-base-content/40",
};
const TONE_TEXT: Record<string, string> = {
  primary: "text-primary",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  error: "text-error",
  faint: "text-base-content/45",
};

function StatusDot({
  tone,
  label,
  title,
  pulse,
}: {
  tone: keyof typeof TONE_DOT;
  label: string;
  title?: string;
  pulse?: boolean;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 font-mono text-[10px]", TONE_TEXT[tone])}
      title={title}
    >
      <span
        className={cn(
          "inline-block size-[7px] shrink-0 rounded-full",
          TONE_DOT[tone],
          pulse && "v3-biolum",
        )}
      />
      {label}
    </span>
  );
}
