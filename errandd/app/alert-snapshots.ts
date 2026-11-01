import { alertReportFromFields, alertReportSchema, compareAlertReports, type AlertReport } from "../shared/datadogAlerts";
import { datadogExtractFields } from "./hooks/evaluate";
import { extractHookScope } from "./hooks/match";
import type { Delivery } from "./hooks/deliveries";
import { getReadCache, type ReadCache } from "./readCache";

const NAMESPACE = "datadog-alert-reports";
export const ALERT_REPORT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_ALERT_REPORTS = 5000;

function datadogAlertReport(event: string, payload: unknown, receivedAt: number): AlertReport | null {
  if (!event.startsWith("datadog:")) return null;
  const scope = extractHookScope(event, payload);
  if (!scope) return null;
  return alertReportFromFields(scope, datadogExtractFields(event, payload), receivedAt, "webhook", receivedAt);
}

/** Latest authenticated report, including recoveries that did not wake a routine. */
export function datadogAlertSnapshots(deliveries: Delivery[]): AlertReport[] {
  const reports = new Map<string, AlertReport>();
  for (const delivery of deliveries) {
    if (delivery.status !== "ok") continue;
    const report = datadogAlertReport(delivery.event, delivery.payload, delivery.receivedAt);
    if (!report) continue;
    const old = reports.get(report.scope);
    if (!old || compareAlertReports(report, old) > 0) reports.set(report.scope, report);
  }
  return [...reports.values()].sort((a, b) => b.reportedAt - a.reportedAt || a.scope.localeCompare(b.scope));
}

/** Per-scope observations survive delivery-ring eviction and daemon restarts. */
export class DatadogAlertStore {
  private readonly listeners = new Set<() => void>();
  constructor(private readonly cache: ReadCache, private readonly now: () => number = Date.now) {}

  private save(report: AlertReport): boolean {
    if (report.receivedAt < this.now() - ALERT_REPORT_RETENTION_MS) return false;
    const saved = this.cache.get<unknown>(NAMESPACE, report.scope)?.value;
    const old = alertReportSchema.safeParse(saved);
    if (old.success && compareAlertReports(report, old.data) <= 0) return false;
    this.cache.set(NAMESPACE, report.scope, report, report.receivedAt);
    return true;
  }
  private emit(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* An SSE consumer cannot break webhook intake. */ }
    }
  }
  observe(event: string, payload: unknown, receivedAt = this.now()): void {
    const report = datadogAlertReport(event, payload, receivedAt);
    if (!report || !this.save(report)) return;
    this.prune();
    this.emit();
  }
  seed(deliveries: Delivery[]): void {
    let changed = false;
    this.cache.db.transaction(() => {
      for (const report of datadogAlertSnapshots(deliveries)) changed = this.save(report) || changed;
      this.prune();
    }).immediate();
    if (changed) this.emit();
  }
  private prune(): void {
    const cutoff = this.now() - ALERT_REPORT_RETENTION_MS;
    const entries = this.cache.entries<unknown>(NAMESPACE).sort((a, b) => b[1].updatedAt - a[1].updatedAt || a[0].localeCompare(b[0]));
    for (const [index, [scope, saved]] of entries.entries()) {
      if (index >= MAX_ALERT_REPORTS || saved.updatedAt < cutoff || !alertReportSchema.safeParse(saved.value).success) this.cache.delete(NAMESPACE, scope);
    }
  }
  snapshot(): AlertReport[] {
    this.prune();
    return this.cache.entries<unknown>(NAMESPACE).flatMap(([, saved]) => {
      const parsed = alertReportSchema.safeParse(saved.value);
      return parsed.success ? [parsed.data] : [];
    }).sort((a, b) => b.reportedAt - a.reportedAt || a.scope.localeCompare(b.scope));
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

let store: DatadogAlertStore | undefined;
export function getDatadogAlertStore(): DatadogAlertStore {
  return store ??= new DatadogAlertStore(getReadCache());
}
