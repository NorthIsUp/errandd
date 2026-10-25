import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultCveRule, readCveAlert, readGithubAdvisory, queuedCveAlert } from "../../shared/cve";
import { defaultCveConnection, parseCveConnection } from "../../shared/eventSources";
import { ReadCache } from "../readCache";
import { findAdvisory, mergedAdvisory } from "../cve-store";
import { cveDigest, dispatchCveAlert } from "../hooks/cve";
import { GithubAdvisoryPoller } from "../github-advisories";
import { CvePoller } from "../cve-poller";
import type { Job } from "../jobs";
const GHSA = "GHSA-2345-6789-cfgh",
  CVE = "CVE-2026-55551";
const T0 = "2026-10-25T00:00:00.000Z",
  T1 = "2026-10-25T01:00:00.000Z",
  T2 = "2026-10-25T02:00:00.000Z";
const github = (cve: string | null = CVE, updated = T1, range = "<2.0.0") => ({
  ghsa_id: GHSA,
  cve_id: cve,
  type: "reviewed",
  summary: "Unsafe Django",
  description: "Untrusted advisory text",
  severity: "high",
  updated_at: updated,
  withdrawn_at: null,
  references: ["https://docs.djangoproject.com/en/dev/releases/security/"],
  vulnerabilities: [
    {
      package: { ecosystem: "pip", name: "django" },
      vulnerable_version_range: range,
      first_patched_version: "2.0.0",
    },
  ],
});
const official = (updated = T1) => ({
  cveMetadata: { cveId: CVE, dateUpdated: updated, state: "PUBLISHED" },
  containers: {
    cna: {
      title: "Official vulnerability",
      affected: [{ product: "django", collectionURL: "https://pypi.org" }],
      metrics: [{ cvssV3_1: { baseSeverity: "HIGH", baseScore: 8 } }],
      references: [
        { url: `https://github.com/advisories/${GHSA}` },
        { url: `https://nvd.nist.gov/vuln/detail/${CVE}` },
      ],
    },
  },
});
const job = (name = "assess", repositories = ["current"]): Job => ({
  name,
  prompt: "Assess",
  schedules: [],
  recurring: false,
  notify: "error",
  reuseSession: true,
  hookConfig: {
    pr: [],
    skipSelf: true,
    cve: { ...defaultCveRule(), repositories, ecosystem: ["pypi"], includeUnclassified: false },
  },
});
const stores: ReadCache[] = [];
const memory = () => {
  const store = new ReadCache(":memory:");
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

test("GitHub structured ranges classify GHSA-only alerts and preserve vendor references", () => {
  const alert = readGithubAdvisory(github(null))!;
  expect(alert.id).toBe(GHSA);
  expect(alert.aliases).toEqual([GHSA]);
  expect(alert.ecosystems).toEqual(["pypi"]);
  expect(alert.languages).toEqual(["python"]);
  expect(alert.products).toEqual([{ product: "django", vendor: "" }]);
  expect(alert.references).toContain("https://docs.djangoproject.com/en/dev/releases/security/");
  expect(queuedCveAlert(alert)).toEqual(alert);
  // A related-advisory reference alone does not assert shared identity.
  expect(readCveAlert(official())?.aliases).toEqual([CVE]);
  expect(readGithubAdvisory({ ...github(), type: "malware" })).toBeNull();
  expect(readGithubAdvisory({ ...github(), ghsa_id: "../../etc/passwd" })).toBeNull();
  expect(readGithubAdvisory({ ...github(), withdrawn_at: T2 })?.rejected).toBe(true);
});

test("GHSA before CVE, differing timestamps, overlapping jobs and concurrent sources assess once per repo", async () => {
  const store = memory(),
    calls: unknown[] = [];
  const fire = async (_job: string, _event: string, _id: string, payload: unknown) => {
    await Promise.resolve();
    calls.push(payload);
  };
  await dispatchCveAlert(readGithubAdvisory(github(null))!, [job(), job("overlap")], fire, store);
  await Promise.all([
    dispatchCveAlert(readGithubAdvisory(github(CVE, T2))!, [job()], fire, store),
    dispatchCveAlert(readCveAlert(official(T2))!, [job()], fire, store),
  ]);
  expect(calls).toHaveLength(1);
  const record = findAdvisory(store, CVE)!;
  expect(record.id).toBe(GHSA);
  expect(findAdvisory(store, GHSA)?.id).toBe(record.id);
  const merged = mergedAdvisory(record);
  expect(merged.aliases).toContain(CVE);
  expect(merged.sources).toHaveLength(2);
  expect(merged.references).toContain(`https://nvd.nist.gov/vuln/detail/${CVE}`);
  await dispatchCveAlert(
    readGithubAdvisory(github())!,
    [job("other", ["example/other"])],
    fire,
    store,
  );
  expect(calls).toHaveLength(2);
});

test("references, prose, timestamps and affected ordering are enrichment; range changes reassess; stale updates do not", async () => {
  const store = memory(),
    ids: string[] = [];
  const fire = (_j: string, _e: string, id: string) => {
    ids.push(id);
  };
  await dispatchCveAlert(readGithubAdvisory(github())!, [job()], fire, store);
  await dispatchCveAlert(
    readGithubAdvisory({
      ...github(CVE, T2),
      description: "new wording",
      references: ["https://example.com/new"],
    })!,
    [job()],
    fire,
    store,
  );
  expect(ids).toHaveLength(1);
  await dispatchCveAlert(readGithubAdvisory(github(CVE, T2, "<3.0.0"))!, [job()], fire, store);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
  await dispatchCveAlert(readGithubAdvisory(github(CVE, T1, "<2.0.0"))!, [job()], fire, store);
  expect(ids).toHaveLength(2);
  expect(findAdvisory(store, CVE)?.observations.github?.alert.affected).toEqual(
    github(CVE, T2, "<3.0.0").vulnerabilities,
  );
});

test("partial queue failures retry only the failed target, with stable queue ids", async () => {
  const store = memory(),
    ids: string[] = [];
  let fail = true;
  let failedId = "";
  const fire = (_j: string, _e: string, id: string, payload: unknown) => {
    if ((payload as { targetRepository: string }).targetRepository === "example/other" && fail) {
      failedId = id;
      throw Error("queue offline");
    }
    ids.push(id);
  };
  const alert = readGithubAdvisory(github())!,
    jobs = [job("fanout", ["current", "example/other"])];
  await expect(dispatchCveAlert(alert, jobs, fire, store)).rejects.toThrow("queue offline");
  fail = false;
  await dispatchCveAlert(alert, jobs, fire, store);
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(failedId);
});

test("upgrade keeps old SQL receipts, plugins, conversations and feed cursors; aliases survive restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "advisory-upgrade-")),
    path = join(dir, "cache.db");
  let store = new ReadCache(path),
    count = 0;
  try {
    const alert = readCveAlert(official())!;
    store.set("plugins", "installed", { enabled: false });
    store.set("conversations", "thread", { turns: [{ text: "keep me" }] });
    store.set("cve-monitor", "cursor", {
      sha: "a".repeat(40),
      partial: { sha: "b".repeat(40), index: 42 },
    });
    store.set("event-source-settings", "cve", {
      mode: "both",
      feedFormat: "official",
      feedUrl: "",
      intervalMinutes: 5,
    });
    const legacyKey = cveDigest(["assess", "current", CVE]);
    store.set("cve-receipts", legacyKey, { revision: "legacy", updatedAt: T1 });
    const fire = () => {
      count++;
    };
    await dispatchCveAlert(alert, [job()], fire, store);
    await dispatchCveAlert(readGithubAdvisory(github(CVE, T2))!, [job()], fire, store);
    expect(count).toBe(0);
    store.close();
    store = new ReadCache(path);
    await dispatchCveAlert(readGithubAdvisory(github(CVE, T2))!, [job()], fire, store);
    expect(count).toBe(0);
    expect(findAdvisory(store, GHSA)?.aliases).toContain(CVE);
    expect(store.get("plugins", "installed")?.value).toEqual({ enabled: false });
    expect(store.get("conversations", "thread")?.value).toEqual({ turns: [{ text: "keep me" }] });
    expect(store.get("cve-monitor", "cursor")?.value).toEqual({
      sha: "a".repeat(40),
      partial: { sha: "b".repeat(40), index: 42 },
    });
    expect(store.get("cve-receipts", legacyKey)?.value).toEqual({
      revision: "legacy",
      updatedAt: T1,
    });
    expect(store.db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(
      parseCveConnection(store.get("event-source-settings", "cve")?.value).githubAdvisories,
    ).toBe(true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unmatched global advisories are not retained on disk", async () => {
  const store = memory();
  await dispatchCveAlert(
    readGithubAdvisory(github())!,
    [],
    () => {
      throw Error("unmatched");
    },
    store,
  );
  expect(store.entries("advisories")).toHaveLength(0);
});

test("GitHub source baselines, resumes bounded pinned-window pages after restart and retries failures", async () => {
  const store = memory(),
    consumed: string[] = [],
    urls: string[] = [];
  let fail = true;
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    urls.push(url.href);
    if (!url.searchParams.has("after"))
      return Response.json([github()], {
        headers: { link: '<https://api.github.com/advisories?after=page2>; rel="next"' },
      });
    if (fail) return new Response("rate limited", { status: 429 });
    return Response.json([{ ...github(), ghsa_id: "GHSA-cfgh-jmpq-rvwx", cve_id: null }]);
  }) as typeof fetch;
  const consume = async (alert: { id: string }) => {
    consumed.push(alert.id);
  };
  let poller = new GithubAdvisoryPoller(store, consume, fetcher);
  await poller.poll(Date.parse(T0));
  expect(urls).toHaveLength(0);
  await poller.poll(Date.parse(T1));
  const cursor = store.get("github-advisories", "cursor")?.value;
  await expect(poller.poll(Date.parse(T2))).rejects.toThrow("429");
  expect(store.get("github-advisories", "cursor")?.value).toEqual(cursor);
  fail = false;
  poller = new GithubAdvisoryPoller(store, consume, fetcher);
  await poller.poll(Date.parse(T2));
  expect(new URL(urls.at(-1)!).searchParams.get("updated")).toBe(
    "2026-10-25T00:00:00Z..2026-10-25T01:00:00Z",
  );
  expect(store.get("github-advisories", "cursor")?.value).toEqual({ since: T1 });
  expect(consumed).toHaveLength(2);
});

test("queue failure and hostile pagination never advance the discovery cursor", async () => {
  const store = memory();
  store.set("github-advisories", "cursor", { since: T0 });
  let fail = true;
  const fetcher = (async () =>
    Response.json([github()], {
      headers: { link: '<https://attacker.invalid/advisories?after=steal>; rel="next"' },
    })) as unknown as typeof fetch;
  const poller = new GithubAdvisoryPoller(
    store,
    async () => {
      if (fail) throw Error("queue failed");
    },
    fetcher,
  );
  await expect(poller.poll(Date.parse(T1))).rejects.toThrow("queue failed");
  fail = false;
  await expect(poller.poll(Date.parse(T1))).rejects.toThrow("pagination");
  expect(store.get("github-advisories", "cursor")?.value).toEqual({ since: T0 });
});

test("official feed failures do not prevent GitHub discovery, and webhook-only mode stops both", async () => {
  const store = memory();
  let calls = 0,
    fired = 0;
  store.set("github-advisories", "cursor", { since: T0 });
  const fetcher = (async (input: string | URL | Request) => {
    calls++;
    if (
      (typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
      ).startsWith("https://api.github.com/advisories?")
    )
      return Response.json([github()]);
    throw Error("official unavailable");
  }) as typeof fetch;
  const poller = new CvePoller(
    {
      getJobs: () => [job()],
      onHookFire: () => {
        fired++;
      },
    },
    store,
    fetcher,
  );
  await expect(poller.poll()).rejects.toThrow("official unavailable");
  expect(fired).toBe(1);
  store.set("event-source-settings", "cve", { ...defaultCveConnection(), mode: "webhook" });
  const before = calls;
  await poller.poll();
  expect(calls).toBe(before);
});

test("mirrored changes enrich evidence while the authoritative package source alone triggers reassessment", async () => {
  const store = memory();
  let fired = 0;
  const fire = () => {
    fired++;
  };
  await dispatchCveAlert(readGithubAdvisory(github())!, [job()], fire, store);
  await dispatchCveAlert(readCveAlert(official())!, [job()], fire, store);
  await dispatchCveAlert(readGithubAdvisory(github(CVE, T2, "<3.0.0"))!, [job()], fire, store);
  const mirror = readCveAlert(official(T2))!;
  mirror.affected = [{ product: "django", versions: [{ lessThan: "3.0.0", status: "affected" }] }];
  await dispatchCveAlert(mirror, [job()], fire, store);
  expect(fired).toBe(2);
});

test("material reverts get distinct queue IDs, and reordered metadata does not", async () => {
  const store = memory(),
    ids: string[] = [];
  const fire = (_j: string, _e: string, id: string) => {
    ids.push(id);
  };
  const first = readGithubAdvisory(github())!;
  first.affected.push({
    package: { ecosystem: "pip", name: "other" },
    vulnerable_version_range: "<1",
  });
  await dispatchCveAlert(first, [job()], fire, store);
  await dispatchCveAlert(
    { ...first, updatedAt: T2, affected: [...first.affected].reverse() },
    [job()],
    fire,
    store,
  );
  expect(ids).toHaveLength(1);
  await dispatchCveAlert({ ...first, updatedAt: T2, affected: [] }, [job()], fire, store);
  await dispatchCveAlert({ ...first, updatedAt: T2 }, [job()], fire, store);
  expect(ids).toHaveLength(3);
  expect(new Set(ids).size).toBe(3);
});

test("late alias bridge merges separately stored records and receipts without another assessment", async () => {
  const store = memory();
  let fired = 0;
  const fire = () => {
    fired++;
  };
  const cveOnly = readCveAlert(official())!;
  cveOnly.aliases = [CVE];
  cveOnly.references = [];
  await dispatchCveAlert(cveOnly, [job()], fire, store);
  await dispatchCveAlert(readGithubAdvisory(github(null))!, [job()], fire, store);
  expect(fired).toBe(2); // No source yet asserted these were the same vulnerability.
  await dispatchCveAlert(readGithubAdvisory(github())!, [job()], fire, store);
  expect(fired).toBe(2);
  expect(store.entries("advisories")).toHaveLength(1);
  expect(findAdvisory(store, CVE)?.id).toBe(findAdvisory(store, GHSA)?.id);
});

test("GitHub polling opt-out and per-errand poll:false perform no discovery requests", async () => {
  const store = memory();
  store.set("event-source-settings", "cve", { ...defaultCveConnection(), githubAdvisories: false });
  const fetcher = (async (input: string | URL | Request) => {
    if (
      (typeof input === "string" ? input : input instanceof URL ? input.href : input.url).includes(
        "/advisories",
      )
    )
      throw Error("GitHub disabled");
    return Response.json({ object: { sha: "a".repeat(40) } });
  }) as typeof fetch;
  const selected = job();
  const poller = new CvePoller(
    {
      getJobs: () => [selected],
      onHookFire: () => {
        throw Error("no historical jobs");
      },
    },
    store,
    fetcher,
  );
  await poller.poll();
  expect(store.get("github-advisories", "cursor")).toBeUndefined();
  store.set("event-source-settings", "cve", defaultCveConnection());
  selected.hookConfig!.cve = { ...defaultCveRule(), poll: false };
  await poller.poll();
  expect(store.get("github-advisories", "cursor")).toBeUndefined();
});

test("exactly 100 advisories on the final page completes the window", async () => {
  const store = memory();
  store.set("github-advisories", "cursor", { since: T0 });
  let consumed = 0;
  const fetcher = (async () =>
    Response.json(Array.from({ length: 100 }, () => github()))) as unknown as typeof fetch;
  await new GithubAdvisoryPoller(
    store,
    async () => {
      consumed++;
    },
    fetcher,
  ).poll(Date.parse(T1));
  expect(consumed).toBe(100);
  expect(store.get("github-advisories", "cursor")?.value).toEqual({ since: T1 });
});

test("oversized or invalid GitHub responses fail without advancing the cursor", async () => {
  const store = memory();
  store.set("github-advisories", "cursor", { since: T0 });
  for (const body of ["x".repeat(8 * 1024 * 1024 + 1), JSON.stringify([{}])]) {
    const fetcher = (async () => new Response(body)) as unknown as typeof fetch;
    const poller = new GithubAdvisoryPoller(
      store,
      async () => {
        throw Error("invalid data queued");
      },
      fetcher,
    );
    await expect(poller.poll(Date.parse(T1))).rejects.toThrow();
    expect(store.get("github-advisories", "cursor")?.value).toEqual({ since: T0 });
  }
});
