import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as yaml } from "yaml";
import { CVE_JOB_TEMPLATE, defaultCveRule, parseCveRule, readCveAlert } from "../../shared/cve";
import { readFrontmatter, writeFrontmatter } from "../../web/ui/schedule";
import { parseTriggers } from "../hooks/schema";
import { cveRuleMatches, cveSource, dispatchCveAlert } from "../hooks/cve";
import { extractHookScope } from "../hooks/match";
import { handleSignedWebhook } from "../hooks/webhookEnvelope";
import { __resetDeliveryStoreForTests } from "../hooks/deliveries";
import { ReadCache } from "../readCache";
import type { Job } from "../jobs";
import { CvePoller } from "../cve-poller";

const record = (id = "CVE-2026-12345", date = "2026-10-24T01:00:00Z") => ({
  cveMetadata: { cveId: id, state: "PUBLISHED", dateUpdated: date },
  containers: {
    cna: {
      title: "Unsafe package",
      descriptions: [{ lang: "en", value: "A package vulnerability" }],
      affected: [
        {
          vendor: "Example",
          product: "server",
          packageURL: "pkg:npm/%40example/server@1.0.0",
          versions: [{ version: "1.0.0", status: "affected" }],
        },
      ],
      metrics: [{ cvssV3_1: { baseScore: 9.1, baseSeverity: "CRITICAL" } }],
      references: [{ url: "https://example.com/advisory" }],
    },
    adp: [
      {
        affected: [{ vendor: "Example", product: "helper", packageURL: "pkg:pypi/helper" }],
        references: [{ url: "https://example.com/second" }],
      },
    ],
  },
});
const feed = () => ({
  id: 123,
  project_slug: "backend",
  created_at: "2026-10-24",
  affected_products: { name: "server", vendor: { name: "Example" } },
  vulnerability: {
    id: "CVE-2026-54321",
    title: "Vulnerable server",
    description: "Description",
    cvss_score: "8.5",
    severity: "HIGH",
    last_modified: "2026-10-24",
    affected_products: [{ name: "helper", vendor: { name: "Example" } }],
    configurations: {
      nodes: [{ cpeMatch: [{ criteria: "cpe:2.3:a:example:server:*:*:*:*:*:node.js:*:*" }] }],
    },
  },
});
const job = (repositories = ["current"], name = "cve-review"): Job => ({
  name,
  schedules: [],
  prompt: "Assess",
  recurring: false,
  notify: "error",
  reuseSession: true,
  hookConfig: { pr: [], skipSelf: true, cve: { ...defaultCveRule(), repositories } },
});
const stores: ReadCache[] = [];
const memory = () => {
  const store = new ReadCache(":memory:");
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  __resetDeliveryStoreForTests();
});

