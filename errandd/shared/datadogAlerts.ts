import { z } from "zod";
import type { DeliveryField } from "./deliveryTypes";

export const alertReportSchema = z.object({
  scope: z.string(), monitor: z.string(), title: z.string(), originalTitle: z.string(),
  state: z.enum(["triggered", "warning", "recovered", "no-data", "unknown"]),
  priority: z.string(), context: z.array(z.string()), service: z.string(),
  reportedAt: z.number(), receivedAt: z.number(), origin: z.enum(["webhook", "queued"]),
});
export type AlertReport = z.infer<typeof alertReportSchema>;
export type AlertState = AlertReport["state"];
export const alertSnapshotSchema = z.object({ alerts: z.array(alertReportSchema) });

function reportState(value: string): AlertState {
  const normalized = value.toLowerCase().replace(/[ _-]/g, "");
  if (/^(recovered|recovery|ok|success|resolved)$/.test(normalized)) return "recovered";
  if (/^(triggered|alert|error|critical|retriggered|renotify)$/.test(normalized)) return "triggered";
  if (/^(warn|warning|warned)$/.test(normalized)) return "warning";
  if (/^(nodata|noresults)$/.test(normalized)) return "no-data";
  return "unknown";
}

/** Title prefixes are display context, never the monitor's identity. */
export function alertReportFromFields(scope: string, fields: DeliveryField[], reportedAt: number, origin: AlertReport["origin"], receivedAt = reportedAt): AlertReport {
  const read = (label: string) => fields.find(field => field.label === label)?.value ?? "";
  const originalTitle = read("title");
  let title = originalTitle;
  const prefixes: string[] = [];
  for (let index = 0; index < 8; index++) {
    const prefix = /^\s*\[([^\]]+)\]\s*/.exec(title);
    if (!prefix) break;
    prefixes.push(prefix[1] ?? "");
    title = title.slice(prefix[0].length);
  }
  const titleState = prefixes.map(prefix => reportState(prefix.replace(/\s+on\s+.*$/i, ""))).find(state => state !== "unknown") ?? "unknown";
  const state = [read("transition"), read("status"), read("type")].map(reportState).find(value => value !== "unknown") ?? titleState;
  const tags = read("tags").split(/[,\s]+/).filter(Boolean);
  const tagged = (name: string) => tags.find(tag => tag.startsWith(`${name}:`))?.slice(name.length + 1) ?? "";
  const workload = /kube_deployment:([^,}\]]+)/.exec(originalTitle)?.[1] ?? "";
  const context = [...new Set([
    ...prefixes.filter(prefix => reportState(prefix.replace(/\s+on\s+.*$/i, "")) === "unknown" && !prefix.includes("{") && !/^P[1-5]$/i.test(prefix)),
    tagged("env"), tagged("service"), tagged("kube_namespace"), tagged("kube_deployment") || workload,
  ].filter(Boolean))];
  const monitor = read("monitor");
  const service = tagged("service") || tagged("kube_deployment") || workload || context[1] || context[0] || "Other monitors";
  return { scope, monitor, title: title.trim() || `Monitor ${monitor || scope}`, originalTitle, state,
    priority: read("priority") || prefixes.find(prefix => /^P[1-5]$/i.test(prefix)) || "",
    context, service, reportedAt, receivedAt, origin };
}
