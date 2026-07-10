import { test, expect, describe } from "bun:test";
import { ClaudeRuntime } from "../runtime/claude";
import { PiRuntime } from "../runtime/pi";
import type { RunSpec, Runtime, RuntimeBlock } from "../runtime/types";
import type { SecurityConfig } from "../config";

// ---------------------------------------------------------------------------
// Real-binary integration matrix — OPT-IN, skipped by default.
//
//   ERRANDD_E2E=1 bun test src/__tests__/runtime-e2e.test.ts
//
// runtime-matrix.test.ts proves both adapters normalize their *fixtures*
// identically. It cannot prove the fixtures match what the real CLI emits —
// that is precisely how the first Pi implementation passed a green check while
// speaking a schema Pi never emits.
//
// These tests close that hole by spawning the actual binary and asserting the
// SAME normalized invariants the matrix asserts. They are skipped unless:
//   * ERRANDD_E2E=1 is set, and
//   * the runtime's executable is on PATH (PI_EXECUTABLE respected for pi)
// so CI stays hermetic and offline. Each runtime also needs its own provider
// credentials; a missing key surfaces as a non-zero exit, which we report
// rather than silently pass.
// ---------------------------------------------------------------------------

const E2E = process.env.ERRANDD_E2E === "1";

/** Is `exe` runnable? Uses `which`, so PATH and absolute paths both work. */
function onPath(exe: string): boolean {
  try {
    return Bun.spawnSync(["which", exe]).exitCode === 0;
  } catch {
    return false;
  }
}

const security: SecurityConfig = { level: "moderate", allowedTools: [], disallowedTools: [] };

interface Case {
  name: string;
  rt: Runtime;
  /** Skip unless this resolves — keeps CI green without the binary. */
  available: () => boolean;
}

const MATRIX: Case[] = [
  {
    name: "claude",
    rt: new ClaudeRuntime(),
    available: () => onPath(new ClaudeRuntime().executablePath),
  },
  {
    name: "pi",
    rt: new PiRuntime(),
    available: () => onPath(new PiRuntime().executablePath),
  },
];

/** The magic word we ask the model to echo — short, unambiguous, cheap. */
const PONG = "errandd-e2e-pong";
const PROMPT = `Reply with exactly this text and nothing else: ${PONG}`;

/**
 * Model per runtime. Pi's default provider is `google`; this repo's daemon runs
 * on Anthropic, so pin a cheap Anthropic model for the live check. Override with
 * ERRANDD_E2E_MODEL_{CLAUDE,PI} to exercise another provider.
 */
const MODEL: Record<string, string> = {
  claude: process.env.ERRANDD_E2E_MODEL_CLAUDE ?? "",
  pi: process.env.ERRANDD_E2E_MODEL_PI ?? "anthropic/claude-haiku-4-5",
};

interface Observed {
  sessions: string[];
  blocks: RuntimeBlock[];
  resultText: string;
  contextTokens: number;
  exitCode: number;
  stderr: string;
}

async function driveRealRun(rt: Runtime, prompt: string = PROMPT): Promise<Observed> {
  const spec: RunSpec = {
    prompt,
    outputMode: "stream",
    model: MODEL[rt.id] ?? "",
    security,
    jobsRepoArgs: [],
  };
  const args = rt.buildRunArgs(spec);
  const proc = rt.spawn(args, rt.cleanSpawnEnv());

  const obs: Observed = { sessions: [], blocks: [], resultText: "", contextTokens: 0, exitCode: -1, stderr: "" };

  const parsing = rt.parseStream(proc.stdout, {
    onSession: (id) => void obs.sessions.push(id),
    onAssistant: (blocks) => void obs.blocks.push(...blocks),
    onResult: (ev) => {
      obs.resultText = ev.text;
      obs.contextTokens = ev.contextTokens;
    },
  });

  const stderrText = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
  const timer = setTimeout(() => {
    try { proc.kill(); } catch {}
  }, 120_000);

  await parsing;
  obs.stderr = await stderrText;
  await proc.exited;
  clearTimeout(timer);
  obs.exitCode = proc.exitCode ?? -1;
  return obs;
}

for (const { name, rt, available } of MATRIX) {
  const skip = !E2E || !available();

  describe.skipIf(skip)(`${name}: real binary`, () => {
    test(
      "a live run yields a session id and the echoed text through the normalized stream",
      async () => {
        const obs = await driveRealRun(rt);

        // Surface auth/config failures loudly instead of asserting on silence.
        expect(obs.exitCode, `stderr:\n${obs.stderr}`).toBe(0);

        // The invariants the seam promises, asserted against the REAL wire.
        expect(obs.sessions.length).toBeGreaterThan(0);
        expect(obs.sessions[0]).toBeTruthy();

        const text = obs.blocks
          .filter((b): b is Extract<RuntimeBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("");
        expect(text + obs.resultText).toContain(PONG);

        // Capability claims must hold against the real stream, not just fixtures.
        if (rt.capabilities.reportsContextTokens) {
          expect(obs.contextTokens).toBeGreaterThan(0);
        } else {
          expect(obs.contextTokens).toBe(0);
        }
      },
      180_000,
    );

    test(
      "resume replays into the same session when the runtime claims to support it",
      async () => {
        if (!rt.capabilities.supportsResume) return;
        const first = await driveRealRun(rt);
        expect(first.exitCode, `stderr:\n${first.stderr}`).toBe(0);
        const sessionId = first.sessions[0];

        const args = rt.buildRunArgs({
          prompt: "Reply with exactly: second",
          outputMode: "stream",
          model: MODEL[rt.id] ?? "",
          security,
          jobsRepoArgs: [],
          resumeSessionId: sessionId,
        });
        // The resume flag must actually appear — a runtime that claims resume
        // but drops the id would otherwise silently start a fresh session.
        expect(args).toContain(sessionId);

        const proc = rt.spawn(args, rt.cleanSpawnEnv());
        const seen: string[] = [];
        await rt.parseStream(proc.stdout, {
          onSession: (id) => void seen.push(id),
        });
        await proc.exited;
        expect(proc.exitCode).toBe(0);
        if (seen.length) expect(seen[0]).toBe(sessionId);
      },
      240_000,
    );
  });
}

// Always-on guard: if someone sets ERRANDD_E2E=1 with no binaries present, the
// suite would silently skip everything and look like it passed. Say so instead.
test("e2e opt-in reports which runtimes are actually exercised", () => {
  const present = MATRIX.filter((c) => c.available()).map((c) => c.name);
  if (!E2E) {
    expect(true).toBe(true); // opt-out: nothing to report
    return;
  }
   
  console.log(`[e2e] ERRANDD_E2E=1; binaries present: ${present.join(", ") || "(none)"}`);
  expect(present.length, "ERRANDD_E2E=1 but no runtime binary found on PATH").toBeGreaterThan(0);
});