describe("structured CVE alerts", () => {
  test("registry metadata classifies records without PURLs, while prose remains unclassified", () => {
    const input = record();
    const affected = [
      {
        vendor: "Example",
        product: "helper",
        packageName: "helper",
        collectionURL: "https://www.pypi.org",
        versions: [],
      },
    ];
    const alert = readCveAlert({
      ...input,
      containers: {
        cna: {
          ...input.containers.cna,
          affected,
          descriptions: [{ lang: "en", value: "JavaScript rust go java" }],
        },
      },
    })!;
    expect(alert.ecosystems).toEqual(["pypi"]);
    expect(alert.languages).toEqual(["python"]);
    const unknown = readCveAlert({
      ...input,
      containers: {
        cna: {
          ...input.containers.cna,
          affected: [],
          descriptions: [{ lang: "en", value: "JavaScript rust go java" }],
        },
      },
    })!;
    expect(unknown.languages).toEqual([]);
  });

  test("official CNA and ADP metadata supplies package ecosystems, languages and technologies", () => {
    const alert = readCveAlert(record())!;
    expect(alert.ecosystems).toEqual(["npm", "pypi"]);
    expect(alert.languages).toEqual(["javascript", "typescript", "python"]);
    expect(alert.technologies).toContain("@example/server");
    expect(alert.references).toHaveLength(2);
    expect(alert.severity).toBe("critical");
    expect(alert.products).toHaveLength(2);
  });
  test("CVEFeed product object and nested list, object configurations and scores normalize", () => {
    const alert = readCveAlert(feed())!;
    expect(alert.source).toBe("cvefeed");
    expect(alert.products).toHaveLength(2);
    expect(alert.score).toBe(8.5);
    expect(alert.technologies).toContain("node.js");
    expect(alert.languages).toEqual([]);
    expect(readCveAlert({ vulnerability: { id: "../../etc/passwd" } })).toBeNull();
  });
  test("filters combine fields, OR values, glob matches and deny exclusions", () => {
    const alert = readCveAlert(record())!;
    const rule = {
      ...defaultCveRule(),
      language: ["go", "typescript"],
      ecosystem: ["npm"],
      technology: ["*server"],
      vendor: ["example"],
      product: ["server"],
    };
    expect(cveRuleMatches(rule, alert)).toBe(true);
    expect(cveRuleMatches({ ...rule, language: ["!python", "typescript"] }, alert)).toBe(false);
    expect(cveRuleMatches({ ...rule, product: ["helper"], vendor: ["other"] }, alert)).toBe(false);
    expect(cveRuleMatches({ ...rule, repositories: [] }, alert)).toBe(false);
    expect(cveRuleMatches({ ...rule, severity: [] }, alert)).toBe(false);
    expect(cveRuleMatches({ ...rule, language: ["rust"] }, alert)).toBe(false);
  });
  test("unknown classification is explicit; rejected records and test deliveries never trigger", () => {
    const alert = readCveAlert(feed())!;
    const rule = { ...defaultCveRule(), language: ["rust"] };
    expect(cveRuleMatches(rule, alert)).toBe(true);
    expect(cveRuleMatches({ ...rule, includeUnclassified: false }, alert)).toBe(false);
    expect(cveRuleMatches(rule, { ...alert, rejected: true })).toBe(false);
    expect(cveRuleMatches(rule, { ...alert, test: true })).toBe(false);
    expect(
      readCveAlert({ ...feed(), created_at: undefined, unread: true, timestamp: "today" })?.test,
    ).toBe(true);
  });
  test("server and UI preserve all structured filters through YAML edits", () => {
    const rule = {
      ...defaultCveRule(),
      repositories: ["current", "NorthIsUp/errandd"],
      language: ["typescript", "!python"],
      technology: ["react*"],
      includeUnclassified: false,
    };
    const content = writeFrontmatter(CVE_JOB_TEMPLATE, {
      hookConfig: { pr: [], skipSelf: true, cve: rule },
    });
    const raw = yaml(content.split("---")[1]) as { on: unknown; enabled: boolean };
    expect(raw.enabled).toBe(false);
    expect(parseTriggers(raw.on, undefined).hookConfig?.cve).toEqual(rule);
    expect(readFrontmatter(content).hookConfig?.cve).toEqual(rule);
    expect(parseTriggers([{ cvefeed: true }], undefined).hookConfig?.cve).toEqual(defaultCveRule());
    expect(() => parseCveRule({ repositories: ["*"] })).toThrow();
    expect(() => parseCveRule({ poll: "true" })).toThrow();
    expect(() => parseCveRule({ language: [42] })).toThrow();
  });
});

