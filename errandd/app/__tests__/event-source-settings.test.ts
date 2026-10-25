import { __resetDeliveryStoreForTests, recentDeliveries } from "../hooks/deliveries";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReadCache, getReadCache } from "../readCache";
import { defaultCveConnection, parseCveConnection } from "../../shared/eventSources";
import { getCveConnection, saveCveConnection } from "../eventSourceSettings";
import { readRssCveEntries, checkCveFeed } from "../cve-feed";
import { CvePoller } from "../cve-poller";
import { dispatchCveAlert, cveSource } from "../hooks/cve";
import { readCveAlert, defaultCveRule } from "../../shared/cve";
import type { Job } from "../jobs";

const stores: ReadCache[] = [];
const store = () => {
  const db = new ReadCache(":memory:");
  stores.push(db);
  return db;
};
afterEach(() => {
  __resetDeliveryStoreForTests();
  for (const db of stores.splice(0)) db.close();
  getReadCache().delete("event-source-settings", "cve");
});
const fixtureJob: Job = {
  name: "cve-test",
  schedules: [],
  prompt: "Assess",
  recurring: false,
  notify: "error",
  reuseSession: true,
  hookConfig: { pr: [], skipSelf: true, cve: defaultCveRule() },
};
const official = (id: string, date = "2026-10-25T00:00:00Z") => ({
  cveMetadata: { cveId: id, state: "PUBLISHED", dateUpdated: date },
  containers: {
    cna: {
      title: "Package advisory",
      descriptions: [{ lang: "en", value: "Official description" }],
      metrics: [{ cvssV3_1: { baseScore: 9.1, baseSeverity: "CRITICAL" } }],
      affected: [{ product: "package", vendor: "vendor" }],
    },
  },
});
const rss = (ids: string[]) =>
  `<rss version="2.0"><channel><title>Advisories</title><link>https://example.com</link><description>Feed</description>${ids.map((id) => `<item><title>${id} vulnerability</title><guid>${id}</guid><pubDate>Sun, 25 Oct 2026 00:00:00 GMT</pubDate></item>`).join("")}</channel></rss>`;
const fetchXml = (xml: string) => (async () => new Response(xml)) as unknown as typeof fetch;

test("connection defaults preserve both transports and validation rejects malformed settings", () => {
  expect(getCveConnection(store())).toEqual(defaultCveConnection());
  for (const bad of [
    { mode: "unknown" },
    { intervalMinutes: 0 },
    { intervalMinutes: 1.5 },
    { feedFormat: "unknown" },
    { feedFormat: "rss", feedUrl: "file:///etc/passwd" },
    { feedFormat: "rss", feedUrl: "https://secret@example.com/feed" },
  ])
    expect(() => parseCveConnection({ ...defaultCveConnection(), ...bad })).toThrow();
  expect(
    parseCveConnection({
      ...defaultCveConnection(),
      feedFormat: "rss",
      feedUrl: "https://example.com/feed",
    }).feedFormat,
  ).toBe("rss");
});

