import { describe, expect, test } from "bun:test";
import { HttpAgent } from "@ag-ui/client";
import { chat } from "../ui/routes/chat";
import type { RouteCtx } from "../ui/routes/types";
import type { StartWebUiOptions } from "../ui/types";

function context(body: unknown, onChat: StartWebUiOptions["onChat"]): RouteCtx {
  return {
    req: new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify(body) }),
    url: new URL("http://localhost/api/chat"),
    opts: {
      host: "localhost",
      port: 0,
      token: "",
      getSnapshot: () => {
        throw new Error("unused");
      },
      onChat,
    },
    sseResponse: () => {
      throw new Error("unused");
    },
  };
}

async function events(response: Response | null): Promise<Record<string, unknown>[]> {
  expect(response?.headers.get("Content-Type")).toBe("text/event-stream");
  return (await response!.text())
    .trim()
    .split("\n\n")
    .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>);
}

describe("chat AG-UI transport", () => {
  test("assistant-ui's stock client talks directly to the daemon chat API", async () => {
    const agent = new HttpAgent({
      url: "http://localhost/api/chat",
      initialMessages: [{ id: "user", role: "user", content: "hello" }],
      fetch: async (_url, init) => {
        const input = (await new Request("http://localhost/api/chat", init).json()) as unknown;
        const response = await chat(
          context(input, async (_message, chunk) => {
            chunk("Local daemon reply");
          }),
        );
        if (!response) throw new Error("Missing daemon response");
        return response;
      },
    });
    await agent.runAgent();
    expect(JSON.stringify(agent.messages)).toContain("Local daemon reply");
  });
  test("accepts RunAgentInput and preserves text, unblock and agent notifications", async () => {
    let received = "";
    const response = await chat(
      context(
        { threadId: "chat", runId: "r1", messages: [{ role: "user", content: "hello" }] },
        async (message, chunk, unblock, agent) => {
          received = message;
          chunk("First ");
          unblock();
          agent({ type: "spawn", id: "a1", description: "Review" });
          agent({ type: "done", id: "a1", description: "Review", result: "OK" });
          chunk("reply");
        },
      ),
    );
    const result = await events(response);
    expect(received).toBe("hello");
    expect(result.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "CUSTOM",
      "CUSTOM",
      "CUSTOM",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(result[0]).toMatchObject({ threadId: "chat", runId: "r1" });
    expect(result[3]).toMatchObject({ name: "errandd.unblock" });
    expect(result[5]).toMatchObject({
      name: "errandd.agent_done",
      value: { id: "a1", result: "OK" },
    });
    expect(result[1].messageId).toBe(result[6].messageId);
  });

  test("failure emits RUN_ERROR without reporting a successful finish", async () => {
    const response = await chat(
      context({ message: "hello" }, async () => {
        throw new Error("agent failed");
      }),
    );
    const result = await events(response);
    expect(result.at(-1)).toMatchObject({ type: "RUN_ERROR", message: "Error: agent failed" });
    expect(result.some((e) => e.type === "RUN_FINISHED")).toBe(false);
  });

  test("still validates attachments before starting a run", async () => {
    let called = false;
    const response = await chat(
      context({ message: "hello", attachments: Array(6).fill({}) }, async () => {
        called = true;
      }),
    );
    expect(response?.status).toBe(400);
    expect(called).toBe(false);
  });

  test("disconnect does not turn background notifications into unhandled errors", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let completed = false;
    const response = await chat(
      context({ message: "hello" }, async (_message, chunk) => {
        await gate;
        chunk("after disconnect");
        completed = true;
      }),
    );
    await response!.body!.cancel();
    release();
    await gate;
    await Promise.resolve();
    expect(completed).toBe(true);
  });
});
