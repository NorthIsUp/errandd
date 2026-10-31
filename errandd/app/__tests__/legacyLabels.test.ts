import { GithubRepositoryRegistry } from "../github/repositories";
import { ReadCache } from "../readCache";
import { expect, test, spyOn } from "bun:test";
import { createHmac } from "node:crypto";
import { handleWebhook } from "../hooks/receiver";
import { getReadCache } from "../readCache";
import { LegacyLabelMigrator, legacyLabelMigrator, migrateLegacyLabels } from "../github/legacyLabels";

const repo = "org/repo";
function fixture(labels: { name: string; color: string; description?: string }[], pages: unknown[][] = [[]]) {
  const calls: string[][] = [];
  const read = async (args: string[]) => {
    calls.push(args);
    if (args.some(arg => arg.endsWith("/labels?per_page=100"))) return JSON.stringify(labels);
    if (args.some(arg => arg.includes("/issues?"))) return pages.map(page => JSON.stringify(page)).join("\n");
    return "{}";
  };
  return { calls, read };
}
test("a legacy-only label is renamed in place and made yellow without relabeling issues", async () => {
  const f = fixture([{ name: "claw:hold", color: "000000" }]);
  expect(await migrateLegacyLabels(repo, f.read)).toEqual({ renamed: 1, assignments: 0, recolored: 0, pullRequestsOnly: false });
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1]).toEqual(["api", "--method", "PATCH", "repos/org/repo/labels/claw%3Ahold", "-f", "new_name=errandd:hold", "-f", "color=FBCA04"]);
});
test("duplicate labels preserve holds by adding the canonical label before removing each paginated legacy assignment", async () => {
  const f = fixture([{ name: "claw:hold", color: "FBCA04" }, { name: "errandd:hold", color: "FBCA04" }],
    [[{ number: 1, labels: ["claw:hold"] }], [{ number: 2, labels: ["claw:hold", "errandd:hold"] }]]);
  expect((await migrateLegacyLabels(repo, f.read)).assignments).toBe(2);
  const writes = f.calls.filter(args => args.includes("POST") || args.includes("DELETE"));
  expect(writes.map(args => args[2])).toEqual(["POST", "DELETE", "DELETE"]);
  expect(writes[0]).toContain("labels[]=errandd:hold");
  expect(writes[1][3]).toBe("repos/org/repo/issues/1/labels/claw%3Ahold");
  expect(writes[2][3]).toBe("repos/org/repo/issues/2/labels/claw%3Ahold");
  expect(f.calls.filter(args => args.includes("DELETE")).every(args => args[3].includes("/issues/"))).toBe(true);
});
test("a failed canonical write must never clear the legacy human hold", async () => {
  const f = fixture([{ name: "claw:hold", color: "FBCA04" }, { name: "errandd:hold", color: "FBCA04" }], [[{ number: 1, labels: [] }]]);
  await expect(migrateLegacyLabels(repo, async args => {
    if (args.includes("POST")) throw new Error("permission denied");
    return f.read(args);
  })).rejects.toThrow("permission denied");
  expect(f.calls.some(args => args.includes("DELETE"))).toBe(false);
});
test("canonical labels are recolored, unrelated labels stay untouched, and already-yellow labels cause no writes", async () => {
  const f = fixture([{ name: "errandd:ready", color: "000000" }, { name: "bug", color: "000000" }, { name: "errandd:ignore", color: "fbca04" }]);
  expect((await migrateLegacyLabels(repo, f.read)).recolored).toBe(1);
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1][3]).toBe("repos/org/repo/labels/errandd%3Aready");
});
test("disabled migration performs no GitHub calls, including sweep and webhook requests", async () => {
  const f = fixture([]);
  const worker = new LegacyLabelMigrator(() => false, f.read);
  worker.sweep([repo]);
  await worker.enqueue(repo);
  expect(f.calls).toEqual([]);
});
test("disabling during consolidation preserves the legacy hold and prevents further writes", async () => {
  let enabled = true;
  const f = fixture([{ name: "claw:hold", color: "FBCA04" }, { name: "errandd:hold", color: "FBCA04" }], [[{ number: 1, labels: [] }]]);
  const worker = new LegacyLabelMigrator(() => enabled, async args => {
    const value = await f.read(args);
    if (args.includes("POST")) enabled = false;
    return value;
  });
  await worker.enqueue(repo);
  expect(f.calls.some(args => args.includes("POST"))).toBe(true);
  expect(f.calls.some(args => args.includes("DELETE"))).toBe(false);
});
test("duplicate events share one queued migration and errors are reported without blocking later repositories", async () => {
  const calls: string[][] = [], logs: string[] = [];
  const worker = new LegacyLabelMigrator(() => true, async args => {
    calls.push(args);
    if (args.some(arg => arg.includes("org/repo/"))) throw new Error("GitHub unavailable");
    return "[]";
  }, message => logs.push(message));
  const first = worker.enqueue(repo);
  expect(worker.enqueue(repo)).toBe(first);
  await Promise.all([first, worker.enqueue("org/other")]);
  expect(calls).toHaveLength(2);
  expect(logs[0]).toContain("will retry");
  expect(logs[0]).toContain("no LLM interaction");
});
test("malformed repository names cannot reach the GitHub CLI", async () => {
  const f = fixture([]);
  await expect(migrateLegacyLabels("../--evil", f.read)).rejects.toThrow("Invalid");
  const worker = new LegacyLabelMigrator(() => true, f.read);
  await worker.enqueue("--repo");
  expect(f.calls).toEqual([]);
});


