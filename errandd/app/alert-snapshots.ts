import { alertReportFromFields, type AlertReport } from "../shared/datadogAlerts";
import { readPath, readScalarPath } from "../shared/hookPayload";
import { datadogExtractFields } from "./hooks/evaluate";
import { extractHookScope } from "./hooks/match";
import type { Delivery } from "./hooks/deliveries";

/** Latest authenticated report, including recoveries that did not wake a routine. */
export function datadogAlertSnapshots(deliveries: Delivery[]): AlertReport[] {
  const reports = new Map<string, AlertReport>();
  for (const delivery of deliveries) {
    if (!delivery.event.startsWith("datadog:") || delivery.status !== "ok") continue;
    const scope = extractHookScope(delivery.event, delivery.payload);
    if (!scope) continue;
    const date = readScalarPath(delivery.payload, ["date"]);
    const numeric = date ? Number(date) : NaN;
    const parsed = Number.isFinite(numeric) ? numeric * (numeric < 1e12 ? 1000 : 1) : date ? Date.parse(date) : NaN;
    const reportedAt = Number.isFinite(parsed) && parsed > 0 && parsed <= delivery.receivedAt + 60_000 ? parsed : delivery.receivedAt;
    const fields = datadogExtractFields(delivery.event, delivery.payload);
    for (const label of ["transition", "status"]) {
      const value = readPath(delivery.payload, [label]);
      if (value) fields.push({ label, value });
    }
    const report = alertReportFromFields(scope, fields, reportedAt, "webhook", delivery.receivedAt);
    const old = reports.get(scope);
    if (!old || report.reportedAt > old.reportedAt || (report.reportedAt === old.reportedAt && report.receivedAt > old.receivedAt)) reports.set(scope, report);
  }
  return [...reports.values()].sort((a, b) => b.reportedAt - a.reportedAt || a.scope.localeCompare(b.scope));
}
