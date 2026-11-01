import { afterEach, beforeEach, expect, test } from "bun:test";
import { ReadCache } from "../readCache";
import { SentryPoller, getSentryPollStatus } from "../sentry-poller";
import { handleSentryWebhook } from "../hooks/sentry";
import { defaultSentryRule } from "../hooks/schema";
import type { Job } from "../jobs";
import type { WebhookDeps } from "../hooks/receiver";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSentrySeenStore, __resetSentrySeenStoreForTests } from "../hooks/sentrySeen";
const job = (overrides = {}): Job => ({ name: "sentry-triage", prompt: "Triage", schedules: [], recurring: false, reuseSession: true, notify: "error", hookConfig: { pr: [], skipSelf: true, sentry: defaultSentryRule() }, ...overrides });
const issue = (id = "1") => ({ id, shortId: `APP-${id}`, title: "Example issue", level: "error", status: "unresolved", firstSeen: "2026-10-01T00:00:00Z", lastSeen: "2026-11-01T00:00:00Z", permalink: `https://sentry.io/issues/${id}/`, project: { slug: "backend" } });
const original = { token: process.env.SENTRY_AUTH_TOKEN, access: process.env.SENTRY_ACCESS_TOKEN, org: process.env.SENTRY_ORG };
const stores: ReadCache[] = [];
let directory = "";
beforeEach(() => { process.env.SENTRY_AUTH_TOKEN = "test-server-only-token"; process.env.SENTRY_ORG = "example"; directory = mkdtempSync(join(tmpdir(), "sentry-poller-")); initSentrySeenStore(join(directory, "seen.sqlite")); });
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  __resetSentrySeenStoreForTests(); rmSync(directory, { recursive: true, force: true });
  for (const [key, value] of [["SENTRY_AUTH_TOKEN", original.token], ["SENTRY_ACCESS_TOKEN", original.access], ["SENTRY_ORG", original.org]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; }
});
const memory = () => { const store = new ReadCache(":memory:"); stores.push(store); return store; };
const fetcher = (fn: (url: URL, init?: RequestInit) => Response | Promise<Response>) => ((input: string | URL | Request, init?: RequestInit) => fn(new URL(input instanceof Request ? input.url : input), init)) as typeof fetch;

test("missing credentials, disabled jobs and stopped poller make no API requests", async () => {
  let calls = 0;
  const fetch = fetcher(() => { calls++; return Response.json([]); });
  const store = memory();
  const disabled = new SentryPoller({ getJobs: () => [job({ enabled: false })], onHookFire: () => {} }, store, fetch);
  await disabled.tick(1); expect(calls).toBe(0);
  const poller = new SentryPoller({ getJobs: () => [job()], onHookFire: () => {} }, store, fetch);
  delete process.env.SENTRY_AUTH_TOKEN; delete process.env.SENTRY_ACCESS_TOKEN;
  await poller.tick(2); expect(calls).toBe(0);
  process.env.SENTRY_AUTH_TOKEN = "test"; poller.stop(); await poller.tick(3); expect(calls).toBe(0);
});

test("existing production issues enter real hooks once, preserve filters and omit event-user data", async () => {
  const store = memory();
  const fired: unknown[] = [];
  const ids: string[] = [];
  const fetch = fetcher((url, init) => {
    expect(url.origin).toBe("https://sentry.io");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-server-only-token");
    expect(init?.redirect).toBe("error");
    if (url.pathname.endsWith("/issues/")) return Response.json([issue("1"), issue("2")]);
    return Response.json({ tags: [{ key: "environment", value: url.pathname.includes("/1/") ? "production" : "staging" }], user: { email: "must-not-persist@example.com" }, entries: [{ private: "stack" }] });
  });
  const poller = new SentryPoller({ getJobs: () => [job()], onHookFire: (_job, event, id, payload) => { expect(event).toBe("sentry:issue"); ids.push(id); fired.push(payload); } }, store, fetch);
  await poller.tick(1);
  expect(fired).toHaveLength(1);
  expect(JSON.stringify(fired)).toContain("production");
  expect(JSON.stringify(fired)).not.toContain("must-not-persist");
  await poller.tick(300_002);
  expect(fired).toHaveLength(1);
  expect(new Set(ids).size).toBe(1);
  expect(getSentryPollStatus(store)?.error).toBeUndefined();
});

