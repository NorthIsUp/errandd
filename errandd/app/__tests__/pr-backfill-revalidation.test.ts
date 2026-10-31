import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Exercise the real queue, GraphQL command and cache without touching daemon state or GitHub. */
test("closed and temporarily unresolvable PRs are revalidated, while merged remains permanent", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pr-backfill-revalidation-"));
  const app = resolve(import.meta.dir, "..");
  try {
    await mkdir(join(scratch, "bin"));
    await mkdir(join(scratch, ".claude", "errandd"), { recursive: true });
    await writeFile(
      join(scratch, "bin", "gh"),
      '#!/bin/sh\n[ "$1 $2" = "api graphql" ] || exit 2\nprintf "." >> "$PR_CALLS_FILE"\nprintf "%s\\n" "$@" >> "$PR_ARGS_FILE"\ncat "$PR_RESPONSE_FILE"\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(scratch, "scenario.ts"),
      `
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { getHookQueue } from ${JSON.stringify(join(app, "hookQueue.ts"))};
import { backfillClosedPrStates } from ${JSON.stringify(join(app, "pr-backfill.ts"))};
import { getPrStates, prStateKey, recordPrState, prSourceUpdatedAtMs } from ${JSON.stringify(join(app, "pr-state.ts"))};
const repo = "example/backend";
const queue = getHookQueue();
const add = (n: number, target = repo) => queue.enqueue({ id: String(n), threadId: "test:"+n, jobName: "test", event: "pull_request", scope: "pr-"+n, prRepo: target, prNumber: n, payload: {} });
const calls = () => readFileSync(process.env.PR_CALLS_FILE!, "utf8").length;
const respond = (n: number, state: string | null) => writeFileSync(process.env.PR_RESPONSE_FILE!, JSON.stringify({ data: { repository: { ["p"+n]: state ? { state, updatedAt: "2026-10-31T12:00:00Z", mergeable: "UNKNOWN" } : null } } }));
let nowMs = Date.now();
Date.now = () => nowMs;
const fresh = new Map([[repo, new Set<number>()]]);
add(4498);
recordPrState(repo, 4498, { state: "closed", mergeable: null, sourceUpdatedAtMs: prSourceUpdatedAtMs("2026-10-30T12:00:00Z") });
respond(4498, "CLOSED");
await backfillClosedPrStates(fresh);
assert.equal(calls(), 1, "closed observations must be eligible for bounded reconciliation");
respond(4498, "MERGED");
nowMs += 1_000;
await backfillClosedPrStates(fresh);
assert.equal(calls(), 1, "a recently checked closed PR must not hammer GitHub");
nowMs += 60 * 60 * 1_000;
await backfillClosedPrStates(fresh);
assert.equal(getPrStates()[prStateKey(repo, 4498)]?.state, "merged", "authoritative GraphQL evidence must repair missed reopen+merge events");
assert.equal(calls(), 2);
nowMs += 60 * 60 * 1_000;
await backfillClosedPrStates(fresh);
assert.equal(calls(), 2, "merged is immutable and needs no repeat lookup");
add(4500);
respond(4500, null);
await backfillClosedPrStates(fresh);
assert.equal(calls(), 3);
assert.equal(getPrStates()[prStateKey(repo, 4500)], undefined, "absence or missing access cannot fabricate a merged state");
respond(4500, "MERGED");
nowMs += 1_000;
await backfillClosedPrStates(fresh);
assert.equal(calls(), 3, "unresolvable responses use a bounded retry delay");
nowMs += 60 * 60 * 1_000;
await backfillClosedPrStates(fresh);
assert.equal(getPrStates()[prStateKey(repo, 4500)]?.state, "merged", "restored permissions must recover without a daemon restart");
assert.equal(calls(), 4);
add(4501);
recordPrState(repo, 4501, { state: "closed", mergeable: null, sourceUpdatedAtMs: prSourceUpdatedAtMs("2026-10-30T12:00:00Z") });
writeFileSync(process.env.PR_RESPONSE_FILE!, "incomplete response");
await backfillClosedPrStates(fresh);
assert.equal(getPrStates()[prStateKey(repo, 4501)]?.state, "closed", "a failed lookup must preserve known state");
assert.equal(calls(), 5);
respond(4501, "MERGED");
nowMs += 1_000;
await backfillClosedPrStates(fresh);
assert.equal(calls(), 5, "malformed API responses also have a bounded retry delay");
nowMs += 60 * 60 * 1_000;
await backfillClosedPrStates(fresh);
assert.equal(getPrStates()[prStateKey(repo, 4501)]?.state, "merged");
assert.equal(calls(), 6);
const many = Array.from({ length: 125 }, (_, i) => 5000 + i);
for (const n of many) add(n);
writeFileSync(process.env.PR_RESPONSE_FILE!, JSON.stringify({ data: { repository: Object.fromEntries(many.map(n => ["p"+n, { state: "MERGED", updatedAt: "2026-10-31T12:00:00Z" }])) } }));
await backfillClosedPrStates(fresh);
assert.equal(calls(), 8, "one cycle retains the existing two-batch API budget");
assert.equal(many.filter(n => getPrStates()[prStateKey(repo, n)]?.state === "merged").length, 100);
await backfillClosedPrStates(fresh);
assert.equal(calls(), 9, "remaining due PRs progress on the next cycle");
assert.equal(many.filter(n => getPrStates()[prStateKey(repo, n)]?.state === "merged").length, 125);
const closed = Array.from({ length: 300 }, (_, i) => ({ number: 6000 + i, repo: i < 100 ? repo : i < 200 ? "example/second" : "example/third" }));
for (const pr of closed) {
  add(pr.number, pr.repo);
  recordPrState(pr.repo, pr.number, { state: "closed", mergeable: null, sourceUpdatedAtMs: prSourceUpdatedAtMs("2026-10-30T12:00:00Z") });
}
writeFileSync(process.env.PR_RESPONSE_FILE!, JSON.stringify({ data: { repository: Object.fromEntries(closed.map(pr => ["p"+pr.number, { state: "CLOSED", updatedAt: "2026-10-31T12:00:00Z" }])) } }));
const repos = new Map([repo, "example/second", "example/third"].map(name => [name, new Set<number>()]));
for (let cycle = 0; cycle < 8; cycle++) {
  await backfillClosedPrStates(repos);
  nowMs += 3 * 60 * 1_000;
}
const args = readFileSync(process.env.PR_ARGS_FILE!, "utf8");
assert.equal(closed.filter(pr => args.includes("pullRequest(number: "+pr.number+")")).length, 300, "due records must not starve behind newer queue rows across repositories");
queue.close();
console.log("revalidation scenarios passed");
`,
    );
    await writeFile(join(scratch, "calls"), "");
    const child = Bun.spawn([process.execPath, join(scratch, "scenario.ts")], {
      cwd: scratch,
      env: {
        ...process.env,
        PATH: `${join(scratch, "bin")}:${process.env.PATH}`,
        PR_CALLS_FILE: join(scratch, "calls"),
        PR_ARGS_FILE: join(scratch, "args"),
        PR_RESPONSE_FILE: join(scratch, "response.json"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("revalidation scenarios passed");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
