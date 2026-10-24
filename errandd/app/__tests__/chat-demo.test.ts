import { afterEach, describe, expect, test } from "bun:test";
import { HttpAgent } from "@ag-ui/client";
import { aguiRun } from "../ui/routes/agui";
import { scriptedAgui } from "../ui/routes/demos";
import type { RouteCtx } from "../ui/routes/types";
import { extractConversationPrompt } from "../ui/agui";
import { ClaudeRuntime } from "../runtime/claude";
import {
  registerRuntime,
  resetRuntimeCache,
  resolveRuntime,
  unregisterRuntime,
} from "../runtime/registry";

function context(): RouteCtx {
  return {
    opts: {
      getSnapshot: () => ({
        settings: {
          model: "",
          api: "",
          security: { level: "moderate", allowedTools: [], disallowedTools: [] },
        },
      }),
    },
  } as unknown as RouteCtx;
}
function client(agentId = "default", prompt = "Show me the routine") {
  const handler = agentId === "live" ? aguiRun : scriptedAgui;
  return new HttpAgent({
    url: "http://localhost/api/demos/agui",
    fetch: async (url, init) => {
      const response = await handler({
        ...context(),
        req: new Request(url, init),
        url: new URL(url),
      });
      if (!response) throw new Error("Missing AG-UI response");
      return response;
    },
    initialMessages: [{ id: crypto.randomUUID(), role: "user", content: prompt }],
  });
}
afterEach(() => {
  unregisterRuntime("demo-test");
  resetRuntimeCache();
});

describe("local AG-UI demo integration", () => {
  test("official AG-UI client accepts scripted streaming, tools and a follow-up", async () => {
    const agent = client();
    await agent.runAgent();
    const messages = JSON.stringify(agent.messages);
    expect(messages).toContain("inspect_routine");
    expect(messages).toContain("User turn 1");
    expect(messages).toContain("```typescript");
    agent.addMessage({ id: crypto.randomUUID(), role: "user", content: "And the follow-up?" });
    await agent.runAgent();
    expect(JSON.stringify(agent.messages)).toContain("User turn 2");
  }, 15000);
  test("scripted failures become framework run errors", async () => {
    const agent = client("default", "/error");
    let message = "";
    await agent.runAgent(
      {},
      {
        onRunErrorEvent: ({ event }) => {
          message = event.message;
        },
      },
    );
    expect(message).toContain("Scripted failure");
  });
  test("live adapter uses the real AG-UI route directly", async () => {
    const runtime = new ClaudeRuntime();
    const wire = [
      {
        type: "assistant",
        message: {
          id: "tool-message",
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "README.md" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "read complete" }],
        },
      },
      {
        type: "assistant",
        message: { id: "answer", content: [{ type: "text", text: "Live adapter OK" }] },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    runtime.spawn = () =>
      Bun.spawn([process.execPath, "-e", `console.log(${JSON.stringify(wire)})`], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    registerRuntime("demo-test", () => runtime);
    resetRuntimeCache();
    resolveRuntime(() => "demo-test");
    const agent = client("live");
    await agent.runAgent();
    expect(JSON.stringify(agent.messages)).toContain("Live adapter OK");
    expect(JSON.stringify(agent.messages)).toContain("read complete");
  });
});

test("stateless runs retain framework-supplied conversation context", () => {
  expect(extractConversationPrompt({ messages: [{ role: "user", content: "Hello" }] })).toBe(
    "Hello",
  );
  const prompt = extractConversationPrompt({
    messages: [
      { role: "user", content: "Remember sepia" },
      { role: "assistant", content: "Remembered" },
      { role: "user", content: "Which color?" },
    ],
  });
  expect(prompt).toContain("Remember sepia");
  expect(prompt).toContain("Which color?");
  expect(
    extractConversationPrompt({
      prompt: "Explicit",
      messages: [{ role: "user", content: "Ignored" }],
    }),
  ).toBe("Explicit");
});
