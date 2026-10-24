import { afterEach, expect, test } from "bun:test";
import { ClaudeRuntime } from "../runtime/claude";
import {
  registerRuntime,
  resetRuntimeCache,
  resolveRuntime,
  unregisterRuntime,
} from "../runtime/registry";
import { aguiRun } from "../ui/routes/agui";
import type { RouteCtx } from "../ui/routes/types";

afterEach(() => {
  unregisterRuntime("test-agui");
  resetRuntimeCache();
});

function fakeRuntime(script: string): void {
  const runtime = new ClaudeRuntime();
  runtime.spawn = () =>
    Bun.spawn([process.execPath, "-e", script], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  registerRuntime("test-agui", () => runtime);
  resetRuntimeCache();
  resolveRuntime(() => "test-agui");
}

async function run(): Promise<Record<string, unknown>[]> {
  const response = await aguiRun({
    req: new Request("http://localhost/api/agui", {
      method: "POST",
      body: JSON.stringify({ prompt: "hello", threadId: "t", runId: "r" }),
    }),
    opts: {
      getSnapshot: () => ({
        settings: {
          model: "",
          api: "",
          security: { level: "moderate", allowedTools: [], disallowedTools: [] },
        },
      }),
    },
  } as unknown as RouteCtx);
  expect(response?.status).toBe(200);
  return (await response!.text())
    .trim()
    .split("\n\n")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

test("AG-UI route drains full stderr pipe and reports a failed subprocess", async () => {
  fakeRuntime('process.stderr.write("x".repeat(200000) + "failure marker"); process.exitCode = 7;');
  const events = await run();
  expect(events[0]).toMatchObject({ type: "RUN_STARTED", threadId: "t", runId: "r" });
  expect(events.at(-1)?.type).toBe("RUN_ERROR");
  expect(events.at(-1)?.message).toContain("failure marker");
  expect(String(events.at(-1)?.message).length).toBeLessThanOrEqual(8192);
  expect(events.some((e) => e.type === "RUN_FINISHED")).toBe(false);
});

test("AG-UI route finishes successful subprocesses", async () => {
  fakeRuntime(
    'console.log(JSON.stringify({type:"assistant", message:{id:"m", content:[{type:"text",text:"hello"}]}}));',
  );
  const events = await run();
  expect(events.find((e) => e.type === "TEXT_MESSAGE_CONTENT")?.delta).toBe("hello");
  expect(events.at(-1)).toMatchObject({
    type: "RUN_FINISHED",
    threadId: "t",
    runId: "r",
    result: "hello",
  });
});