test("bounded sweeps advance past the first batch rather than starving later repositories", async () => {
  const f = fixture([]);
  const worker = new LegacyLabelMigrator(() => true, f.read);
  const repos = Array.from({ length: 65 }, (_, i) => `org/repo-${i}`);
  worker.sweep(repos);
  await worker.enqueue(repos[63]);
  expect(f.calls).toHaveLength(64);
  worker.sweep(repos);
  await worker.enqueue(repos[64]);
  expect(f.calls.some(args => args.includes("repos/org/repo-64/labels?per_page=100"))).toBe(true);
});

test("unverified legacy-label events cannot register repositories or perform GitHub calls", async () => {
  const db = new ReadCache(":memory:");
  try {
    const registry = new GithubRepositoryRegistry(() => db);
    const f = fixture([]);
    const worker = new LegacyLabelMigrator(() => true, f.read, () => {}, registry);
    worker.observe({ repository: { full_name: repo }, label: { name: "claw:hold" } }, false);
    expect(registry.list([])).toEqual([]);
    expect(f.calls).toEqual([]);
  } finally { db.close(); }
});

test("verified history persists independently of sidebar caches and explicit repository scopes exclude wildcards and traversal", async () => {
  const db = new ReadCache(":memory:");
  try {
    const registry = new GithubRepositoryRegistry(() => db);
    const f = fixture([]);
    const worker = new LegacyLabelMigrator(() => true, f.read, () => {}, registry);
    worker.observe({ repository: { full_name: repo }, label: { name: "claw:hold" } }, true);
    await worker.enqueue(repo);
    expect(f.calls).toHaveLength(1);
    const reopened = new GithubRepositoryRegistry(() => db);
    expect(reopened.list(["org/explicit", "*/*", "org/*", "org/..", "org/.", repo])).toEqual([repo, "org/explicit"]);
    expect(reopened.remember({ repository: { full_name: "../elsewhere" } })).toBeUndefined();
    expect(reopened.list([])).toEqual([repo]);
  } finally { db.close(); }
});

test("malformed GitHub label pages fail closed before any write", async () => {
  const calls: string[][] = [];
  await expect(migrateLegacyLabels(repo, async args => {
    calls.push(args);
    return JSON.stringify([{ name: "claw:hold", color: "not-a-color" }]);
  })).rejects.toThrow();
  expect(calls).toHaveLength(1);
});

test("malformed issue identifiers cannot cause assignment writes or remove a human hold", async () => {
  const f = fixture([{ name: "claw:hold", color: "FBCA04" }, { name: "errandd:hold", color: "FBCA04" }], [[{ number: -1, labels: [] }]]);
  await expect(migrateLegacyLabels(repo, f.read)).rejects.toThrow();
  expect(f.calls.some(args => args.includes("POST") || args.includes("DELETE"))).toBe(false);
});


