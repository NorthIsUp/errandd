import type { AlertReport, AlertState } from "../../../shared/datadogAlerts";
import type { TreeItem, TreeSection } from "./tree";

export type AlertFilter = "all" | "active" | "recovered" | "unknown";
export const ALERT_FILTERS: { value: AlertFilter; label: string }[] = [
  { value: "all", label: "All" }, { value: "active", label: "Active" },
  { value: "recovered", label: "Recovered" }, { value: "unknown", label: "Unknown" },
];
export function alertVisible(item: TreeItem, filter: AlertFilter): boolean {
  const state = item.alert?.state ?? "unknown";
  return filter === "all" || (filter === "active" ? ["triggered", "warning", "no-data"].includes(state) : state === filter);
}
export function mergeAlertReports(section: TreeSection, reports: AlertReport[]): TreeSection {
  const byScope = new Map(reports.map(report => [report.scope, report]));
  return { ...section, items: section.items.map(item => {
    const report = byScope.get(item.key);
    return report ? { ...item, title: report.title, alert: report, lastAt: report.reportedAt } : item;
  }) };
}
const rank: Record<AlertState, number> = { triggered: 0, warning: 1, "no-data": 2, unknown: 3, recovered: 4 };
export function compareAlerts(a: TreeItem, b: TreeItem): number {
  return rank[a.alert?.state ?? "unknown"] - rank[b.alert?.state ?? "unknown"] ||
    (b.alert?.reportedAt ?? b.lastAt) - (a.alert?.reportedAt ?? a.lastAt) || a.key.localeCompare(b.key);
}
