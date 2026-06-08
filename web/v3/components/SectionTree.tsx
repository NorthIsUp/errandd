import { Bug, CalendarClock, ChevronRight, GitPullRequest, Siren, Ticket } from "lucide-react";
import type { ComponentType } from "react";
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

export type SectionTreeProps = {
  sections: TreeSection[];
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  /** Per-section collapse: `collapsed[source] === true` ⇒ section closed. */
  collapsed: Record<string, boolean>;
  onToggleSection: (source: TreeSource) => void;
};

export function SectionTree({
  sections,
  activeThreadId,
  onSelectThread,
  collapsed,
  onToggleSection,
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
        />
      ))}
    </div>
  );
}

function SectionBlock({
  section,
  open,
  onToggle,
  activeThreadId,
  onSelectThread,
}: {
  section: TreeSection;
  open: boolean;
  onToggle: () => void;
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
}) {
  const Icon = SECTION_ICON[section.source];
  const count = section.items.length;
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
        ) : (
          section.items.map((item) => (
            <ItemBlock
              key={item.key}
              item={item}
              activeThreadId={activeThreadId}
              onSelectThread={onSelectThread}
            />
          ))
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ItemBlock({
  item,
  activeThreadId,
  onSelectThread,
}: {
  item: TreeItem;
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
}) {
  // A single-routine item is shown flat (no nested disclosure): the item row
  // is itself the chat link. Multi-routine items expand to their threads.
  const single = item.routines.length === 1;
  if (single) {
    const ref = item.routines[0]!;
    return (
      <ThreadRow
        label={item.title}
        ref_={ref}
        active={activeThreadId === ref.threadId}
        onSelect={() => onSelectThread(ref.threadId)}
        indent="pl-9"
      />
    );
  }

  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 px-3 py-1 pl-7 text-left text-sm hover:bg-base-200/60">
        <ChevronRight className="size-3 shrink-0 text-base-content/40 transition-transform group-data-[state=open]:rotate-90" />
        <span className="flex-1 truncate font-medium text-base-content/90" title={item.title}>
          {item.title}
        </span>
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
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ThreadRow({
  label,
  ref_,
  active,
  onSelect,
  indent,
}: {
  label: string;
  ref_: ThreadRef;
  active: boolean;
  onSelect: () => void;
  indent: string;
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
      <ThreadBadge ref_={ref_} />
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
