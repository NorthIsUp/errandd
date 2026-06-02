import { describe, expect, test } from "bun:test";
import {
  attachDeliveryPayload,
  type Delivery,
  deliveryForWire,
  deliverySourceFromEvent,
  getDeliveryPayload,
  recentDeliveries,
  recordDelivery,
  setDeliveryEvaluation,
  subscribeDeliveries,
} from "../hooks/deliveries";
import { extractHookFields } from "../hooks/evaluate";
import {
  type DatadogPayload,
  datadogRuleSkipReason,
  type SentryPayload,
  sentryRuleSkipReason,
} from "../hooks/match";
import { handleWebhook } from "../hooks/receiver";
import { parseTriggers } from "../hooks/schema";
import type { Job } from "../jobs";

let seq = 0;
function uniqueId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

function baseDelivery(id: string, event: string, payload: unknown): Delivery {
  return {
    id,
    event,
    receivedAt: 1,
    summary: "",
    status: "ok",
    matched: [],
    payloadSnippet: "",
    payload,
  };
}

describe("deliverySourceFromEvent", () => {
  test("maps prefixes to providers", () => {
    expect(deliverySourceFromEvent("pull_request")).toBe("github");
    expect(deliverySourceFromEvent("issue_comment")).toBe("github");
    expect(deliverySourceFromEvent("sentry:issue")).toBe("sentry");
    expect(deliverySourceFromEvent("datadog:alert")).toBe("datadog");
  });
});

describe("extractHookFields", () => {
  test("github pull_request → repo, PR#, action, author, base", () => {
    const fields = extractHookFields("pull_request", {
      action: "opened",
      pull_request: { number: 42, user: { login: "alice" }, base: { ref: "main" }, draft: false },
      repository: { full_name: "org/app" },
    });
    const map = Object.fromEntries(fields.map((f) => [f.label, f.value]));
    expect(map).toMatchObject({
      repo: "org/app",
      PR: "#42",
      action: "opened",
      author: "alice",
      base: "main",
    });
  });

  test("github issue_comment → repo, PR#, actor, comment snippet", () => {
    const fields = extractHookFields("issue_comment", {
      action: "created",
      issue: { number: 7 },
      repository: { full_name: "org/app" },
      sender: { login: "graphite-app[bot]" },
      comment: { body: "please take a look" },
    });
    const map = Object.fromEntries(fields.map((f) => [f.label, f.value]));
    expect(map).toMatchObject({
      repo: "org/app",
      PR: "#7",
      actor: "graphite-app[bot]",
      comment: "please take a look",
    });
  });

  test("sentry → project, level, action", () => {
    const fields = extractHookFields("sentry:issue", {
      action: "created",
      data: { issue: { level: "error", title: "Boom", project: { slug: "clara-prod" } } },
    });
    const map = Object.fromEntries(fields.map((f) => [f.label, f.value]));
    expect(map).toMatchObject({
      project: "clara-prod",
      level: "error",
      action: "created",
      issue: "Boom",
    });
  });

  test("datadog → monitor, priority, type, tags", () => {
    const fields = extractHookFields("datadog:alert", {
      monitor_id: "789",
      priority: "P1",
      type: "error",
      tags: "service:api,env:prod",
    });
    const map = Object.fromEntries(fields.map((f) => [f.label, f.value]));
    expect(map).toMatchObject({
      monitor: "789",
      priority: "P1",
      type: "error",
      tags: "service:api, env:prod",
    });
  });
});

describe("skip reasons", () => {
  test("sentry project filter reason", () => {
    const p: SentryPayload = { project: "clara-staging", level: "error", action: "created" };
    const reason = sentryRuleSkipReason({ project: ["clara-prod"], level: [], action: [] }, p);
    expect(reason).toContain("clara-staging");
    expect(reason).toContain("project");
  });

  test("datadog required-tag reason", () => {
    const p: DatadogPayload = { monitor: "1", priority: "P3", type: "warning", tags: ["env:dev"] };
    const reason = datadogRuleSkipReason(
      { monitor: [], priority: [], type: [], tags: ["env:prod"] },
      p,
    );
    expect(reason).toContain("env:prod");
  });
});

describe("delivery store enrichment", () => {
  test("recordDelivery normalizes source/fields/routines", () => {
    const id = uniqueId("norm");
    recordDelivery(baseDelivery(id, "sentry:issue", { hello: 1 }));
    const found = getDeliveryPayload(id);
    expect(found).toEqual({ event: "sentry:issue", payload: { hello: 1 } });
  });

  test("deliveryForWire strips the full payload", () => {
    const wire = deliveryForWire(baseDelivery("w1", "pull_request", { big: "x" }));
    expect(wire.payload).toBeUndefined();
    expect(wire.id).toBe("w1");
  });

  test("setDeliveryEvaluation attaches fields + routines and notifies subscribers", () => {
    const id = uniqueId("eval");
    const seen: Delivery[] = [];
    const unsub = subscribeDeliveries((d) => {
      if (d.id === id) {
        seen.push(structuredClone(d));
      }
    });
    recordDelivery(baseDelivery(id, "pull_request", {}));
    setDeliveryEvaluation(id, {
      source: "github",
      fields: [{ label: "repo", value: "org/app" }],
      routines: [{ job: "pr-review", outcome: "trigger" }],
    });
    unsub();
    // at least the record + the evaluation emit
    expect(seen.length).toBeGreaterThanOrEqual(2);
    const last = seen.at(-1);
    expect(last?.fields).toEqual([{ label: "repo", value: "org/app" }]);
    expect(last?.routines).toEqual([{ job: "pr-review", outcome: "trigger" }]);
  });

  test("attach + getDeliveryPayload round-trips; unknown id → null", () => {
    const id = uniqueId("payload");
    recordDelivery({ ...baseDelivery(id, "pull_request", undefined), payload: undefined });
    expect(getDeliveryPayload(id)).toBeNull(); // no payload attached yet
    attachDeliveryPayload(id, { a: 1 });
    expect(getDeliveryPayload(id)).toEqual({ event: "pull_request", payload: { a: 1 } });
    expect(getDeliveryPayload("does-not-exist")).toBeNull();
  });
});

describe("handleWebhook enriches the ring delivery end-to-end", () => {
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
    } as Job;
  }

  test("a matching PR delivery records trigger routine + extracted fields + payload", async () => {
    const deliveryId = uniqueId("e2e-pr");
    const body = {
      action: "opened",
      pull_request: {
        number: 99,
        user: { login: "octocat" },
        base: { ref: "feature/x" },
        draft: false,
      },
      repository: { full_name: "org/app" },
      sender: { login: "octocat" }, // not the clawdcode self-login
    };
    const req = new Request("http://local/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": deliveryId,
      },
      body: JSON.stringify(body),
    });

    const noop = () => {
      /* outcome asserted via the ring, not the callbacks */
    };
    await handleWebhook(req, {
      getJobs: () => [makeJob("pr-review", [{ prs: true }])],
      onHookFire: noop,
      onHookSkip: noop,
    });

    expect(getDeliveryPayload(deliveryId)).not.toBeNull();
    const entry = recentDeliveries().find((d) => d.id === deliveryId);
    expect(entry?.source).toBe("github");
    expect(entry?.routines).toEqual([{ job: "pr-review", outcome: "trigger" }]);
    const map = Object.fromEntries((entry?.fields ?? []).map((f) => [f.label, f.value]));
    expect(map).toMatchObject({ repo: "org/app", PR: "#99", action: "opened", author: "octocat" });
  });
});
