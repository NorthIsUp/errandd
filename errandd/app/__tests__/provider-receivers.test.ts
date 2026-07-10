import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Job } from "../jobs";
import { handleDatadogWebhook } from "../hooks/datadog";
import {
  __resetDeliveryStoreForTests,
  type DeliveryRoutine,
  recentDeliveries,
} from "../hooks/deliveries";
import { handleLinearWebhook } from "../hooks/linear";
import { parseTriggers } from "../hooks/schema";

// End-to-end coverage for the datadog + linear receivers after they were
// migrated onto the shared `handleSignedWebhook` envelope. Asserts the
// status/matched/duplicate/skip + evaluation behavior is unchanged.

let seq = 0;
afterEach(() => __resetDeliveryStoreForTests());

function makeJob(name: string, on: unknown[]): Job {
  const { schedules, hookConfig } = parseTriggers(on, undefined);
  return {
    name,
    schedules,
    prompt: "x",
    recurring: false,
    notify: true,
    reuseSession: false,
    ...(hookConfig ? { hookConfig } : {}),
  };
}

function routinesFor(event: string): DeliveryRoutine[] {
  return recentDeliveries().find((d) => d.event === event)?.routines ?? [];
}

// ---------------------------------------------------------------------------
// Datadog
// ---------------------------------------------------------------------------

const DD_P1 = {
  id: "evt-1",
  monitor_id: "789",
  title: "High API latency",
  message: "p99 > 2s",
  type: "error",
  priority: "P1",
  transition: "Triggered",
  aggreg_key: "cycle-abc",
  tags: "service:api,env:prod",
};

