/**
 * pullRepo must FORCE on a dirty tree, never freeze.
 *
 * A single uncommitted edit used to make pullRepo skip, which silently held the
 * daemon behind origin for as long as the edit sat there. These tests pin the
 * replacement behaviour: wipe, back up what was wiped, and catch up.
 *
 * Each test uses its own repo slug — jobsRepo keeps per-slug state (lastForcedAt,
 * lastDiscarded) for the life of the process, so sharing one would leak.
 */
import { test, expect, mock, afterAll } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const DISCARDED = await mkdtemp(join(tmpdir(), "ccdiscard-"));

function cfg(slug: string) {
  return { url: `https://example.com/org/${slug}.git`, branch: "main", intervalSeconds: 300, kind: "git" as const, slug };
}

/** The clone under test — swapped per test, read lazily by the mock below. */
let currentClone = "/nonexistent";

const realConfig = await import("../config");
void mock.module("../config", () => ({
  ...realConfig,
  JOBS_DISCARDED_DIR: DISCARDED,
  getSettings: () => ({ jobsRepos: [cfg("jobs")], jobsRepo: cfg("jobs") }),
  getJobsRepoDirForRepo: () => currentClone,
  getJobsRepoDir: () => currentClone,
}));

const { runGit, parseStatus, parsePorcelainPaths, pullRepo, resetRepo } = await import("../jobsRepo");

