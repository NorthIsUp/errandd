import { Bug, CalendarClock, ChevronLeft, ChevronRight, Clock, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Siren, Ticket, TriangleAlert } from "lucide-react";
import { useMemo, type ComponentType } from "react";
import { fmtLocalHM } from "../lib/queuedUntil";
import { COUNT_STOPS, DAYS_STOPS, pageItems } from "../lib/paging";
import { filterByPrState, PR_STATE_ORDER, TERMINAL_WINDOW_BUSINESS_HOURS } from "../lib/prFilter";
import { mergePolledPRs, type PolledPR, type PrGitState, type ThreadRef, type TreeItem, type TreeSection, type TreeSource } from "../lib/tree";
import { useOpenPRs } from "../hooks/useOpenPRs";
import { usePrStateFilter, type PrStateFilterControls } from "../hooks/usePrStateFilter";
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

/**
 * Per-PR git-state icon (open / draft / merged / closed / conflicted). Colors
 * use daisyUI tokens where they map cleanly (success/error/warning); merged
 * uses GitHub's merge-purple since no daisy token is purple, and draft its
 * neutral grey. `unknown` is the fail-safe fallback — a faint pull-request
 * outline — so an unclassified state renders quietly instead of crashing the row.
 */
const PR_STATE_META: Record<
  PrGitState,
  { Icon: ComponentType<{ className?: string }>; className: string; label: string }
> = {
  open: { Icon: GitPullRequest, className: "text-success", label: "Open" },
  draft: { Icon: GitPullRequestDraft, className: "text-base-content/50", label: "Draft" },
  merged: { Icon: GitMerge, className: "text-[#8957e5]", label: "Merged" },
  closed: { Icon: GitPullRequestClosed, className: "text-error", label: "Closed" },
  conflicted: { Icon: TriangleAlert, className: "text-warning", label: "Merge conflict" },
  unknown: { Icon: GitPullRequest, className: "text-base-content/35", label: "Unknown state" },
};

function PrStateIcon({ state }: { state: PrGitState | undefined }) {
  const meta = PR_STATE_META[state ?? "unknown"];
  const Icon = meta.Icon;
  return (
    <span
      title={`PR state: ${meta.label}`}
      aria-label={`PR state: ${meta.label}`}
      className="flex shrink-0 items-center"
    >
      <Icon className={cn("size-3.5", meta.className)} />
    </span>
  );
}

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

export interface SectionTreeProps {
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
}

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
  // Fetch all open PRs from the reconciliation poller (one fetch loop for all sections).
  const openPRs = useOpenPRs();

  // Per-PR git-state keyed by `repo#num`. The daemon already reconciles its two
  // sources (poller open-list + webhook/backfill store) into one map, so the
  // client just reads it; anything absent ⇒ neutral icon.
  const stateByKey = useMemo(() => {
    const map: Record<string, PrGitState> = {};
    for (const [key, info] of Object.entries(openPRs.states)) {
      map[key] = info.state;
    }
    return map;
  }, [openPRs.states]);

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
            openPRsPrs={openPRs.prs}
            stateByKey={stateByKey}
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

