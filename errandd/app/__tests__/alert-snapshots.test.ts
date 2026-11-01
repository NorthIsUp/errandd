import { alertsList, alertsEvents } from "../ui/routes/alerts";
import type { RouteCtx } from "../ui/routes/types";
import { alertSnapshotSchema } from "../../shared/datadogAlerts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadCache } from "../readCache";
import { afterEach, expect, test } from "bun:test";
import { DatadogAlertStore, getDatadogAlertStore, datadogAlertSnapshots, MAX_ALERT_REPORTS, ALERT_REPORT_RETENTION_MS } from "../alert-snapshots";
import { __resetDeliveryStoreForTests, recentDeliveries, recordDelivery, type Delivery } from "../hooks/deliveries";
import { handleDatadogWebhook } from "../hooks/datadog";
import { defaultDatadogRule } from "../hooks/schema";
import type { Job } from "../jobs";

afterEach(__resetDeliveryStoreForTests);
function delivery(type: string, date: number, receivedAt: number, status: Delivery["status"] = "ok"): Delivery {
  return { id: `${type}-${receivedAt}`, event: "datadog:alert", receivedAt, summary: "Datadog", status, matched: [], payloadSnippet: "",
    payload: { monitor_id: "77", title: `[${type}] [production][celery] Queue latency`, type, date, tags: "env:production,service:celery", priority: "P1" } };
}

test("source event time wins over delivery order and rejected or unknown reports cannot claim recovery", () => {
  const latest = delivery("recovery", 2_000_000_000, 2_000_000_010_000);
  const stale = delivery("error", 1_999_999_000, 2_000_000_020_000);
  const rejected = delivery("error", 2_000_000_030, 2_000_000_030_000, "bad-signature");
  for (const rows of [[latest, stale, rejected], [rejected, stale, latest]]) {
    expect(datadogAlertSnapshots(rows)).toMatchObject([{ state: "recovered", title: "Queue latency", service: "celery", reportedAt: 2_000_000_000_000 }]);
  }
  expect(datadogAlertSnapshots([{ ...latest, payload: undefined }])).toEqual([]);
});

test("authenticated recovery updates the monitor snapshot even when routine filters skip it", async () => {
  const job: Job = { name: "oncall", prompt: "Investigate", schedules: [], recurring: false, notify: "error", reuseSession: true,
    hookConfig: { pr: [], skipSelf: true, datadog: { ...defaultDatadogRule(), type: ["error"] } } };
  let fired = 0;
  const post = async (type: string) => {
    const payload = { monitor_id: "77", aggreg_key: "monitor-77", transition: type, type, priority: "P1", title: `[${type}] [production][celery] Queue latency` };
    const result = await handleDatadogWebhook(new Request("http://localhost/api/webhooks/datadog", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Errandd-Token": process.env.ERRANDD_DATADOG_WEBHOOK_SECRET ?? "" }, body: JSON.stringify(payload),
    }), { getJobs: async () => [job], onHookFire: () => { fired++; } });
    expect(result.status).toBe(200);
  };
  await post("error");
  await post("recovery");
  expect(fired).toBe(1);
  const snapshot = datadogAlertSnapshots(recentDeliveries());
  expect(snapshot).toHaveLength(1);
  expect(snapshot[0]?.state).toBe("recovered");
  expect(snapshot[0]?.scope).toBe("dd-monitor-77");
});

test("latest recovery survives delivery-ring eviction and reopening the durable cache", () => {
  const directory = mkdtempSync(join(tmpdir(), "alert-reports-"));
  const path = join(directory, "read-cache.sqlite");
  const now = 2_000_000_100_000;
  let cache = new ReadCache(path);
  try {
    const store = new DatadogAlertStore(cache, () => now);
    const recovery = delivery("recovery", 2_000_000_010, now);
    store.seed([delivery("error", 2_000_000_000, now - 1000), recovery]);
    // No ring records remain, but both snapshot consumers retain the recovery.
    store.seed([]);
    expect(store.snapshot()[0]?.state).toBe("recovered");
    cache.close();
    cache = new ReadCache(path);
    const restarted = new DatadogAlertStore(cache, () => now + 1000);
    restarted.seed([delivery("error", 2_000_000_000, now + 500)]);
    expect(restarted.snapshot()).toMatchObject([{ state: "recovered", reportedAt: 2_000_000_010_000 }]);
    let updates = 0;
    const unsubscribe = restarted.subscribe(() => { updates++; });
    restarted.observe("datadog:alert", delivery("error", 1_999_999_000, now + 800).payload, now + 800);
    expect(updates).toBe(0);
    restarted.observe("datadog:alert", delivery("error", 2_000_000_050, now + 900).payload, now + 900);
    expect(updates).toBe(1);
    expect(restarted.snapshot()[0]?.state).toBe("triggered");
    unsubscribe();
  } finally { cache.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("per-scope report retention is bounded and pruning drops expired evidence", () => {
  const cache = new ReadCache(":memory:");
  const now = 2_000_000_100_000;
  const store = new DatadogAlertStore(cache, () => now);
  try {
    const reports = Array.from({ length: MAX_ALERT_REPORTS + 2 }, (_, index) => ({
      ...delivery("recovery", 2_000_000_000, now - index), id: `${index}`,
      payload: { monitor_id: `${index}`, type: "recovery" },
    }));
    store.seed(reports);
    expect(store.snapshot()).toHaveLength(MAX_ALERT_REPORTS);
    const expired = new DatadogAlertStore(cache, () => now + ALERT_REPORT_RETENTION_MS + 1);
    expect(expired.snapshot()).toHaveLength(0);
  } finally { cache.close(); }
});


test("HTTP and SSE use the same durable report after actual ring eviction, then publish a fresh report", async () => {
  const now = Date.now();
  const recovered = delivery("recovery", now, now);
  recovered.id = "durable-route-recovery";
  recovered.payload = { monitor_id: "durable-route", type: "recovery", date: now, title: "[Recovered] Route fixture" };
  recordDelivery(recovered);
  const store = getDatadogAlertStore();
  store.seed(recentDeliveries());
  for (let index = 0; index <= 10_000; index++) recordDelivery({ id: `other-provider-${index}`, event: "pull_request", receivedAt: now + index, summary: "Fixture", status: "ok", matched: [], payloadSnippet: "" });
  expect(recentDeliveries().some(value => value.id === recovered.id)).toBe(false);
  const frames: unknown[] = [];
  let unsubscribe: (() => void) | undefined;
  const request = new Request("http://localhost/api/alerts");
  const context: RouteCtx = { req: request, url: new URL(request.url),
    opts: { host: "127.0.0.1", port: 0, token: "", getSnapshot: () => { throw Error("unused"); } },
    sseResponse: (_request, setup) => { unsubscribe = setup(value => frames.push(value)); return new Response("fixture"); } };
  const httpSnapshot = alertSnapshotSchema.parse(await (await alertsList(context))?.json());
  await alertsEvents(context);
  expect(alertSnapshotSchema.parse(frames[0])).toEqual(httpSnapshot);
  expect(httpSnapshot.alerts.find(report => report.scope === "dd-monitor-durable-route")?.state).toBe("recovered");
  try {
    store.observe("datadog:alert", { monitor_id: "durable-route", type: "error", title: "[Triggered] Route fixture" }, now + 20_000);
    expect(alertSnapshotSchema.parse(frames.at(-1)).alerts.find(report => report.scope === "dd-monitor-durable-route")?.state).toBe("triggered");
  } finally { unsubscribe?.(); }
});
