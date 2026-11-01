import { expect, test } from "bun:test";
import { alertReportFromFields } from "../../../../shared/datadogAlerts";
import { alertVisible, compareAlerts, mergeAlertReports } from "../alerts";
import { pageItems } from "../paging";
import { buildTree, type TreeItem } from "../tree";

const report = (scope: string, state: string, time: number) => alertReportFromFields(scope, [
  { label: "title", value: `[${state}] [production][celery] task queueing time` }, { label: "monitor", value: "77" }, { label: "type", value: state },
], time, "webhook");
const item = (scope: string, state: string, time: number): TreeItem => ({ key: scope, title: scope, lastAt: time, routines: [], alert: report(scope, state, time) });

test("monitor state and clean titles follow incoming report time, not longest title or agent completion", () => {
  const row = (id: string, enqueuedAt: number, updatedAt: number, title: string) => ({ id, enqueuedAt, updatedAt, threadId: "real:hook:dd-monitor-77", jobName: "oncall", event: "datadog:alert", scope: "dd-monitor-77", status: "done" as const, attempts: 0, notBefore: 0, prRepo: null, prNumber: null, error: null, fields: [{ label: "title", value: title }] });
  const old = row("old", 1000, 9000, "[Triggered] [production][celery] This old monitor title is significantly longer");
  const recovered = row("new", 2000, 2000, "[Recovered] Queue time");
  for (const rows of [[old, recovered], [recovered, old]]) {
    const result = buildTree(rows).find(section => section.source === "datadog")!.items[0]!;
    expect(result.alert).toMatchObject({ title: "Queue time", state: "recovered", reportedAt: 2000, origin: "queued" });
    expect(result.routines[0]?.threadId).toBe("real:hook:dd-monitor-77");
  }
});

test("filtered recovery snapshots update the same real chat, preserve routine state and do not fabricate chats", () => {
  const queued = item("scope", "error", 1000);
  queued.routines = [{ threadId: "real-chat", jobName: "oncall", status: "running", outcome: null, lastAt: 9999 }];
  const merged = mergeAlertReports({ source: "datadog", label: "Alerts", items: [queued] }, [report("scope", "recovery", 2000), report("not-queued", "error", 3000)]);
  expect(merged.items).toHaveLength(1);
  expect(merged.items[0]?.alert?.state).toBe("recovered");
  expect(merged.items[0]?.routines).toBe(queued.routines);
  expect(merged.items[0]?.lastAt).toBe(2000);
  expect(queued.alert?.state).toBe("triggered");
});

test("active monitors precede recent recoveries before count paging and status counts reflect report state", () => {
  const rows = [item("recovery", "recovery", 3000), item("warning", "warning", 2000), item("triggered", "error", 1000)];
  expect(pageItems(rows, "count", 1, 0, 4000, compareAlerts).items[0]?.key).toBe("triggered");
  expect(rows.filter(value => alertVisible(value, "active"))).toHaveLength(2);
  expect(rows.filter(value => alertVisible(value, "recovered"))).toHaveLength(1);
  expect(alertVisible({ key: "unknown", title: "unknown", routines: [], lastAt: 1 }, "unknown")).toBe(true);
});

test("Datadog group prefixes become workload context without leaking raw tag syntax into the title", () => {
  const parsed = alertReportFromFields("dd-123", [{ label: "title", value: "[Recovered on {kube_deployment:openclaw,kube_namespace:openclaw}] Deployment unavailable" }], 1000, "queued");
  expect(parsed).toMatchObject({ title: "Deployment unavailable", state: "recovered", service: "openclaw", context: ["openclaw"] });
});
