import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runGit, parseStatus, buildCommitMessage, isNonFastForward } from "../jobsRepo";

async function tmp(): Promise<string> { return mkdtemp(join(tmpdir(), "ccjr-")); }

/** Assert a setup git command succeeded, surfacing stderr on failure — so a
 *  broken precondition fails loudly with the real reason instead of silently
 *  cascading into a confusing later assertion. */
function ok(label: string, r: { ok: boolean; stderr: string; code: number }): { ok: boolean; stderr: string; code: number } {
  if (!r.ok) {
    throw new Error(`git ${label} failed (code ${r.code}): ${r.stderr.trim()}`);
  }
  return r;
}

test("isNonFastForward detects a rejected push (remote moved ahead)", () => {
  // The exact stderr GitHub returns for the case syncRepo now recovers from.
  const rejected = `To https://github.com/teamclara/errandd-jobs.git
 ! [rejected]        main -> main (fetch first)
error: failed to push some refs to 'https://github.com/teamclara/errandd-jobs.git'
hint: Updates were rejected because the remote contains work that you do not
hint: have locally.`;
  expect(isNonFastForward(rejected)).toBe(true);
  expect(isNonFastForward("non-fast-forward")).toBe(true);
  // Unrelated failures must NOT trigger the rebase-retry.
  expect(isNonFastForward("fatal: Authentication failed for 'https://...'")).toBe(false);
  expect(isNonFastForward("fatal: unable to access ... Could not resolve host")).toBe(false);
});

test("runGit reports failure for a bad command", async () => {
  const dir = await tmp();
  const res = await runGit(dir, ["status"]); // not a repo
  expect(res.ok).toBe(false);
  await rm(dir, { recursive: true, force: true });
});

test("parseStatus detects clean vs dirty", () => {
  expect(parseStatus("").dirty).toBe(false);
  expect(parseStatus(" M jobs/a.md\n").dirty).toBe(true);
});

test("clone + clean status round-trips", async () => {
  const remote = await tmp();
  ok("init --bare", await runGit(remote, ["init", "--bare"]));
  const work = await tmp();
  ok("init", await runGit(work, ["init"]));
  await runGit(work, ["config", "user.email", "t@t"]);
  await runGit(work, ["config", "user.name", "t"]);
  await writeFile(join(work, "a.md"), "---\nschedule: \"0 9 * * *\"\n---\nhi\n");
  ok("add", await runGit(work, ["add", "-A"]));
  ok("commit", await runGit(work, ["commit", "-m", "init"]));
  ok("branch -M main", await runGit(work, ["branch", "-M", "main"]));
  ok("remote add", await runGit(work, ["remote", "add", "origin", remote]));
  ok("push", await runGit(work, ["push", "-u", "origin", "main"]));

  const clone = await tmp();
  await rm(clone, { recursive: true, force: true });
  const c = await runGit(process.cwd(), ["clone", "--branch", "main", remote, clone]);
  ok("clone", c);
  expect(c.ok).toBe(true);
  const st = await runGit(clone, ["status", "--porcelain"]);
  expect(parseStatus(st.stdout).dirty).toBe(false);

  for (const d of [remote, work, clone]) await rm(d, { recursive: true, force: true });
});

test("commit message includes a timestamp", () => {
  const msg = buildCommitMessage(new Date("2026-05-22T14:30:00Z"));
  expect(msg).toContain("errandd: sync jobs");
  expect(msg).toContain("2026-05-22");
});

test("dirty working tree is detected so pull is skipped", async () => {
  const remote = await tmp();
  await runGit(remote, ["init", "--bare"]);
  const work = await tmp();
  ok("init", await runGit(work, ["init"]));
  await runGit(work, ["config", "user.email", "t@t"]);
  await runGit(work, ["config", "user.name", "t"]);
  await writeFile(join(work, "a.md"), "original\n");
  ok("add", await runGit(work, ["add", "-A"]));
  ok("commit", await runGit(work, ["commit", "-m", "init"]));
  ok("branch -M main", await runGit(work, ["branch", "-M", "main"]));
  ok("remote add", await runGit(work, ["remote", "add", "origin", remote]));
  ok("push", await runGit(work, ["push", "-u", "origin", "main"]));

  // Make a local uncommitted edit -> tree is dirty.
  await writeFile(join(work, "a.md"), "local edit\n");
  const st = await runGit(work, ["status", "--porcelain"]);
  expect(parseStatus(st.stdout).dirty).toBe(true);

  // The dirty edit must still be on disk and uncommitted (nothing destroyed it).
  expect(await Bun.file(join(work, "a.md")).text()).toBe("local edit\n");
  const log = await runGit(work, ["log", "-1", "--pretty=%s"]);
  expect(log.stdout.trim()).toBe("init");

  for (const d of [remote, work]) await rm(d, { recursive: true, force: true });
});
