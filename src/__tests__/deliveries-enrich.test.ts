import { describe, expect, test } from "bun:test";
import {
  __resetDeliveryStoreForTests,
  attachDeliveryPayload,
  type Delivery,
  deliveryForWire,
  deliverySourceFromEvent,
  getDeliveryPayload,
  initDeliveryStore,
  recentDeliveries,
  recordDelivery,
  setDeliveryEvaluation,
  subscribeDeliveries,
} from "../hooks/deliveries";
import { extractHookFields, extractHookKeys, extractHookPk } from "../hooks/evaluate";
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

  test("github PR surfaces a Linear task id from the head branch", () => {
    const fields = extractHookFields("pull_request", {
      action: "opened",
      pull_request: {
        number: 12,
        head: { ref: "adam/eng-123-fix-thing" },
        user: { login: "adam" },
      },
      repository: { full_name: "org/app" },
    });
    const map = Object.fromEntries(fields.map((f) => [f.label, f.value]));
    expect(map.linear).toBe("ENG-123");
    expect(map.PR).toBe("#12");
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

describe("extractHookPk", () => {
  test("github PR → #number", () => {
    expect(extractHookPk("pull_request", { pull_request: { number: 1542 }, repository: {} })).toBe(
      "#1542",
    );
  });
  test("github push (no PR) → branch from ref", () => {
    expect(extractHookPk("push", { ref: "refs/heads/feature/x" })).toBe("feature/x");
  });
  test("github comment → issue/PR number", () => {
    expect(extractHookPk("issue_comment", { issue: { number: 7 } })).toBe("#7");
  });
  test("sentry → issue id", () => {
    expect(extractHookPk("sentry:issue", { data: { issue: { id: "55" } } })).toBe("55");
  });
  test("datadog → monitor id (best-effort, TBD)", () => {
    expect(extractHookPk("datadog:alert", { monitor_id: "789" })).toBe("789");
  });
});

describe("extractHookKeys", () => {
  test("github PR → key1=action, key2=#pr", () => {
    const k = extractHookKeys("pull_request", {
      action: "synchronize",
      pull_request: { number: 88 },
    });
    expect(k).toMatchObject({
      key1Label: "action",
      key1: "synchronize",
      key2Label: "pr/branch",
      key2: "#88",
    });
  });
  test("github check_run → key2 = PR#, else branch, else short sha", () => {
    expect(
      extractHookKeys("check_run", {
        action: "completed",
        check_run: { head_sha: "abcdef1234567890", check_suite: { head_branch: "feature/y" } },
      }).key2,
    ).toBe("feature/y");
    expect(extractHookPk("check_run", { check_run: { head_sha: "abcdef1234567890" } })).toBe(
      "abcdef1",
    ); // no PR + no branch → short sha
    expect(extractHookPk("check_suite", { check_suite: { pull_requests: [{ number: 5 }] } })).toBe(
      "#5",
    );
  });
  test("check_run key fields include status/conclusion/sha", () => {
    const map = Object.fromEntries(
      extractHookFields("check_run", {
        check_run: {
          name: "build",
          status: "completed",
          conclusion: "failure",
          head_sha: "deadbeef00000000",
          check_suite: { head_branch: "main" },
        },
        repository: { full_name: "org/app" },
      }).map((f) => [f.label, f.value]),
    );
    expect(map).toMatchObject({
      check: "build",
      status: "completed",
      conclusion: "failure",
      sha: "deadbee",
      branch: "main",
    });
  });
  test("sentry → level + action; datadog → priority + type", () => {
    expect(
      extractHookKeys("sentry:issue", { action: "created", data: { issue: { level: "fatal" } } }),
    ).toMatchObject({
      key1: "fatal",
      key2: "created",
    });
    expect(extractHookKeys("datadog:alert", { priority: "P1", type: "error" })).toMatchObject({
      key1: "P1",
      key2: "error",
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

describe("durable delivery store (persist + hydrate across restart)", () => {
  test("init → record → reset (restart) → re-init hydrates the ring", () => {
    const tmp = `/tmp/clawd-deliveries-${seq++}.db`;
    initDeliveryStore(tmp);
    const id = uniqueId("dur");
    recordDelivery({ ...baseDelivery(id, "pull_request", { hi: 1 }), summary: "PR#7" });
    setDeliveryEvaluation(id, {
      source: "github",
      pk: "#7",
      fields: [{ label: "repo", value: "org/app" }],
    });
    // simulate the ~10min auto-update restart
    __resetDeliveryStoreForTests();
    expect(recentDeliveries().find((d) => d.id === id)).toBeUndefined(); // ring empty
    initDeliveryStore(tmp); // boot hydrate
    const back = recentDeliveries().find((d) => d.id === id);
    expect(back).toBeDefined();
    expect(back?.pk).toBe("#7");
    expect(back?.summary).toBe("PR#7");
    expect(getDeliveryPayload(id)).toEqual({ event: "pull_request", payload: { hi: 1 } });
    __resetDeliveryStoreForTests();
  });
});
