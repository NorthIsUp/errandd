import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Codex runs through the real runner: trust, model, auth, stream, resume, stale recovery and timeout", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "errandd-codex-runner-")));
  const app = join(import.meta.dir, "..");
  const executable = join(cwd, "codex-fixture");
  const capture = join(cwd, "calls.jsonl");
  try {
    await writeFile(executable, `#!${process.execPath}\n${await readFile(join(import.meta.dir, "fixtures/codex-cli.ts"), "utf8")}`);
    await chmod(executable, 0o755);
    await mkdir(join(cwd, ".claude/errandd"), { recursive: true });
    await mkdir(join(cwd, ".codex"));
    await writeFile(join(cwd, ".codex/models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-fixture-sol" }] }));
    await writeFile(join(cwd, ".claude/errandd/settings.json"), JSON.stringify({
      runtime: "claude", model: "sonnet", api: "anthropic-test-key",
      fallback: { model: "opus", api: "fallback-test-key" },
      security: { level: "locked" },
    }));
    const script = `
      import { loadSettings } from ${JSON.stringify(join(app, "config.ts"))};
      import { run } from ${JSON.stringify(join(app, "runner.ts"))};
      import { createThreadSession, peekThreadSession } from ${JSON.stringify(join(app, "sessionManager.ts"))};
      import { CodexRuntime } from ${JSON.stringify(join(app, "runtime/codex/index.ts"))};
      import { resolveJobModel } from ${JSON.stringify(join(app, "jobModels.ts"))};
      await loadSettings();
      const selected = resolveJobModel("openai/sol", "claude");
      const chunks = [], tools = [];
      const execute = (thread, prompt = "fixture-success", timeout = 5000) => run("test", prompt, thread, selected.model, timeout, undefined, "job", text => chunks.push(text), text => tools.push(text), { runtime: selected.runtime });
      const first = await execute("thread");
      const session = await peekThreadSession("thread");
      const second = await execute("thread");
      await createThreadSession("stale", "missing-session");
      const recovered = await execute("stale");
      const replaced = await peekThreadSession("stale");
      const failed = await execute("failed", "fixture-failure");
      const timed = await execute("timed", "fixture-timeout", 250);
      const runtime = new CodexRuntime();
      const oneShot = await runtime.runOneShot({ prompt: "fixture-success", timeoutMs: 5000 });
      const oneShotFailed = await runtime.runOneShot({ prompt: "fixture-failure", timeoutMs: 5000 });
      const oneShotTimed = await runtime.runOneShot({ prompt: "fixture-timeout", timeoutMs: 250 });
      const limited = await execute("limited", "fixture-rate-limit");
      console.log("RESULT " + JSON.stringify({ first, second, recovered, session, replaced, failed, timed, chunks, tools, oneShot, oneShotFailed, oneShotTimed, limited }));
      process.exit(0);
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, CODEX_HOME: join(cwd, ".codex"), CODEX_EXECUTABLE: executable, CODEX_API_KEY: "codex-test-key", ERRANDD_TEST_CODEX_CAPTURE: capture, ERRANDD_RUNTIME: "claude", ERRANDD_MODEL: "sonnet", ERRANDD_API: "anthropic-test-key" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode, stderr).toBe(0);
    const line = stdout.split("\n").find(value => value.startsWith("RESULT "));
    expect(line, stdout + stderr).toBeDefined();
    const result = JSON.parse(line!.slice(7)) as {
      first: { exitCode: number }; second: { exitCode: number }; recovered: { exitCode: number };
      session: { sessionId: string }; replaced: { sessionId: string }; failed: { exitCode: number; stderr: string };
      timed: { exitCode: number }; chunks: string[]; tools: string[];
      oneShot: { stdout: string; exitCode: number; timedOut: boolean };
      oneShotFailed: { stderr: string; exitCode: number }; oneShotTimed: { timedOut: boolean };
      limited: { exitCode: number; stderr: string };
    };
    expect([result.first.exitCode, result.second.exitCode, result.recovered.exitCode]).toEqual([0, 0, 0]);
    expect(result.session.sessionId).toBe("fixture-session-0");
    expect(result.replaced.sessionId).not.toBe("missing-session");
    expect(result.failed).toMatchObject({ exitCode: 7, stderr: "fixture child failed" });
    expect(result.timed.exitCode).toBe(124);
    expect(result.chunks.join("")).toContain("fixture reply");
    expect(result.tools.join("")).toContain("command_execution");
    expect(result.oneShot).toMatchObject({ stdout: "fixture reply\n", exitCode: 0, timedOut: false });
    expect(result.oneShotFailed).toMatchObject({ stderr: "fixture child failed\n", exitCode: 7 });
    expect(result.oneShotTimed.timedOut).toBe(true);
    expect(result.limited).toMatchObject({ exitCode: 1, stderr: "rate limit exceeded" });
    const calls = (await readFile(capture, "utf8")).trim().split("\n").map(value => JSON.parse(value) as { args: string[]; cwd: string; authMatches: boolean });
    expect(calls).toHaveLength(10);
    expect(calls.every(call => !call.args.includes("opus"))).toBe(true);
    expect(calls.every(call => call.authMatches && call.cwd === cwd)).toBe(true);
    expect(calls[0].args).toContain("gpt-fixture-sol");
    expect(calls[1].args).toContain(result.session.sessionId);
    expect(calls[2].args).toContain("missing-session");
    expect(calls[3].args).not.toContain("resume");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 20_000);
