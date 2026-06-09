import { Bug, CalendarClock, ChevronRight, Clock, GitPullRequest, Siren, Ticket } from "lucide-react";
import type { ComponentType } from "react";
import { fmtLocalHM } from "../lib/queuedUntil";
import type { ThreadRef, TreeItem, TreeSection, TreeSource } from "../lib/tree";
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

export type SectionTreeProps = {
  sections: TreeSection[];
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  /** Per-section collapse: `collapsed[source] === true` ⇒ section closed. */
  collapsed: Record<string, boolean>;
  onToggleSection: (source: TreeSource) => void;
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
  collapsed,
  onToggleSection,
  sortMode,
  onSortChange,
  deferredByThread,
}: SectionTreeProps) {
  return (
    <div className="flex flex-col">
      {sections.map((section) => (
        <SectionBlock
          key={section.source}
          section={section}
          open={!collapsed[section.source]}
          onToggle={() => onToggleSection(section.source)}
          activeThreadId={activeThreadId}
          onSelectThread={onSelectThread}
          sortMode={sortMode}
          onSortChange={onSortChange}
          deferredByThread={deferredByThread}
        />
      ))}
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

function SectionBlock({
  section,
  open,
  onToggle,
  activeThreadId,
  onSelectThread,
  sortMode,
  onSortChange,
  deferredByThread,
}: {
  section: TreeSection;
  open: boolean;
  onToggle: () => void;
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  sortMode: SortMode;
  onSortChange: (mode: SortMode) => void;
  deferredByThread: Map<string, number> | undefined;
}) {
  const Icon = SECTION_ICON[section.source];
  const count = section.items.length;
  const isGithub = section.source === "github";
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
        {count > 0 && (
          <span className="font-mono text-[10px] font-normal text-base-content/40">{count}</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-1">
        {count === 0 ? (
          <p className="px-3 pb-2 pl-9 text-xs text-base-content/35">No activity yet.</p>
        ) : isGithub ? (
          <>
            <SortBar mode={sortMode} onChange={onSortChange} />
            {groupByRepo(section.items).map((g) => (
              <RepoGroup
                key={g.repo}
                repo={g.repo}
                items={sortItems(g.items, sortMode)}
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
  activeThreadId,
  onSelectThread,
  deferredByThread,
}: {
  repo: string;
  items: TreeItem[];
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  deferredByThread: Map<string, number> | undefined;
}) {
  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 px-3 py-1 pl-7 text-left hover:bg-base-200/50">
        <ChevronRight className="size-3 shrink-0 text-base-content/40 transition-transform group-data-[state=open]:rotate-90" />
        <span className="flex-1 truncate font-mono text-[11px] text-base-content/55" title={repo}>
          {repo}
        </span>
        <span className="font-mono text-[10px] text-base-content/35">{items.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {items.map((item) => (
          <ItemBlock
            key={item.key}
            item={item}
            activeThreadId={activeThreadId}
            onSelectThread={onSelectThread}
            deferredByThread={deferredByThread}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ItemBlock({
  item,
  activeThreadId,
  onSelectThread,
  deferredByThread,
}: {
  item: TreeItem;
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
    <Collapsible defaultOpen>
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 px-3 py-1 pl-7 text-left text-sm hover:bg-base-200/60">
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
  // Bioluminescent status language (spec §14): coral breathing = live/running,
  // teal = resolved, amber = queued, red = failed/error, faint = pass/no-op.
  if (status === "running") {
    return <StatusDot tone="primary" label="running" pulse title="agent is running" />;
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
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
  faint: "bg-base-content/40",
};
const TONE_TEXT: Record<string, string> = {
  primary: "text-primary",
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