/** Compact token count for the sidebar: 1.2M / 340k / 920. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${Math.round(n / 1_000)}k`;
  }
  return String(n);
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
  openPRsPrs,
  stateByKey,
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
  openPRsPrs: PolledPR[];
  stateByKey: Record<string, PrGitState>;
}) {
  const Icon = SECTION_ICON[section.source];
  const isGithub = section.source === "github";
  const isFiltered = FILTERED_SOURCES.has(section.source);

  // Per-section view state (only instantiated for the 4 filtered sections).
  const view = useSectionView(section.source);

  // Git-state show/hide chips. Only rendered for the github section, but the
  // hook runs unconditionally — hooks can't be called behind a branch.
  const prFilter = usePrStateFilter();

  // Capture now once per render so days-window math is stable within a render.
  // useMemo with an empty dep array: same as useState(() => Date.now()) but
  // avoids allocating state — acceptable here since this is browser-only code.
  // eslint-disable-next-line react-hooks/purity -- a single mount-time clock read for a relative-time window; intentionally not reactive.
  const now = useMemo(() => Date.now(), []);

  // For the github section, merge in polled-only open PRs that aren't yet in
  // the durable queue (idle PRs, webhook-missed events, etc.).
  const merged = useMemo(
    () => (isGithub ? mergePolledPRs(section.items, openPRsPrs) : section.items),
    [isGithub, section.items, openPRsPrs],
  );

  // Git-state filter, before paging so the "X of N" counts describe what the
  // user asked to see rather than what the queue happens to hold.
  const effectiveItems = useMemo(
    () => (isGithub ? filterByPrState(merged, stateByKey, prFilter.filter, now) : merged),
    [isGithub, merged, stateByKey, prFilter.filter, now],
  );

  const totalCount = effectiveItems.length;

  // Apply paging to the flat item list for the 4 filtered sections.
  const paged = useMemo(() => {
    if (!isFiltered) {
      return null;
    }
    return pageItems(effectiveItems, view.mode, view.value, view.page, now);
  }, [isFiltered, effectiveItems, view.mode, view.value, view.page, now]);

  // The items to actually render: paginated for filtered sections, raw otherwise.
  const visibleItems = paged ? paged.items : effectiveItems;

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
        {isGithub && merged.length > 0 ? (
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
            {/* Rendered even when the filter hides everything — otherwise the
                only way back from an all-off filter would be devtools. */}
            <StateFilterBar controls={prFilter} />
            {totalCount === 0 ? (
              <p className="px-3 pb-2 pl-9 text-xs text-base-content/35">
                {merged.length} PR{merged.length === 1 ? "" : "s"} hidden by the state filter.
              </p>
            ) : (
              groupByRepo(visibleItems).map((g) => {
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
                    stateByKey={stateByKey}
                  />
                );
              })
            )}
          </>
        ) : totalCount === 0 ? (
          <p className="px-3 pb-2 pl-9 text-xs text-base-content/35">No activity yet.</p>
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

/**
 * Show/hide chips for the Pull Requests section — one per git state, using the
 * same icon the rows do, plus a clock chip for the merged/closed recency window.
 *
 * Icon-only by design: six labels don't fit the sidebar, and the icons are the
 * vocabulary the rows already taught. Each chip is a checkbox (`aria-pressed`)
 * with the state name in its title, and an off chip stays visible at low opacity
 * so the way back is always on screen.
 */
function StateFilterBar({ controls }: { controls: PrStateFilterControls }) {
  const { filter, toggleState, toggleRecentOnly } = controls;
  return (
    <div className="flex items-center gap-1 px-3 pb-1.5 pl-9 text-[10px]">
      <span className="font-mono uppercase tracking-wide text-base-content/35">show</span>
      {PR_STATE_ORDER.map((state) => {
        const meta = PR_STATE_META[state];
        const on = filter.visible[state];
        const Icon = meta.Icon;
        return (
          <button
            key={state}
            type="button"
            onClick={() => toggleState(state)}
            aria-pressed={on}
            title={`${meta.label} — ${on ? "shown" : "hidden"}`}
            aria-label={`${meta.label} — ${on ? "shown" : "hidden"}`}
            className={cn(
              "rounded p-0.5 transition-colors",
              on ? "bg-primary/15" : "opacity-35 hover:bg-base-200 hover:opacity-70",
            )}
          >
            <Icon className={cn("size-3.5", meta.className)} />
          </button>
        );
      })}
      <button
        type="button"
        onClick={toggleRecentOnly}
        aria-pressed={filter.recentTerminalOnly}
        title={
          filter.recentTerminalOnly
            ? `Merged/closed limited to the last ${TERMINAL_WINDOW_BUSINESS_HOURS} business hours (weekends skipped)`
            : "Merged/closed shown however long ago they ended"
        }
        aria-label={`Recent merged/closed only: ${filter.recentTerminalOnly ? "on" : "off"}`}
        className={cn(
          "ml-0.5 flex items-center gap-0.5 rounded px-1 py-0.5 font-mono transition-colors",
          filter.recentTerminalOnly
            ? "bg-primary/15 text-primary"
            : "text-base-content/45 hover:bg-base-200 hover:text-base-content/70",
        )}
      >
        <Clock className="size-3" />
        {TERMINAL_WINDOW_BUSINESS_HOURS}h
      </button>
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
  stateByKey,
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
  stateByKey: Record<string, PrGitState>;
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
              prState={stateByKey[item.key]}
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
  prState,
}: {
  item: TreeItem;
  open: boolean;
  onToggle: () => void;
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  deferredByThread: Map<string, number> | undefined;
  /** GitHub PR items only: the git-state icon shown before the title. */
  prState?: PrGitState | undefined;
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

  // The most-recently-active routine on this item — `item.routines` is sorted
  // by jobName (not recency), so pick the max `lastAt`. This is the thread we
  // auto-select on expand so a single click both opens the item AND shows its
  // chat (skipping the otherwise-required second click into a routine row).
  const mostRecent = useMemo(
    () =>
      item.routines.reduce<ThreadRef | undefined>(
        (best, r) => (best && best.lastAt >= r.lastAt ? best : r),
        undefined,
      ),
    [item.routines],
  );

  // Opening an item auto-selects its most-recent routine's chat; collapsing
  // leaves the current selection untouched (don't yank the chat out from under
  // the user when they're just tidying the tree).
  const handleToggle = () => {
    if (!open && mostRecent) {
      onSelectThread(mostRecent.threadId);
    }
    onToggle();
  };

  // Right-side summary: total turns + total tokens across the PR's routines
  // (joined onto each ThreadRef in Sidebar). Falls back to the routine count
  // when neither is known yet (data still loading / no sessions).
  const totalTurns = item.routines.reduce((s, r) => s + (r.turnCount ?? 0), 0);
  const totalTokens = item.routines.reduce((s, r) => s + (r.tokens ?? 0), 0);

  // Every item is a disclosure — even a single-routine PR — so you can always
  // see WHICH routine (.md) handled it, not just the PR title.
  return (
    <Collapsible open={open}>
      <CollapsibleTrigger
        onClick={handleToggle}
        className="group flex w-full items-center gap-1.5 px-3 py-1 pl-7 text-left text-sm hover:bg-base-200/60"
      >
        <ChevronRight className="size-3 shrink-0 text-base-content/40 transition-transform group-data-[state=open]:rotate-90" />
        {item.num != null && <PrStateIcon state={prState} />}
        <span className="flex-1 truncate font-medium text-base-content/90" title={item.title}>
          {item.title}
        </span>
        {itemDeferredUntil > 0 && <QueuedBadge until={itemDeferredUntil} />}
        {!item.polledOnly && (
          <span className="flex shrink-0 items-center gap-2 font-mono text-[10px] tabular-nums text-base-content/40">
            {totalTurns > 0 && <span title={`${totalTurns} turns`}>{totalTurns}t</span>}
            {totalTokens > 0 && (
              <span title={`${totalTokens.toLocaleString()} tokens`} className="text-base-content/35">
                {fmtTokens(totalTokens)}
              </span>
            )}
            {totalTurns === 0 && totalTokens === 0 && <span>{item.routines.length}</span>}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {item.routines.length === 0 ? (
          <p className="py-1 pl-12 pr-2 font-mono text-[11px] italic text-base-content/35">
            no routine activity
          </p>
        ) : (
          item.routines.map((ref) => (
            <ThreadRow
              key={ref.threadId}
              label={ref.jobName}
              ref_={ref}
              active={activeThreadId === ref.threadId}
              onSelect={() => onSelectThread(ref.threadId)}
              indent="pl-12"
              deferredUntil={deferredByThread?.get(ref.threadId) ?? 0}
            />
          ))
        )}
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
