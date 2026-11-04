import { expect, test } from "bun:test";
import { runCommandJob } from "../commandJob";
import { parseJobFile } from "../jobs";

test("a scheduled command remains an executable job without a model override", () => {
  const job = parseJobFile("maintenance", '---\ncommand: "printf synced"\non:\n  - schedule: "0 * * * *"\n---\nMaintain checkout.');
  expect(job?.command).toBe("printf synced");
  expect(job?.model).toBeUndefined();
});

test("a maintenance command completes with a deterministic status and no agent", async () => {
  const result = await runCommandJob({ name: "maintenance", command: "printf 'synced'" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("synced");
  expect(result.stdout).toContain("no LLM interaction");
});

test("a failing command and pipeline preserve failure instead of buying an agent retry", async () => {
  for (const command of ["exit 7", "false | cat"]) {
    const result = await runCommandJob({ name: "maintenance", command });
    expect(result.exitCode).not.toBe(0);
  }
});

test("webhook identifiers are data in the command environment rather than shell source", async () => {
  const result = await runCommandJob({ name: "accepted", command: 'printf "%s:%s" "$ERRANDD_REPOSITORY" "$ERRANDD_PR_NUMBER"' },
    { repository: "owner/repo; exit 9", prNumber: 42 });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("owner/repo; exit 9:42");
});

test("a hung maintenance process is stopped within its deadline", async () => {
  const before = Date.now();
  const result = await runCommandJob({ name: "maintenance", command: "sleep 30", timeoutSeconds: 0.05 });
  expect(Date.now() - before).toBeLessThan(2000);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("timed out");
});

test("unbounded output is terminated and cannot exhaust daemon memory", async () => {
  const result = await runCommandJob({ name: "maintenance", command: "yes flood" });
  expect(result.exitCode).toBe(1);
  expect(result.stdout.length).toBeLessThan(263_000);
  expect(result.stderr).toContain("exceeded");
});