function ddReq(body: unknown, headers: Record<string, string> = {}, query = ""): Request {
  return new Request(`http://local/api/webhooks/datadog${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("handleDatadogWebhook (envelope)", () => {
  const prev = process.env.ERRANDD_DATADOG_WEBHOOK_SECRET;
  afterEach(() => {
    if (prev === undefined) {
      delete process.env.ERRANDD_DATADOG_WEBHOOK_SECRET;
    } else {
      process.env.ERRANDD_DATADOG_WEBHOOK_SECRET = prev;
    }
  });

  test("a P1 alert matches a `datadog: true` job → 200 matched + trigger routine", async () => {
    delete process.env.ERRANDD_DATADOG_WEBHOOK_SECRET;
    const fires: string[] = [];
    const res = await handleDatadogWebhook(ddReq({ ...DD_P1, aggreg_key: `e2e-${seq++}` }), {
      getJobs: () => [makeJob("dd", [{ datadog: true }])],
      onHookFire: (job) => {
        fires.push(job);
      },
    });
    expect(res).toEqual({ status: 200, body: { ok: true, matched: ["dd"] } });
    expect(fires).toEqual(["dd"]);
    const r = routinesFor("datadog:alert");
    expect(r).toContainEqual({ job: "dd", outcome: "trigger" });
    expect(recentDeliveries().find((d) => d.event === "datadog:alert")?.source).toBe("datadog");
  });

  test("a normal-priority alert is skipped with a reason (priority floor)", async () => {
    delete process.env.ERRANDD_DATADOG_WEBHOOK_SECRET;
    const res = await handleDatadogWebhook(
      ddReq({ ...DD_P1, priority: "normal", aggreg_key: `e2e-${seq++}` }),
      { getJobs: () => [makeJob("dd", [{ datadog: true }])], onHookFire: () => {} },
    );
    expect(res).toEqual({ status: 200, body: { ok: true } });
    const skip = routinesFor("datadog:alert").find((x) => x.job === "dd");
    expect(skip?.outcome).toBe("skip");
    expect(skip?.reason).toContain("priority");
  });

  test("token auth: bad token → 401 'bad token'; correct ?token= → 200", async () => {
    process.env.ERRANDD_DATADOG_WEBHOOK_SECRET = "TOK";
    const bad = await handleDatadogWebhook(
      ddReq({ ...DD_P1, aggreg_key: `e2e-${seq++}` }, { "x-errandd-token": "nope" }),
      {},
    );
    expect(bad).toEqual({ status: 401, body: { ok: false, error: "bad token" } });

    const ok = await handleDatadogWebhook(
      ddReq({ ...DD_P1, aggreg_key: `e2e-${seq++}` }, {}, "?token=TOK"),
      { getJobs: () => [makeJob("dd", [{ datadog: true }])], onHookFire: () => {} },
    );
    expect(ok.status).toBe(200);
  });

  test("duplicate delivery id → duplicate:true", async () => {
    delete process.env.ERRANDD_DATADOG_WEBHOOK_SECRET;
    const body = { ...DD_P1, aggreg_key: `dup-${seq++}` };
    const first = await handleDatadogWebhook(ddReq(body), {});
    expect(first.status).toBe(200);
    const second = await handleDatadogWebhook(ddReq(body), {});
    expect(second).toEqual({ status: 200, body: { ok: true, duplicate: true } });
  });
});

// ---------------------------------------------------------------------------
// Linear
// ---------------------------------------------------------------------------

const LIN_ISSUE = (text: string) => ({
  type: "Issue",
  action: "create",
  data: { identifier: "CLA-1200", title: "x", team: { key: "CLA" }, description: text },
});

function linReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://local/api/webhooks/linear", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-delivery": `lin-${process.pid}-${seq++}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("handleLinearWebhook (envelope)", () => {
  const prevSecret = process.env.ERRANDD_LINEAR_WEBHOOK_SECRET;
  const prevMention = process.env.ERRANDD_LINEAR_BOT_MENTION;
  beforeEach(() => {
    delete process.env.ERRANDD_LINEAR_WEBHOOK_SECRET;
    process.env.ERRANDD_LINEAR_BOT_MENTION = "@errandd";
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.ERRANDD_LINEAR_WEBHOOK_SECRET;
    else process.env.ERRANDD_LINEAR_WEBHOOK_SECRET = prevSecret;
    if (prevMention === undefined) delete process.env.ERRANDD_LINEAR_BOT_MENTION;
    else process.env.ERRANDD_LINEAR_BOT_MENTION = prevMention;
  });

  test("an @mentioned issue matches `linear: true` → 200 matched, pk = identifier", async () => {
    const fires: string[] = [];
    const res = await handleLinearWebhook(linReq(LIN_ISSUE("hey @errandd please look")), {
      getJobs: () => [makeJob("lin", [{ linear: true }])],
      onHookFire: (job) => {
        fires.push(job);
      },
    });
    expect(res).toEqual({ status: 200, body: { ok: true, matched: ["lin"] } });
    expect(fires).toEqual(["lin"]);
    const d = recentDeliveries().find((x) => x.event === "linear:issue.create");
    expect(d?.source).toBe("linear");
    expect(d?.pk).toBe("CLA-1200");
    expect(d?.routines).toContainEqual({ job: "lin", outcome: "trigger" });
  });

  test("an un-mentioned issue is skipped with the @mention reason", async () => {
    const res = await handleLinearWebhook(linReq(LIN_ISSUE("no mention here")), {
      getJobs: () => [makeJob("lin", [{ linear: true }])],
      onHookFire: () => {},
    });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    const skip = routinesFor("linear:issue.create").find((x) => x.job === "lin");
    expect(skip?.outcome).toBe("skip");
    expect(skip?.reason).toContain("@mention");
  });

  test("bad HMAC signature (secret set) → 401 + recorded attempt", async () => {
    process.env.ERRANDD_LINEAR_WEBHOOK_SECRET = "S";
    const res = await handleLinearWebhook(
      linReq(LIN_ISSUE("hey @errandd"), { "linear-signature": "bad" }),
      {},
    );
    expect(res).toEqual({ status: 401, body: { ok: false, error: "bad signature" } });
    expect(recentDeliveries().some((d) => d.status === "bad-signature")).toBe(true);
  });

  test("a correct HMAC signature (secret set) is accepted", async () => {
    process.env.ERRANDD_LINEAR_WEBHOOK_SECRET = "S";
    const body = JSON.stringify(LIN_ISSUE("hey @errandd"));
    const sig = createHmac("sha256", "S").update(body, "utf8").digest("hex");
    const req = new Request("http://local/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-delivery": `lin-ok-${seq++}`,
        "linear-signature": sig,
      },
      body,
    });
    const res = await handleLinearWebhook(req, {
      getJobs: () => [makeJob("lin", [{ linear: true }])],
      onHookFire: () => {},
    });
    expect(res).toEqual({ status: 200, body: { ok: true, matched: ["lin"] } });
  });
});
