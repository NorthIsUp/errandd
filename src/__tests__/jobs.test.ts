import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { buildJobThreadId } from "../jobs";
import { selectThreadsToKeep } from "../sessionManager";
import type { ThreadSession } from "../sessionManager";

const TEST_ROOT = join(import.meta.dir, "../../test-sandbox-jobs");
const LEGACY_JOBS_DIR = join(TEST_ROOT, ".claude", "claudeclaw", "jobs");
const AGENTS_DIR = join(TEST_ROOT, "agents");

async function resetSandbox() {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(LEGACY_JOBS_DIR, { recursive: true });
  await mkdir(join(AGENTS_DIR, "suzy", "jobs"), { recursive: true });
  await mkdir(join(AGENTS_DIR, "reg", "jobs"), { recursive: true });
}

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

function jobMd(schedule: string, prompt: string, extra = ""): string {
  const extras = extra ? extra + "\n" : "";
  return `---\nschedule: ${schedule}\nrecurring: true\n${extras}---\n${prompt}\n`;
}

/** Run loadJobs() in the sandbox dir via a child bun process (so process.cwd() == TEST_ROOT). */
async function loadJobsInSandbox(): Promise<import("../jobs").Job[]> {
  const script = `
import { loadJobs } from ${JSON.stringify(join(import.meta.dir, "..", "jobs"))};
const jobs = await loadJobs();
process.stdout.write(JSON.stringify(jobs));
`;
  const scriptPath = join(TEST_ROOT, "_run.ts");
  await writeFile(scriptPath, script);
  const proc = Bun.spawn(["bun", "run", scriptPath], {
    cwd: TEST_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(out || "[]");
}

// ─── Integration tests ────────────────────────────────────────────────────

describe("loadJobs", () => {
  beforeEach(resetSandbox);

  test("empty dirs → zero jobs, no throw", async () => {
    const jobs = await loadJobsInSandbox();
    expect(jobs).toEqual([]);
  });

  test("loads job from legacy .claude/claudeclaw/jobs/", async () => {
    await writeFile(
      join(LEGACY_JOBS_DIR, "nightly.md"),
      jobMd("0 3 * * *", "Run nightly report")
    );
    const jobs = await loadJobsInSandbox();
    const job = jobs.find((j) => j.name === "nightly");
    expect(job).toBeDefined();
    expect(job?.agent).toBeUndefined(); // not agent-scoped
    expect(job?.schedule).toBe("0 3 * * *");
    expect(job?.prompt).toBe("Run nightly report");
  });

  test("loads job from agents/<name>/jobs/ (Phase 17 path)", async () => {
    await writeFile(
      join(AGENTS_DIR, "suzy", "jobs", "daily-digest.md"),
      jobMd("0 9 * * *", "Summarise today's news")
    );
    const jobs = await loadJobsInSandbox();
    const job = jobs.find((j) => j.name === "suzy/daily-digest");
    expect(job).toBeDefined();
    expect(job?.agent).toBe("suzy");
    expect(job?.label).toBe("daily-digest");
    expect(job?.schedule).toBe("0 9 * * *");
    expect(job?.prompt).toBe("Summarise today's news");
  });

  test("directory location overrides frontmatter agent field", async () => {
    // Even if the .md file says agent: wrong, the enclosing dir wins.
    await writeFile(
      join(AGENTS_DIR, "reg", "jobs", "seo.md"),
      jobMd("30 10 * * *", "SEO review", "agent: wrong-agent")
    );
    const jobs = await loadJobsInSandbox();
    const job = jobs.find((j) => j.name === "reg/seo");
    expect(job?.agent).toBe("reg");
  });

  test("enabled: false excludes job", async () => {
    await writeFile(
      join(AGENTS_DIR, "suzy", "jobs", "disabled.md"),
      jobMd("0 12 * * *", "Disabled", "enabled: false")
    );
    const jobs = await loadJobsInSandbox();
    expect(jobs.find((j) => j.name === "suzy/disabled")).toBeUndefined();
  });

  test("returns jobs from both legacy and agent-scoped locations together", async () => {
    await writeFile(join(LEGACY_JOBS_DIR, "nightly.md"), jobMd("0 3 * * *", "Nightly"));
    await writeFile(join(AGENTS_DIR, "suzy", "jobs", "morning.md"), jobMd("0 9 * * *", "Morning"));
    const jobs = await loadJobsInSandbox();
    const names = jobs.map((j) => j.name);
    expect(names).toContain("nightly");
    expect(names).toContain("suzy/morning");
  });

  test("missing agents/ dir is silently ignored (no throw)", async () => {
    await rm(AGENTS_DIR, { recursive: true, force: true });
    const jobs = await loadJobsInSandbox();
    expect(Array.isArray(jobs)).toBe(true);
  });

  test("agent dir without jobs/ subdir is skipped", async () => {
    // publisher/ exists but has no jobs/ subdirectory
    await mkdir(join(AGENTS_DIR, "publisher"), { recursive: true });
    const jobs = await loadJobsInSandbox();
    expect(jobs.filter((j) => j.name.startsWith("publisher/"))).toEqual([]);
  });

  test("job file without schedule: field is skipped gracefully", async () => {
    await writeFile(
      join(AGENTS_DIR, "suzy", "jobs", "bad.md"),
      "---\nprompt: test\n---\nNo schedule line.\n"
    );
    // Should not throw, should return other valid jobs
    const jobs = await loadJobsInSandbox();
    expect(jobs.find((j) => j.name === "suzy/bad")).toBeUndefined();
  });
});

// ─── Unit: Job type and session path assertions ───────────────────────────

describe("Job type", () => {
  test("includes agent, label, enabled fields", () => {
    const job: import("../jobs").Job = {
      name: "agent/job",
      schedule: "0 9 * * *",
      prompt: "test",
      recurring: true,
      notify: true,
      agent: "myagent",
      label: "myjob",
      enabled: true,
    };
    expect(job.agent).toBe("myagent");
    expect(job.label).toBe("myjob");
    expect(job.enabled).toBe(true);
  });
});

describe("sessions — agent-scoped paths", () => {
  test("getSession/createSession/incrementTurn accept optional agentName", async () => {
    const src = await Bun.file(join(import.meta.dir, "../sessions.ts")).text();
    // All public functions should have agentName? param
    expect(src).toContain("getSession(\n  agentName?: string");
    expect(src).toContain("createSession(sessionId: string, agentName?: string)");
    expect(src).toContain("incrementTurn(agentName?: string)");
    expect(src).toContain("markCompactWarned(agentName?: string)");
  });

  test("agent sessions stored outside .claude/", async () => {
    const src = await Bun.file(join(import.meta.dir, "../sessions.ts")).text();
    // Verify path uses getAgentsDir() (project root) not HEARTBEAT_DIR (.claude/...)
    expect(src).toContain('join(getAgentsDir(), agentName, "session.json")');
  });

  test("fallback sessions can be scoped by thread id", async () => {
    const sessionsSrc = await Bun.file(join(import.meta.dir, "../sessions.ts")).text();
    const runnerSrc = await Bun.file(join(import.meta.dir, "../runner.ts")).text();
    const discordSrc = await Bun.file(join(import.meta.dir, "../commands/discord.ts")).text();

    expect(sessionsSrc).toContain('join(HEARTBEAT_DIR, "fallback-sessions", `${encodeURIComponent(threadId)}.json`)');
    expect(sessionsSrc).toContain("getFallbackSession(\n  agentName?: string,\n  threadId?: string");
    expect(runnerSrc).toContain("getFallbackSession(agentName, threadId)");
    expect(runnerSrc).toContain("createFallbackSession(exec.sessionId, agentName, threadId)");
    expect(discordSrc).toContain("resetFallbackSession(undefined, interaction.channel_id!)");
  });
});

// ─── Unit: protection-bug validation (the core motivation) ───────────────

describe("write-protection bug validation", () => {
  test("agent-scoped job path is outside .claude/ (key property)", () => {
    // The Claude Code CLI hardcodes a protection list for .claude/ paths.
    // Agent-scoped jobs live at agents/<name>/jobs/<job>.md — no .claude/ prefix.
    // This test documents the requirement explicitly.
    const legacyPath = join(process.cwd(), ".claude", "claudeclaw", "jobs", "job.md");
    const agentPath = join(process.cwd(), "agents", "suzy", "jobs", "daily.md");
    expect(legacyPath).toContain("/.claude/");
    expect(agentPath).not.toContain("/.claude/");
  });
});

// ─── Unit: reuse_session frontmatter parsing ─────────────────────────────

describe("parseJobFile — reuse_session", () => {
  beforeEach(resetSandbox);

  test("reuse_session: true → reuseSession === true", async () => {
    await writeFile(
      join(LEGACY_JOBS_DIR, "r1.md"),
      jobMd("0 1 * * *", "test prompt", "reuse_session: true")
    );
    const jobs = await loadJobsInSandbox();
    const job = jobs.find((j) => j.name === "r1");
    expect(job).toBeDefined();
    expect(job?.reuseSession).toBe(true);
  });

  test("reuse_session: yes → reuseSession === true", async () => {
    await writeFile(
      join(LEGACY_JOBS_DIR, "r2.md"),
      jobMd("0 1 * * *", "test prompt", "reuse_session: yes")
    );
    const jobs = await loadJobsInSandbox();
    const job = jobs.find((j) => j.name === "r2");
    expect(job?.reuseSession).toBe(true);
  });

  test("reuse_session: 1 → reuseSession === true", async () => {
    await writeFile(
      join(LEGACY_JOBS_DIR, "r3.md"),
      jobMd("0 1 * * *", "test prompt", "reuse_session: 1")
    );
    const jobs = await loadJobsInSandbox();
    const job = jobs.find((j) => j.name === "r3");
    expect(job?.reuseSession).toBe(true);
  });

  test("reuse_session absent → reuseSession === false", async () => {
    await writeFile(
      join(LEGACY_JOBS_DIR, "r4.md"),
      jobMd("0 1 * * *", "test prompt")
    );
    const jobs = await loadJobsInSandbox();
    const job = jobs.find((j) => j.name === "r4");
    expect(job?.reuseSession).toBe(false);
  });

  test("reuse_session: false → reuseSession === false", async () => {
    await writeFile(
      join(LEGACY_JOBS_DIR, "r5.md"),
      jobMd("0 1 * * *", "test prompt", "reuse_session: false")
    );
    const jobs = await loadJobsInSandbox();
    const job = jobs.find((j) => j.name === "r5");
    expect(job?.reuseSession).toBe(false);
  });

  test("reuse_session: no → reuseSession === false", async () => {
    await writeFile(
      join(LEGACY_JOBS_DIR, "r6.md"),
      jobMd("0 1 * * *", "test prompt", "reuse_session: no")
    );
    const jobs = await loadJobsInSandbox();
    const job = jobs.find((j) => j.name === "r6");
    expect(job?.reuseSession).toBe(false);
  });
});

// ─── Unit: buildJobThreadId ───────────────────────────────────────────────

describe("buildJobThreadId", () => {
  const RUN_ID = "20260522140300";

  test("reuseSession=true → returns base unchanged", () => {
    expect(buildJobThreadId("daily", true, RUN_ID)).toBe("daily");
  });

  test("reuseSession=false → returns base:runId", () => {
    expect(buildJobThreadId("daily", false, RUN_ID)).toBe("daily:20260522140300");
  });

  test("reuseSession=true with agent base → returns base unchanged", () => {
    expect(buildJobThreadId("agent:mike", true, RUN_ID)).toBe("agent:mike");
  });

  test("reuseSession=false with complex base → base:runId", () => {
    expect(buildJobThreadId("every-1m", false, RUN_ID)).toBe("every-1m:20260522140300");
  });
});

// ─── Unit: selectThreadsToKeep (pure prune logic) ────────────────────────

function makeThread(threadId: string, lastUsedAt: string): ThreadSession {
  return {
    sessionId: `session-${threadId}`,
    threadId,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt,
    turnCount: 1,
    compactWarned: false,
  };
}

describe("selectThreadsToKeep", () => {
  test("keeps the 25 newest foo:* entries when given 30, drops the 5 oldest", () => {
    const threads: Record<string, ThreadSession> = {};
    // Create 30 foo:* entries with ascending lastUsedAt timestamps
    for (let i = 0; i < 30; i++) {
      const id = `foo:2026052214${String(i).padStart(4, "0")}`;
      const ts = new Date(2026, 4, 22, 14, i, 0).toISOString();
      threads[id] = makeThread(id, ts);
    }
    const result = selectThreadsToKeep(threads, "foo", 25);
    const kept = Object.keys(result).filter((k) => k.startsWith("foo:"));
    expect(kept).toHaveLength(25);
    // The 5 oldest (i=0..4) should be dropped
    for (let i = 0; i < 5; i++) {
      const id = `foo:2026052214${String(i).padStart(4, "0")}`;
      expect(result[id]).toBeUndefined();
    }
    // The 25 newest (i=5..29) should be kept
    for (let i = 5; i < 30; i++) {
      const id = `foo:2026052214${String(i).padStart(4, "0")}`;
      expect(result[id]).toBeDefined();
    }
  });

  test("unrelated Discord snowflake threads are untouched", () => {
    const threads: Record<string, ThreadSession> = {};
    // Add a Discord snowflake
    threads["123456789012345678"] = makeThread("123456789012345678", "2026-05-22T00:00:00.000Z");
    // Add 30 foo:* entries
    for (let i = 0; i < 30; i++) {
      const id = `foo:${String(i).padStart(14, "0")}`;
      threads[id] = makeThread(id, new Date(2026, 0, 1, 0, i, 0).toISOString());
    }
    const result = selectThreadsToKeep(threads, "foo", 25);
    // Snowflake must survive
    expect(result["123456789012345678"]).toBeDefined();
    // Only 25 foo:* remain
    expect(Object.keys(result).filter((k) => k.startsWith("foo:")).length).toBe(25);
  });

  test("other job threads (bar:*) are untouched", () => {
    const threads: Record<string, ThreadSession> = {};
    threads["bar:20260101000000"] = makeThread("bar:20260101000000", "2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 30; i++) {
      const id = `foo:${String(i).padStart(14, "0")}`;
      threads[id] = makeThread(id, new Date(2026, 0, 1, 0, i, 0).toISOString());
    }
    const result = selectThreadsToKeep(threads, "foo", 25);
    expect(result["bar:20260101000000"]).toBeDefined();
    expect(Object.keys(result).filter((k) => k.startsWith("foo:")).length).toBe(25);
  });

  test("fewer than keep entries → all kept", () => {
    const threads: Record<string, ThreadSession> = {};
    for (let i = 0; i < 10; i++) {
      const id = `foo:${String(i).padStart(14, "0")}`;
      threads[id] = makeThread(id, new Date(2026, 0, 1, 0, i, 0).toISOString());
    }
    const result = selectThreadsToKeep(threads, "foo", 25);
    expect(Object.keys(result).filter((k) => k.startsWith("foo:")).length).toBe(10);
  });

  test("exact base name match (reuseSession=true, no colon) included in pruning", () => {
    const threads: Record<string, ThreadSession> = {};
    // 1 stable thread (base name, no colon) + 29 per-run
    threads["foo"] = makeThread("foo", "2026-01-01T00:00:00.000Z"); // oldest
    for (let i = 0; i < 29; i++) {
      const id = `foo:${String(i + 1).padStart(14, "0")}`;
      threads[id] = makeThread(id, new Date(2026, 0, 1, 0, i + 1, 0).toISOString());
    }
    // Total 30 entries, keep 25 → oldest 5 dropped (foo base + 4 per-run with lowest i)
    const result = selectThreadsToKeep(threads, "foo", 25);
    const fooKeys = Object.keys(result).filter((k) => k === "foo" || k.startsWith("foo:"));
    expect(fooKeys).toHaveLength(25);
    // "foo" was the oldest, should be dropped
    expect(result["foo"]).toBeUndefined();
  });

  test("prefix boundary: foobar and foobar:* are NOT matched by base foo", () => {
    const threads: Record<string, ThreadSession> = {};
    // foo and foo:* threads — all recent so all should be kept
    threads["foo"] = makeThread("foo", "2026-05-22T10:00:00.000Z");
    threads["foo:1"] = makeThread("foo:1", "2026-05-22T10:01:00.000Z");
    threads["foo:2"] = makeThread("foo:2", "2026-05-22T10:02:00.000Z");
    // foobar and foobar:* threads — completely unrelated to base "foo"
    threads["foobar"] = makeThread("foobar", "2026-05-22T10:03:00.000Z");
    threads["foobar:9"] = makeThread("foobar:9", "2026-05-22T10:04:00.000Z");

    // keep=10 is large enough to retain all foo/foo:* threads, so none should be pruned
    const result = selectThreadsToKeep(threads, "foo", 10);

    // all foo/* threads are kept
    expect(result["foo"]).toBeDefined();
    expect(result["foo:1"]).toBeDefined();
    expect(result["foo:2"]).toBeDefined();
    // foobar and foobar:9 are unrelated — must survive untouched
    expect(result["foobar"]).toBeDefined();
    expect(result["foobar:9"]).toBeDefined();
  });
});