describe("durable CVE dispatch", () => {
  test("webhook retries recover after an envelope was already recorded, without repeating successful targets", async () => {
    const spec = cveSource.webhookSpec();
    spec.auth = {
      kind: "token",
      required: true,
      headerOnly: true,
      header: "x-webhook-secret",
      secret: "whsec_test",
    };
    let fail = true;
    const fired: string[] = [];
    const selectedJob = job(["current", "example/backend"], `retry-${Date.now()}`);
    const deps = {
      getJobs: () => [selectedJob],
      onHookFire: (_j: string, _e: string, id: string, payload: unknown) => {
        if (fail && (payload as { targetRepository: string }).targetRepository !== "current")
          throw new Error("queue unavailable");
        fired.push(id);
      },
    };
    const request = () =>
      new Request("http://local/api/webhooks/cvefeed", {
        method: "POST",
        headers: { "content-type": "application/json", "x-webhook-secret": "whsec_test" },
        body: JSON.stringify(feed()),
      });
    await expect(handleSignedWebhook(request(), deps, spec)).rejects.toThrow("queue unavailable");
    expect(fired).toHaveLength(1);
    fail = false;
    expect((await handleSignedWebhook(request(), deps, spec)).status).toBe(200);
    expect(fired).toHaveLength(2);
    await handleSignedWebhook(request(), deps, spec);
    expect(fired).toHaveLength(2);
  });

  test("fans out distinct queue IDs, retries only failed targets and suppresses older updates", async () => {
    const store = memory();
    const calls: string[] = [];
    const alert = readCveAlert(record())!;
    const jobs = [job(["current", "NorthIsUp/errandd"]), job(["current"], "another")];
    let fail = true;
    const fire = async (_job: string, _event: string, id: string, payload: unknown) => {
      if (fail && (payload as { targetRepository: string }).targetRepository.includes("/"))
        throw new Error("disk unavailable");
      calls.push(id);
    };
    await expect(dispatchCveAlert(alert, jobs, fire, store)).rejects.toThrow("disk unavailable");
    expect(calls).toHaveLength(1);
    fail = false;
    await dispatchCveAlert(alert, jobs, fire, store);
    expect(calls).toHaveLength(3);
    expect(new Set(calls).size).toBe(3);
    await dispatchCveAlert(alert, jobs, fire, store);
    expect(calls).toHaveLength(3);
    await dispatchCveAlert(readCveAlert(record(alert.id, "2026-10-23"))!, jobs, fire, store);
    expect(calls).toHaveLength(3);
    await dispatchCveAlert(readCveAlert(record(alert.id, "2026-10-25"))!, jobs, fire, store);
    expect(calls).toHaveLength(6);
    expect(extractHookScope("cve:alert", { ...alert, targetRepository: "current" })).not.toBe(
      extractHookScope("cve:alert", { ...alert, targetRepository: "NorthIsUp/errandd" }),
    );
  });
  test("SQL receipts survive reopening while existing cached data remains intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "errandd-cve-upgrade-"));
    try {
      const path = join(dir, "read.db");
      let store = new ReadCache(path);
      store.set("existing-plugins", "example", { enabled: false, nested: [1, 2] });
      let count = 0;
      const fire = () => {
        count++;
      };
      await dispatchCveAlert(readCveAlert(record())!, [job()], fire, store);
      store.close();
      store = new ReadCache(path);
      try {
        expect(store.get("existing-plugins", "example")?.value).toEqual({
          enabled: false,
          nested: [1, 2],
        });
        await dispatchCveAlert(readCveAlert(record())!, [job()], fire, store);
        expect(count).toBe(1);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("CVEFeed requires its exact header secret, validates payloads, and recognizes test events", async () => {
    const spec = cveSource.webhookSpec();
    spec.auth = {
      kind: "token",
      required: true,
      headerOnly: true,
      header: "x-webhook-secret",
      secret: "whsec_test",
    };
    const req = (body: unknown, header = "whsec_test", suffix = "") =>
      new Request(`http://local/api/webhooks/cvefeed${suffix}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-webhook-secret": header },
        body: JSON.stringify(body),
      });
    const deps = {
      getJobs: () => [job()],
      onHookFire: () => {
        throw new Error("should not enqueue");
      },
    };
    expect((await handleSignedWebhook(req(feed(), ""), deps, spec)).status).toBe(401);
    expect(
      (await handleSignedWebhook(req(feed(), "", "?token=whsec_test"), deps, spec)).status,
    ).toBe(401);
    expect((await handleSignedWebhook(req({}), deps, spec)).status).toBe(400);
    expect(
      (
        await handleSignedWebhook(
          req({ ...feed(), created_at: undefined, timestamp: "now", unread: true }),
          deps,
          spec,
        )
      ).status,
    ).toBe(200);
    spec.auth.secret = "";
    expect((await handleSignedWebhook(req(feed()), deps, spec)).status).toBe(503);
  });
});

const BASE = "a".repeat(40),
  NEXT = "b".repeat(40),
  LAST = "c".repeat(40);
function fakeFeed(count = 1, failRecord?: { current: boolean }) {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.includes("/git/ref/")) return Response.json({ object: { sha: BASE } });
    if (url.includes(`/compare/${BASE}`))
      return Response.json({ status: "ahead", commits: [{ sha: NEXT }, { sha: LAST }] });
    if (url.includes("/compare/"))
      return Response.json(
        { status: "identical", commits: [] },
        { headers: { etag: '"unchanged"' } },
      );
    if (url.endsWith("delta.json"))
      return Response.json({
        new: url.includes(LAST)
          ? []
          : Array.from({ length: count }, (_, n) => ({ cveId: `CVE-2026-${12345 + n}` })),
        updated: [],
      });
    if (failRecord?.current && url.includes("12346.json")) throw new Error("network failed");
    const id = url.split("/").at(-1)!.replace(".json", "");
    return Response.json(record(id));
  }) as typeof fetch;
  return { calls, fetcher };
}
describe("official CVE polling", () => {
  test("disabled monitoring does no network work; first enable baselines without history", async () => {
    const mock = fakeFeed();
    let jobs: Job[] = [];
    const store = memory();
    const poller = new CvePoller(
      {
        getJobs: () => jobs,
        onHookFire: () => {
          throw new Error("historical flood");
        },
      },
      store,
      mock.fetcher,
    );
    await poller.poll();
    expect(mock.calls).toHaveLength(0);
    jobs = [job()];
    await poller.poll();
    expect(mock.calls).toHaveLength(1);
    expect(store.get("cve-monitor", "cursor")?.value).toEqual({ sha: BASE });
  });
  test("partial network failures resume pinned records and persist only after successful enqueue", async () => {
    const fail = { current: true };
    const mock = fakeFeed(3, fail);
    const store = memory();
    const fired: string[] = [];
    const deps = {
      getJobs: () => [job()],
      onHookFire: (_j: string, _e: string, id: string) => {
        fired.push(id);
      },
    };
    let poller = new CvePoller(deps, store, mock.fetcher);
    await poller.poll();
    await expect(poller.poll()).rejects.toThrow("network failed");
    expect(fired).toHaveLength(1);
    expect(store.get("cve-monitor", "cursor")?.value).toEqual({
      sha: BASE,
      partial: { sha: NEXT, index: 1 },
    });
    fail.current = false;
    poller = new CvePoller(deps, store, mock.fetcher);
    await poller.poll();
    expect(fired).toHaveLength(3);
    expect(
      mock.calls.some((url) => url.endsWith(`/${NEXT}/cves/2026/12xxx/CVE-2026-12345.json`)),
    ).toBe(true);
    await poller.poll();
    expect(fired).toHaveLength(3);
    expect(store.get("cve-monitor", "cursor")?.value).toEqual({ sha: LAST, etag: '"unchanged"' });
  });
  test("bounded batches resume without dropping records, and stopped pollers make no requests", async () => {
    const mock = fakeFeed(102);
    const store = memory();
    let fired = 0;
    const poller = new CvePoller(
      {
        getJobs: () => [job()],
        onHookFire: () => {
          fired++;
        },
      },
      store,
      mock.fetcher,
    );
    await poller.poll();
    await poller.poll();
    expect(fired).toBe(100);
    await poller.poll();
    expect(fired).toBe(102);
    const count = mock.calls.length;
    poller.stop();
    await poller.poll();
    expect(mock.calls).toHaveLength(count);
  });
  test("invalid feed paths and diverged history leave the last good cursor intact", async () => {
    const store = memory();
    store.set("cve-monitor", "cursor", { sha: BASE });
    const mock = (async () =>
      Response.json({ status: "diverged", commits: [] })) as unknown as typeof fetch;
    const poller = new CvePoller({ getJobs: () => [job()], onHookFire: () => {} }, store, mock);
    await expect(poller.poll()).rejects.toThrow("diverged");
    expect(store.get("cve-monitor", "cursor")?.value).toEqual({ sha: BASE });
  });
});
