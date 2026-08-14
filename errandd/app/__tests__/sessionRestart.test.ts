import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";

// sessionManager binds its state dir to process.cwd() at module load, so the
// restart flow is exercised in a child bun process rooted at a sandbox cwd —
// same pattern as sessions-concurrency.test.ts.

const TEST_ROOT = join(import.meta.dir, "../../test-sandbox-session-restart");
const SESSION_MGR = JSON.stringify(join(import.meta.dir, "..", "sessionManager"));

async function resetSandbox() {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(join(TEST_ROOT, ".claude", "errandd"), { recursive: true });
}

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(resetSandbox);

async function runInSandbox(body: string): Promise<Record<string, unknown>> {
  const script = `
import {
  createThreadSession,
  incrementThreadTurn,
  maybeRestartThreadSession,
  peekPendingRestart,
  peekThreadSession,
  recordThreadTurnStats,
  getThreadRestartsSinceBoot,
} from ${SESSION_MGR};
const LIMITS = { maxTurns: 3, maxContextTokens: 200000 };
const out = await (async () => { ${body} })();
process.stdout.write(JSON.stringify(out));
`;
  const scriptPath = join(TEST_ROOT, "_run.ts");
  await writeFile(scriptPath, script);
  const proc = Bun.spawn(["bun", "run", scriptPath], {
    cwd: TEST_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  if (!stdout) throw new Error(`sandbox produced no output: ${stderr}`);
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("bounded session reuse", () => {
  test("a thread under its caps keeps resuming the same session", async () => {
    const r = await runInSandbox(`
      await createThreadSession("t", "SESSION-A");
      await incrementThreadTurn("t");
      const restart = await maybeRestartThreadSession("t", LIMITS);
      const after = await peekThreadSession("t");
      return { restart, sessionId: after?.sessionId, restarts: getThreadRestartsSinceBoot() };
    `);
    expect(r.restart).toBeNull();
    expect(r.sessionId).toBe("SESSION-A");
    expect(r.restarts).toBe(0);
  });

  test("hitting the turn cap drops the mapping and stages a carryover", async () => {
    const r = await runInSandbox(`
      await createThreadSession("t", "SESSION-A");
      for (let i = 0; i < 3; i++) {
        await incrementThreadTurn("t");
        await recordThreadTurnStats("t", { summary: "pass " + i + ": replied to a comment" });
      }
      const restart = await maybeRestartThreadSession("t", LIMITS);
      return {
        reason: restart?.reason,
        generation: restart?.generation,
        previousSessionId: restart?.previousSessionId,
        previousTurns: restart?.previousTurns,
        carryover: restart?.carryover,
        // The mapping is gone, so the next run starts FRESH rather than resuming.
        stillMapped: (await peekThreadSession("t")) !== null,
        restarts: getThreadRestartsSinceBoot(),
      };
    `);
    expect(r.reason).toBe("turns");
    expect(r.generation).toBe(1);
    expect(r.previousSessionId).toBe("SESSION-A");
    expect(r.previousTurns).toBe(3);
    expect(r.stillMapped).toBe(false);
    expect(r.restarts).toBe(1);
    // Newest-first: the last pass leads the carried-forward digest.
    expect(r.carryover as string).toContain("pass 2: replied to a comment");
    expect(r.carryover as string).toContain("pass 0: replied to a comment");
  });

  test("a big single turn trips the context cap before the turn cap does", async () => {
    const r = await runInSandbox(`
      await createThreadSession("t", "SESSION-A");
      await recordThreadTurnStats("t", { contextTokens: 729000, summary: "one huge pass" });
      const restart = await maybeRestartThreadSession("t", LIMITS);
      return { reason: restart?.reason, ctx: restart?.previousContextTokens };
    `);
    expect(r.reason).toBe("context");
    expect(r.ctx).toBe(729000);
  });

  test("the restart is idempotent until the replacement session exists", async () => {
    // The queue drain and runJob both consult it for the same run; the second
    // call must not double-count or re-stage a different carryover.
    const r = await runInSandbox(`
      await createThreadSession("t", "SESSION-A");
      for (let i = 0; i < 3; i++) await incrementThreadTurn("t");
      const first = await maybeRestartThreadSession("t", LIMITS);
      const second = await maybeRestartThreadSession("t", LIMITS);
      return {
        same: first?.carryover === second?.carryover && first?.generation === second?.generation,
        restarts: getThreadRestartsSinceBoot(),
        pendingAfter: peekPendingRestart("t") !== null,
      };
    `);
    expect(r.same).toBe(true);
    expect(r.restarts).toBe(1);
    expect(r.pendingAfter).toBe(true);
  });

  test("the new session inherits the generation and drops the carryover + digest", async () => {
    const r = await runInSandbox(`
      await createThreadSession("t", "SESSION-A");
      for (let i = 0; i < 3; i++) {
        await incrementThreadTurn("t");
        await recordThreadTurnStats("t", { contextTokens: 150000, summary: "old work " + i });
      }
      await maybeRestartThreadSession("t", LIMITS);
      await createThreadSession("t", "SESSION-B");
      const row = await peekThreadSession("t");
      return {
        sessionId: row?.sessionId,
        generation: row?.generation,
        turnCount: row?.turnCount,
        restartedAt: typeof row?.restartedAt === "string",
        // Counters reset with the session — otherwise the fresh session would be
        // restarted again on its very first turn.
        contextTokens: row?.contextTokens ?? 0,
        digest: row?.digest ?? [],
        pendingCleared: peekPendingRestart("t") === null,
        restartAgain: await maybeRestartThreadSession("t", LIMITS),
      };
    `);
    expect(r.sessionId).toBe("SESSION-B");
    expect(r.generation).toBe(1);
    expect(r.turnCount).toBe(0);
    expect(r.restartedAt).toBe(true);
    expect(r.contextTokens).toBe(0);
    expect(r.digest).toEqual([]);
    expect(r.pendingCleared).toBe(true);
    expect(r.restartAgain).toBeNull();
  });

  test("generations keep counting across repeated restarts", async () => {
    const r = await runInSandbox(`
      await createThreadSession("t", "S1");
      for (let i = 0; i < 3; i++) await incrementThreadTurn("t");
      const g1 = await maybeRestartThreadSession("t", LIMITS);
      await createThreadSession("t", "S2");
      for (let i = 0; i < 3; i++) await incrementThreadTurn("t");
      const g2 = await maybeRestartThreadSession("t", LIMITS);
      return { g1: g1?.generation, g2: g2?.generation, restarts: getThreadRestartsSinceBoot() };
    `);
    expect(r.g1).toBe(1);
    expect(r.g2).toBe(2);
    expect(r.restarts).toBe(2);
  });

  test("caps of 0 leave a thread unbounded", async () => {
    const r = await runInSandbox(`
      await createThreadSession("t", "SESSION-A");
      for (let i = 0; i < 50; i++) await incrementThreadTurn("t");
      await recordThreadTurnStats("t", { contextTokens: 900000 });
      const restart = await maybeRestartThreadSession("t", { maxTurns: 0, maxContextTokens: 0 });
      return { restart, sessionId: (await peekThreadSession("t"))?.sessionId };
    `);
    expect(r.restart).toBeNull();
    expect(r.sessionId).toBe("SESSION-A");
  });

  test("a thread with no session at all is a no-op", async () => {
    const r = await runInSandbox(`
      return { restart: await maybeRestartThreadSession("never-seen", LIMITS) };
    `);
    expect(r.restart).toBeNull();
  });

  test("the digest survives a fold from disk (it round-trips through the jsonl log)", async () => {
    const r = await runInSandbox(`
      const { __resetSessionCacheForTests } = await import(${SESSION_MGR});
      await createThreadSession("t", "SESSION-A");
      await recordThreadTurnStats("t", { contextTokens: 4242, summary: "wrote the fix" });
      __resetSessionCacheForTests();
      const row = await peekThreadSession("t");
      return { digest: row?.digest ?? [], contextTokens: row?.contextTokens ?? 0 };
    `);
    expect(r.digest).toEqual(["wrote the fix"]);
    expect(r.contextTokens).toBe(4242);
  });
});
