import { afterEach, expect, test } from "bun:test";
import { datadogAlertSnapshots } from "../alert-snapshots";
import { __resetDeliveryStoreForTests, recentDeliveries, type Delivery } from "../hooks/deliveries";
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