test("the real webhook envelope only admits repository writes after configured HMAC verification", async () => {
  const saved = process.env.ERRANDD_GITHUB_WEBHOOK_SECRET;
  const name = `fixture/verified-label-${Date.now()}`;
  const enqueue = spyOn(legacyLabelMigrator, "enqueue").mockResolvedValue(undefined);
  const payload = JSON.stringify({ action: "labeled", repository: { full_name: name }, label: { name: "claw:hold" }, pull_request: { number: 1 } });
  const send = (id: string, signature: string) => handleWebhook(new Request("http://localhost/api/webhooks/github", {
    method: "POST", body: payload,
    headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": id, "x-hub-signature-256": signature },
  }), {});
  try {
    delete process.env.ERRANDD_GITHUB_WEBHOOK_SECRET;
    expect((await send(`${name}-unsigned`, "")).status).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
    expect(getReadCache().get("verified-github-repositories", name)).toBeUndefined();
    process.env.ERRANDD_GITHUB_WEBHOOK_SECRET = "fixture-webhook-secret";
    expect((await send(`${name}-invalid`, "sha256=invalid")).status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
    const signature = `sha256=${createHmac("sha256", "fixture-webhook-secret").update(payload).digest("hex")}`;
    expect((await send(`${name}-verified`, signature)).status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(name);
    expect(getReadCache().get("verified-github-repositories", name)?.value).toBe(true);
  } finally {
    enqueue.mockRestore();
    getReadCache().delete("verified-github-repositories", name);
    if (saved === undefined) delete process.env.ERRANDD_GITHUB_WEBHOOK_SECRET;
    else process.env.ERRANDD_GITHUB_WEBHOOK_SECRET = saved;
  }
});


test("migration registry failures cannot break ordinary webhook handling or daemon startup", () => {
  const logs: string[] = [];
  const registry = new GithubRepositoryRegistry(() => { throw new Error("cache unavailable"); });
  const worker = new LegacyLabelMigrator(() => true, async () => "[]", message => logs.push(message), registry);
  expect(() => worker.observe({ repository: { full_name: repo } }, true)).not.toThrow();
  expect(() => worker.sweep()).not.toThrow();
  expect(logs).toHaveLength(2);
  expect(logs.every(message => message.includes("will retry") && message.includes("no LLM interaction"))).toBe(true);
});

test("keys without issue enumeration permissions still consolidate pull-request labels", async () => {
  const f = fixture([{ name: "claw:hold", color: "FBCA04" }, { name: "errandd:hold", color: "FBCA04" }]);
  const calls: string[][] = [];
  const result = await migrateLegacyLabels(repo, async args => {
    calls.push(args);
    if (args.some(arg => arg.includes("/issues?"))) throw new Error("Resource not accessible by integration (HTTP 403)");
    if (args[1] === "graphql") return JSON.stringify([{ number: 1, labels: ["claw:hold"] }]);
    return f.read(args);
  });
  expect(result.pullRequestsOnly).toBe(true);
  expect(result.assignments).toBe(1);
  expect(calls.filter(args => args.includes("POST") || args.includes("DELETE")).map(args => args[2])).toEqual(["POST", "DELETE"]);
  expect(calls.some(args => args.includes("label=claw:hold"))).toBe(true);
});

test("an inaccessible duplicate alias cannot block independent label renames", async () => {
  const f = fixture([{ name: "claw:hold", color: "FBCA04" }, { name: "errandd:hold", color: "FBCA04" }, { name: "claw:smoke", color: "000000" }]);
  const calls: string[][] = [];
  await expect(migrateLegacyLabels(repo, async args => {
    calls.push(args);
    if (args.some(arg => arg.includes("/issues?"))) throw new Error("GitHub temporarily unavailable (HTTP 503)");
    return f.read(args);
  })).rejects.toThrow("503");
  const renamed = calls.findIndex(args => args.includes("new_name=errandd:smoke"));
  const enumeration = calls.findIndex(args => args.some(arg => arg.includes("/issues?")));
  expect(renamed).toBeGreaterThan(0);
  expect(renamed).toBeLessThan(enumeration);
});