test("source settings survive restart without rewriting unrelated SQL data or adding schemas", () => {
  const dir = mkdtempSync(join(tmpdir(), "errandd-source-upgrade-"));
  let db = new ReadCache(join(dir, "state.db"));
  try {
    db.set("plugins", "existing", { enabled: false, version: "1.0" });
    db.set("cve-monitor", "cursor", {
      sha: "a".repeat(40),
      partial: { sha: "b".repeat(40), index: 7 },
    });
    const connection = { ...defaultCveConnection(), mode: "poll" as const, intervalMinutes: 15 };
    saveCveConnection(connection, db);
    db.close();
    db = new ReadCache(join(dir, "state.db"));
    expect(getCveConnection(db)).toEqual(connection);
    expect(db.get("plugins", "existing")?.value).toEqual({ enabled: false, version: "1.0" });
    expect(db.get("cve-monitor", "cursor")?.value).toEqual({
      sha: "a".repeat(40),
      partial: { sha: "b".repeat(40), index: 7 },
    });
    expect(db.db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RSS and Atom extract only CVE IDs; DTDs and unbounded bodies are rejected", async () => {
  expect(
    (await readRssCveEntries("https://example.com", fetchXml(rss(["CVE-2026-12345"])))).map(
      (entry) => entry.id,
    ),
  ).toEqual(["CVE-2026-12345"]);
  const atom =
    '<feed xmlns="http://www.w3.org/2005/Atom"><title>Feed</title><id>feed</id><updated>2026-10-25T00:00:00Z</updated><entry><id>CVE-2026-98765</id><title>Advisory</title><updated>2026-10-25T00:00:00Z</updated></entry></feed>';
  expect((await readRssCveEntries("https://example.com", fetchXml(atom)))[0]?.id).toBe(
    "CVE-2026-98765",
  );
  await expect(
    readRssCveEntries(
      "https://example.com",
      fetchXml('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>'),
    ),
  ).rejects.toThrow("DTDs");
  await expect(
    readRssCveEntries("https://example.com", fetchXml("x".repeat(2 * 1024 * 1024 + 1))),
  ).rejects.toThrow("2 MiB");
});

test("RSS baseline and retries use official structured records, preserve legacy opt-outs, and never follow entry links", async () => {
  const db = store();
  saveCveConnection(
    {
      ...defaultCveConnection(),
      mode: "poll",
      feedFormat: "rss",
      feedUrl: "https://example.com/feed.xml",
    },
    db,
  );
  let ids = ["CVE-2026-12345"],
    fail = false,
    fired = 0;
  const urls: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    if (url === "https://example.com/feed.xml") {
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      return new Response(rss(ids));
    }
    if (fail) throw new Error("temporary failure");
    return Response.json(official(url.split("/").at(-1)!.replace(".json", "")));
  }) as typeof fetch;
  const noPoll: Job = {
    ...fixtureJob,
    name: "no-poll",
    hookConfig: { ...fixtureJob.hookConfig!, cve: { ...defaultCveRule(), poll: false } },
  };
  let poller = new CvePoller(
    {
      getJobs: () => [fixtureJob, noPoll],
      onHookFire: () => {
        fired++;
      },
    },
    db,
    fetcher,
  );
  await poller.poll();
  expect(fired).toBe(0);
  ids = ["CVE-2026-12345", "CVE-2026-98765"];
  fail = true;
  await expect(poller.poll()).rejects.toThrow("temporary failure");
  expect(fired).toBe(0);
  fail = false;
  poller = new CvePoller(
    {
      getJobs: () => [fixtureJob, noPoll],
      onHookFire: () => {
        fired++;
      },
    },
    db,
    fetcher,
  );
  await poller.poll();
  expect(fired).toBe(1);
  await poller.poll();
  expect(fired).toBe(1);
  expect(
    recentDeliveries().some(
      (delivery) => delivery.event === "cve:alert" && delivery.matched.includes("cve-test"),
    ),
  ).toBe(true);
  expect(urls.some((url) => url.endsWith("/main/cves/2026/98xxx/CVE-2026-98765.json"))).toBe(true);
  expect(
    urls.every(
      (url) =>
        url === "https://example.com/feed.xml" ||
        url.startsWith("https://raw.githubusercontent.com/CVEProject/cvelistV5/"),
    ),
  ).toBe(true);
});

test("same CVE update from webhook and poll is deduplicated despite formatting differences", async () => {
  const db = store();
  let count = 0;
  const alert = readCveAlert(official("CVE-2026-55555"))!;
  await dispatchCveAlert(
    alert,
    [fixtureJob],
    () => {
      count++;
    },
    db,
  );
  await dispatchCveAlert(
    {
      ...alert,
      source: "cvefeed",
      updatedAt: "2026-10-25T00:00:00+00:00",
      title: "Different feed title",
      description: "Feed formatting",
    },
    [fixtureJob],
    () => {
      count++;
    },
    db,
  );
  expect(count).toBe(1);
});