afterAll(async () => {
  await rm(DISCARDED, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ccforce-"));
}

function ok(label: string, r: { ok: boolean; stderr: string; code: number }) {
  if (!r.ok) throw new Error(`git ${label} failed (code ${r.code}): ${r.stderr.trim()}`);
  return r;
}

/** A bare remote with one commit plus a clone of it, with the clone wired up as
 *  the repo config sees it. `advance()` lands a new commit on the remote so the
 *  clone falls behind. */
async function scenario(slug: string) {
  const remote = await tmp();
  ok("init --bare", await runGit(remote, ["init", "--bare", "--initial-branch=main"]));

  const seed = await tmp();
  ok("init", await runGit(seed, ["init", "--initial-branch=main"]));
  await runGit(seed, ["config", "user.email", "t@t"]);
  await runGit(seed, ["config", "user.name", "t"]);
  await writeFile(join(seed, "a.md"), "original\n");
  ok("add", await runGit(seed, ["add", "-A"]));
  ok("commit", await runGit(seed, ["commit", "-m", "init"]));
  ok("remote add", await runGit(seed, ["remote", "add", "origin", remote]));
  ok("push", await runGit(seed, ["push", "-u", "origin", "main"]));

  const clone = await tmp();
  await rm(clone, { recursive: true, force: true });
  ok("clone", await runGit(process.cwd(), ["clone", "--branch", "main", remote, clone]));
  currentClone = clone;

  async function advance(file: string, body: string, msg: string) {
    await writeFile(join(seed, file), body);
    ok("add", await runGit(seed, ["add", "-A"]));
    ok("commit", await runGit(seed, ["commit", "-m", msg]));
    ok("push", await runGit(seed, ["push", "origin", "main"]));
  }

  async function cleanup() {
    for (const d of [remote, seed, clone]) await rm(d, { recursive: true, force: true });
  }

  return { repo: cfg(slug), clone, advance, cleanup };
}

test("parsePorcelainPaths pulls the worktree path from each status line", () => {
  expect(parsePorcelainPaths(" M scripts/dedupe-bot-prs.sh\n")).toEqual(["scripts/dedupe-bot-prs.sh"]);
  expect(parsePorcelainPaths("?? new.md\n M a.md\n")).toEqual(["new.md", "a.md"]);
  // A rename reports the destination, which is the file actually on disk.
  expect(parsePorcelainPaths("R  old.md -> new.md\n")).toEqual(["new.md"]);
  expect(parsePorcelainPaths('?? "odd name.md"\n')).toEqual(["odd name.md"]);
  expect(parsePorcelainPaths("")).toEqual([]);
});

test("pullRepo force-wipes a dirty tree and catches up to origin", async () => {
  const s = await scenario("force-catchup");
  try {
    // The incident shape: a hand edit in the pod, plus commits landing upstream.
    await writeFile(join(s.clone, "a.md"), "hand edit in the pod\n");
    await writeFile(join(s.clone, "untracked.md"), "stray\n");
    await s.advance("b.md", "new routine\n", "add b.md");

    const status = await pullRepo(s.repo);

    expect(status.dirty).toBe(false);
    expect(status.behind).toBe(0);
    expect(status.lastError).toBeNull();
    // The new routine is visible — the whole point.
    expect(await Bun.file(join(s.clone, "b.md")).text()).toBe("new routine\n");
    expect(await Bun.file(join(s.clone, "a.md")).text()).toBe("original\n");
    expect(existsSync(join(s.clone, "untracked.md"))).toBe(false);
  } finally {
    await s.cleanup();
  }
});

test("pullRepo records what it discarded and backs the files up", async () => {
  const s = await scenario("force-backup");
  try {
    await writeFile(join(s.clone, "a.md"), "hand edit in the pod\n");
    await writeFile(join(s.clone, "untracked.md"), "stray\n");
    await s.advance("b.md", "new routine\n", "add b.md");

    const status = await pullRepo(s.repo);

    expect(status.lastForcedAt).toBeTruthy();
    const discarded = status.lastDiscarded!;
    expect(discarded.count).toBe(2);
    expect(discarded.entries.join("\n")).toContain("a.md");
    expect(discarded.entries.join("\n")).toContain("untracked.md");

    // Backed up outside the clone, so `clean -fd` can't have eaten it.
    expect(discarded.backupDir).toBeTruthy();
    expect(discarded.backupDir!.startsWith(s.clone)).toBe(false);
    expect(await Bun.file(join(discarded.backupDir!, "a.md")).text()).toBe("hand edit in the pod\n");
    expect(await Bun.file(join(discarded.backupDir!, "untracked.md")).text()).toBe("stray\n");
    expect(await Bun.file(join(discarded.backupDir!, "git-status.txt")).text()).toContain("a.md");
  } finally {
    await s.cleanup();
  }
});

test("pullRepo on a clean tree fast-forwards and discards nothing", async () => {
  const s = await scenario("clean-ff");
  try {
    await s.advance("b.md", "new routine\n", "add b.md");

    const status = await pullRepo(s.repo);

    expect(status.behind).toBe(0);
    expect(status.lastError).toBeNull();
    expect(status.lastForcedAt).toBeNull();
    expect(status.lastDiscarded).toBeNull();
    expect(existsSync(join(DISCARDED, "clean-ff"))).toBe(false);
  } finally {
    await s.cleanup();
  }
});

test("pullRepo force-wipes a dirty tree even when already up to date", async () => {
  const s = await scenario("force-uptodate");
  try {
    await writeFile(join(s.clone, "a.md"), "local only\n");

    const status = await pullRepo(s.repo);

    // "Always end up matching origin" — not just when we're behind.
    expect(status.dirty).toBe(false);
    expect(status.lastError).toBeNull();
    expect(await Bun.file(join(s.clone, "a.md")).text()).toBe("original\n");
  } finally {
    await s.cleanup();
  }
});

test("pullRepo pushes unpushed local commits instead of resetting over them", async () => {
  const s = await scenario("ahead-push");
  try {
    // A routine committed locally whose push failed on an auth blip — the tree
    // is dirty too, so the force path runs.
    await writeFile(join(s.clone, "committed.md"), "committed routine\n");
    ok("add", await runGit(s.clone, ["add", "-A"]));
    ok("commit", await runGit(s.clone, ["commit", "-m", "add committed.md"]));
    await writeFile(join(s.clone, "a.md"), "uncommitted hand edit\n");

    const status = await pullRepo(s.repo);

    // The commit survived — pushed to origin, not discarded.
    expect(status.lastDiscarded?.commits ?? []).toEqual([]);
    expect(status.lastDiscarded?.rescueBranch ?? null).toBeNull();
    expect(await Bun.file(join(s.clone, "committed.md")).text()).toBe("committed routine\n");
    expect(status.ahead).toBe(0);
    expect(status.dirty).toBe(false);
    // ...while the uncommitted edit was still wiped.
    expect(await Bun.file(join(s.clone, "a.md")).text()).toBe("original\n");

    const remoteLog = await runGit(s.clone, ["log", "--oneline", "origin/main"]);
    expect(remoteLog.stdout).toContain("add committed.md");
  } finally {
    await s.cleanup();
  }
});

test("pullRepo parks unpushable commits on a rescue branch before resetting", async () => {
  const s = await scenario("ahead-diverged");
  try {
    await writeFile(join(s.clone, "local.md"), "local routine\n");
    ok("add", await runGit(s.clone, ["add", "-A"]));
    ok("commit", await runGit(s.clone, ["commit", "-m", "add local.md"]));
    const localSha = (await runGit(s.clone, ["rev-parse", "HEAD"])).stdout.trim();
    // Remote moves too → histories diverge → the push is rejected.
    await s.advance("b.md", "new routine\n", "add b.md");

    const status = await pullRepo(s.repo);

    const discarded = status.lastDiscarded!;
    expect(discarded.commits.join("\n")).toContain("add local.md");
    expect(discarded.rescueBranch).toBeTruthy();
    // The commit is still reachable, so cherry-pick can recover it.
    const branchSha = await runGit(s.clone, ["rev-parse", discarded.rescueBranch!]);
    expect(branchSha.stdout.trim()).toBe(localSha);
    // ...and the clone still caught up to origin.
    expect(status.behind).toBe(0);
    expect(await Bun.file(join(s.clone, "b.md")).text()).toBe("new routine\n");
  } finally {
    await s.cleanup();
  }
});

test("clean -fd spares gitignored files", async () => {
  const s = await scenario("ignored-survive");
  try {
    await writeFile(join(s.clone, ".gitignore"), ".env\n");
    ok("add", await runGit(s.clone, ["add", "-A"]));
    ok("commit", await runGit(s.clone, ["commit", "-m", "add gitignore"]));
    ok("push", await runGit(s.clone, ["push", "origin", "main"]));
    await writeFile(join(s.clone, ".env"), "SECRET=1\n");
    await writeFile(join(s.clone, "a.md"), "dirty\n");

    await pullRepo(s.repo);

    // No `-x` on clean: a routine's local .env is not ours to delete.
    expect(await Bun.file(join(s.clone, ".env")).text()).toBe("SECRET=1\n");
  } finally {
    await s.cleanup();
  }
});

test("resetRepo shares the force path and records the same evidence", async () => {
  const s = await scenario("manual-reset");
  try {
    await writeFile(join(s.clone, "a.md"), "manual reset case\n");
    await s.advance("b.md", "new routine\n", "add b.md");

    const status = await resetRepo(s.repo);

    expect(status.dirty).toBe(false);
    expect(status.behind).toBe(0);
    expect(status.lastDiscarded?.backupDir).toBeTruthy();
    expect(parseStatus((await runGit(s.clone, ["status", "--porcelain"])).stdout).dirty).toBe(false);
  } finally {
    await s.cleanup();
  }
});
