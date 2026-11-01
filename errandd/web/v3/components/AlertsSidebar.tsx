import { CircleCheck, CircleHelp, Siren, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { AlertState } from "../../../shared/datadogAlerts";
import { ALERT_FILTERS, alertVisible, type AlertFilter } from "../lib/alerts";
import type { TreeItem } from "../lib/tree";
import { SidebarSubjectContent } from "./SidebarSubjectContent";
import { cn } from "./ui/utils";

const STATES = {
  triggered: { label: "Triggered", Icon: Siren, className: "text-error" },
  warning: { label: "Warning", Icon: TriangleAlert, className: "text-warning" },
  recovered: { label: "Recovered", Icon: CircleCheck, className: "text-success" },
  "no-data": { label: "No data", Icon: CircleHelp, className: "text-warning" },
  unknown: { label: "Unknown", Icon: CircleHelp, className: "text-base-content/45" },
} satisfies Record<AlertState, { label: string; Icon: typeof Siren; className: string }>;

export function AlertItemContent({ item }: { item: TreeItem }) {
  const report = item.alert;
  const { label, Icon, className } = STATES[report?.state ?? "unknown"];
  const reported = report ? new Date(report.reportedAt).toLocaleString() : "unknown time";
  const origin = report?.origin === "webhook" ? "Last received monitor report" : "Last queued report; newer monitor changes may not have started a routine";
  const context = [...(report?.context ?? []), report?.monitor ? `#${report.monitor}` : "Datadog", ...(report?.origin === "queued" ? ["last queued report"] : [])].join(" · ");
  return <SidebarSubjectContent
    icon={<Icon size={14} className={cn("mt-0.5 shrink-0", className)} aria-hidden="true" />}
    title={report?.title || item.title} titleTooltip={report?.originalTitle || item.title}
    subtitle={context} subtitleTooltip={[...(report?.context ?? []), report?.monitor ? `Monitor ${report.monitor}` : ""].filter(Boolean).join(" · ")}
    trailing={<span className="flex shrink-0 flex-col items-end gap-0.5 text-[9px]" title={`${origin}: ${label} · ${reported}`}>
      <span className={className}>{label}</span>
      {report?.priority && <span className="font-mono text-base-content/40">{report.priority}</span>}
    </span>} />;
}

export function AlertFilterBar({ items, value, onChange }: { items: TreeItem[]; value: AlertFilter; onChange: (value: AlertFilter) => void }) {
  return <div className="flex flex-wrap gap-1 pl-9 pr-3 pb-2" role="group" aria-label="Alert status">
    {ALERT_FILTERS.map(filter => {
      const count = items.filter(item => alertVisible(item, filter.value)).length;
      return <button key={filter.value} type="button" aria-pressed={value === filter.value} onClick={() => onChange(filter.value)}
        className={cn("rounded px-1.5 py-0.5 text-[10px] transition-colors", value === filter.value ? "v3-selection" : "text-base-content/50 hover:bg-base-200")}>
        {filter.label} <span className="font-mono tabular-nums opacity-60">{count}</span>
      </button>;
    })}
  </div>;
}

export function AlertGroups({ items, renderItem }: { items: TreeItem[]; renderItem: (item: TreeItem) => ReactNode }) {
  const groups = new Map<string, TreeItem[]>();
  for (const item of items) {
    const service = item.alert?.service || "Other monitors";
    const group = groups.get(service) ?? [];
    group.push(item);
    groups.set(service, group);
  }
  return [...groups].map(([service, members]) => <div key={service}>
    {groups.size > 1 && <div className="flex items-center gap-2 pb-0.5 pt-2 pl-9 pr-3 text-[10px] text-base-content/45">
      <span className="min-w-0 flex-1 truncate font-mono" title={service}>{service}</span>
      <span className="font-mono tabular-nums">{members.length}</span>
    </div>}
    {members.map(renderItem)}
  </div>);
}
