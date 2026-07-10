import { test, expect, afterAll, beforeEach } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";

// P0-10: the global session is process-wide mutable state shared by every
// per-thread execClaude run and the global stream run. Concurrent
// read-mutate-write sequences must not lose increments or clobber each other.
//
// HEARTBEAT_DIR in sessions.ts is bound to process.cwd() at module load, so we
// exercise the real file path inside a sandbox cwd via a child bun process
// (same pattern as jobs.test.ts).

const TEST_ROOT = join(import.meta.dir, "../../test-sandbox-sessions");
const SESSIONS_MOD = JSON.stringify(join(import.meta.dir, "..", "sessions"));

async function resetSandbox() {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(join(TEST_ROOT, ".claude", "errandd"), { recursive: true });
}

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(resetSandbox);

async function runInSandbox(script: string): Promise<string> {
  const scriptPath = join(TEST_ROOT, "_run.ts");
  await writeFile(scriptPath, script);
  const proc = Bun.spawn(["bun", "run", scriptPath], {
    cwd: TEST_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`child failed: ${err}`);
  return out.trim();
}

const N = 50;

test("concurrent incrementTurn calls all land (no lost updates)", async () => {
  const out = await runInSandbox(`
import { createSession, incrementTurn, peekSession } from ${SESSIONS_MOD};
await createSession("sess-1");
await Promise.all(Array.from({ length: ${N} }, () => incrementTurn()));
const s = await peekSession();
process.stdout.write(String(s?.turnCount));
`);
  expect(Number(out)).toBe(N);
});

test("concurrent incrementMessageCount calls all land", async () => {
  const out = await runInSandbox(`
import { createSession, incrementMessageCount, peekSession } from ${SESSIONS_MOD};
await createSession("sess-1");
await Promise.all(Array.from({ length: ${N} }, () => incrementMessageCount()));
const s = await peekSession();
process.stdout.write(String(s?.messageCount));
`);
  expect(Number(out)).toBe(N);
});

test("interleaved turn + message increments both reach N", async () => {
  const out = await runInSandbox(`
import { createSession, incrementTurn, incrementMessageCount, peekSession } from ${SESSIONS_MOD};
await createSession("sess-1");
const ops = [];
for (let i = 0; i < ${N}; i++) { ops.push(incrementTurn()); ops.push(incrementMessageCount()); }
await Promise.all(ops);
const s = await peekSession();
process.stdout.write(JSON.stringify({ turnCount: s?.turnCount, messageCount: s?.messageCount }));
`);
  expect(JSON.parse(out)).toEqual({ turnCount: N, messageCount: N });
});

test("increments from a pre-existing on-disk session (cold cache) all land", async () => {
  // The worst case: `current` starts null and concurrent calls each read the
  // file independently. Without serialization they read the same base value
  // and write back stale snapshots, losing updates.
  const sessionFile = join(TEST_ROOT, ".claude", "errandd", "session.json");
  await writeFile(
    sessionFile,
    JSON.stringify({
      sessionId: "sess-cold",
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      turnCount: 0,
      compactWarned: false,
      messageCount: 0,
    }) + "\n"
  );
  const out = await runInSandbox(`
import { incrementTurn, peekSession } from ${SESSIONS_MOD};
await Promise.all(Array.from({ length: ${N} }, () => incrementTurn()));
const s = await peekSession();
process.stdout.write(String(s?.turnCount));
`);
  expect(Number(out)).toBe(N);
});

test("getSession lastUsedAt bump does not drop a concurrent increment", async () => {
  // getSession rewrites the whole record (incl. lastUsedAt). Racing it against
  // incrementTurn must not clobber the increment.
  const out = await runInSandbox(`
import { createSession, incrementTurn, getSession, peekSession } from ${SESSIONS_MOD};
await createSession("sess-1");
const ops = [];
for (let i = 0; i < ${N}; i++) { ops.push(incrementTurn()); ops.push(getSession()); }
await Promise.all(ops);
const s = await peekSession();
process.stdout.write(String(s?.turnCount));
`);
  expect(Number(out)).toBe(N);
});