test("polling schedule and webhook mode respect persisted connection controls", async () => {
  const db = store();
  let requests = 0;
  const fetcher = (async () => {
    requests++;
    return Response.json({ object: { sha: "a".repeat(40) } });
  }) as unknown as typeof fetch;
  saveCveConnection({ ...defaultCveConnection(), mode: "webhook" }, db);
  const poller = new CvePoller({ getJobs: () => [fixtureJob], onHookFire: () => {} }, db, fetcher);
  await poller.tick();
  expect(requests).toBe(0);
  saveCveConnection({ ...defaultCveConnection(), mode: "poll", intervalMinutes: 15 }, db);
  await poller.tick();
  expect(requests).toBe(1);
  await poller.tick();
  expect(requests).toBe(1);
  saveCveConnection({ ...defaultCveConnection(), mode: "poll" });
  const spec = cveSource.webhookSpec();
  expect(
    spec.preRecord?.({ id: "id", event: "cve:alert", summary: "" }, official("CVE-2026-55555")),
  ).toEqual({ status: 202, body: { ok: true } });
});

test("checking a feed does not create a cursor or queue historical remediation", async () => {
  const checked = await checkCveFeed(
    { ...defaultCveConnection(), feedFormat: "rss", feedUrl: "https://example.com/rss" },
    fetchXml(rss(["CVE-2026-55555"])),
  );
  expect(checked).toEqual({ format: "RSS / Atom", records: 1 });
});

test("source settings API exposes capabilities and connected errands without returning secrets", async () => {
  const { eventSourcesGet, eventSourcePut } = await import("../ui/routes/eventSources");
  const previous = process.env.ERRANDD_CVEFEED_WEBHOOK_SECRET;
  process.env.ERRANDD_CVEFEED_WEBHOOK_SECRET = "whsec_do_not_return_this";
  const request = new Request("http://local/api/settings/event-sources");
  const ctx = {
    req: request,
    url: new URL(request.url),
    opts: { getSnapshot: () => ({ jobs: [fixtureJob] }) },
  } as unknown as import("../ui/routes/types").RouteCtx;
  try {
    const response = await eventSourcesGet(ctx);
    if (!response) throw new Error("Missing response");
    const text = await response.text();
    expect(text).not.toContain("whsec_do_not_return_this");
    const data = JSON.parse(text) as {
      sources: { id: string; modes: string[]; errands: { name: string }[] }[];
    };
    expect(data.sources.find((source) => source.id === "cve")?.modes).toEqual([
      "webhook",
      "poll",
      "both",
    ]);
    expect(data.sources.find((source) => source.id === "cve")?.errands[0]?.name).toBe(
      fixtureJob.name,
    );
    expect(data.sources.find((source) => source.id === "github")?.modes).toEqual(["webhook"]);
    const bad = await eventSourcePut({
      ...ctx,
      req: new Request("http://local/api/settings/event-sources/cve", {
        method: "PUT",
        body: JSON.stringify({ ...defaultCveConnection(), intervalMinutes: 0 }),
      }),
    });
    expect(bad?.status).toBe(400);
    expect(getCveConnection()).toEqual(defaultCveConnection());
    const saved = await eventSourcePut({
      ...ctx,
      req: new Request("http://local/api/settings/event-sources/cve", {
        method: "PUT",
        body: JSON.stringify({ ...defaultCveConnection(), mode: "poll", intervalMinutes: 30 }),
      }),
    });
    expect(saved?.status).toBe(200);
    expect(getCveConnection().intervalMinutes).toBe(30);
  } finally {
    if (previous === undefined) delete process.env.ERRANDD_CVEFEED_WEBHOOK_SECRET;
    else process.env.ERRANDD_CVEFEED_WEBHOOK_SECRET = previous;
  }
});