test("bounded pagination advances fairly and never forwards authorization to a supplied foreign origin", async () => {
  const store = memory();
  const cursors: (string | null)[] = [];
  const fetch = fetcher(url => {
    if (!url.pathname.endsWith("/issues/")) return Response.json({ tags: [{ key: "environment", value: "production" }] });
    expect(url.searchParams.get("limit")).toBe("10"); cursors.push(url.searchParams.get("cursor"));
    return Response.json([], { headers: cursors.length === 1 ? { Link: '<https://sentry.io/api/0/organizations/example/issues/?cursor=page2>; rel="next"; results="true"' } : {} });
  });
  const poller = new SentryPoller({ getJobs: () => [job()], onHookFire: () => {} }, store, fetch);
  await poller.tick(1); await poller.tick(30_002); expect(cursors).toEqual([null, "page2"]);
  const foreign = new SentryPoller({ getJobs: () => [job()], onHookFire: () => {} }, memory(), fetcher(() => Response.json([], { headers: { Link: '<https://attacker.example/issues/?cursor=x>; rel="next"; results="true"' } })));
  await foreign.tick(1); expect(getSentryPollStatus(stores.at(-1))?.error).toContain("origin");
});

test("queue failure retains cursor and first-seen eligibility; retry preserves debounce and fanout", async () => {
  const store = memory(); let fail = true;
  const queued: { job: string; id: string; notBefore?: number }[] = [];
  const fetch = fetcher(url => Response.json(url.pathname.endsWith("/issues/") ? [issue()] : { tags: [{ key: "environment", value: "production" }] }));
  const firstSeen = { ...defaultSentryRule(), firstSeen: true, debounceMs: 2000 };
  const jobs = [job({ name: "triage-a", hookConfig: { pr: [], skipSelf: true, sentry: firstSeen } }), job({ name: "triage-b", hookConfig: { pr: [], skipSelf: true, sentry: firstSeen } })];
  const fire: NonNullable<WebhookDeps["onHookFire"]> = (job, _event, id, _payload, options) => { if (fail) throw Error("queue offline"); queued.push({ job, id, notBefore: options?.notBefore }); };
  const poller = new SentryPoller({ getJobs: () => jobs, onHookFire: fire }, store, fetch);
  await poller.tick(1); expect(getSentryPollStatus(store)?.error).toBe("queue offline");
  fail = false; await poller.tick(300_002);
  expect(queued.map(item => item.job)).toEqual(["triage-a", "triage-b"]);
  expect(new Set(queued.map(item => item.id)).size).toBe(2);
  expect(queued.every(item => item.notBefore && item.notBefore > Date.now())).toBe(true);
  expect(getSentryPollStatus(store)?.error).toBeUndefined();
});

test("transient API failure retries the same cursor rather than dropping work", async () => {
  const store = memory(); let fail = true; const cursors: (string | null)[] = [];
  store.set("sentry-poller", "status", { organization: "example", cursor: "retry-me" });
  const poller = new SentryPoller({ getJobs: () => [job()], onHookFire: () => {} }, store, fetcher(url => { cursors.push(url.searchParams.get("cursor")); return fail ? new Response("unavailable", { status: 503 }) : Response.json([]); }));
  await poller.tick(1); expect(getSentryPollStatus(store)?.cursor).toBe("retry-me");
  fail = false; await poller.tick(300_002); expect(cursors).toEqual(["retry-me", "retry-me"]);
});


test("API-only production ingestion rejects unsigned public webhooks without enqueuing", async () => {
  const nodeEnv = process.env.NODE_ENV;
  const secret = process.env.ERRANDD_SENTRY_CLIENT_SECRET;
  process.env.NODE_ENV = "production";
  delete process.env.ERRANDD_SENTRY_CLIENT_SECRET;
  let fired = 0;
  try {
    const response = await handleSentryWebhook(new Request("https://example.com/api/webhooks/sentry", {
      method: "POST", headers: { "content-type": "application/json", "sentry-hook-resource": "issue" },
      body: JSON.stringify({ action: "created", data: { issue: issue(), environment: "production" } }),
    }), { getJobs: () => [job()], onHookFire: () => { fired++; } });
    expect(response.status).toBe(503);
    expect(fired).toBe(0);
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
    if (secret === undefined) delete process.env.ERRANDD_SENTRY_CLIENT_SECRET; else process.env.ERRANDD_SENTRY_CLIENT_SECRET = secret;
  }
});


test("issues rejected by host or level are retried when matching context changes", async () => {
  for (const dimension of ["host", "level"] as const) {
    const store = memory(); let matching = false, fired = 0;
    const rule = { ...defaultSentryRule(), host: ["production-host"], level: ["error"] };
    const selected = job({ name: `triage-${dimension}`, hookConfig: { pr: [], skipSelf: true, sentry: rule } });
    const fetch = fetcher(url => url.pathname.endsWith("/issues/")
      ? Response.json([{ ...issue(dimension === "host" ? "31" : "32"), level: dimension === "level" && !matching ? "warning" : "error" }])
      : Response.json({ environment: "production", server_name: dimension === "host" && !matching ? "rejected-host" : "production-host" }));
    const poller = new SentryPoller({ getJobs: () => [selected], onHookFire: () => { fired++; } }, store, fetch);
    await poller.tick(1); expect(fired).toBe(0);
    matching = true;
    await poller.tick(300_002); expect(fired).toBe(1);
    await poller.tick(600_003); expect(fired).toBe(1);
  }
});
