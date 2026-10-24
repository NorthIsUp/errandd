import { expect, test } from "bun:test";
import { HttpAgent } from "@ag-ui/client";
import { scriptedAgui } from "../ui/routes/demos";
import type { RouteCtx } from "../ui/routes/types";

const request = (body: string) =>
  scriptedAgui({
    req: new Request("http://localhost/api/demos/agui", { method: "POST", body }),
  } as RouteCtx);

test("assistant-ui's AG-UI client consumes the direct scripted endpoint and follows up", async () => {
  const agent = new HttpAgent({
    url: "http://localhost/api/demos/agui",
    initialMessages: [{ id: "user-1", role: "user", content: "Review my routine" }],
    fetch: async (_url, init) => {
      const response = await scriptedAgui({
        req: new Request("http://localhost/api/demos/agui", init),
      } as RouteCtx);
      if (!response) {
        throw new Error("Missing scripted response");
      }
      return response;
    },
  });
  await agent.runAgent();
  expect(JSON.stringify(agent.messages)).toContain("inspect_routine");
  expect(JSON.stringify(agent.messages)).toContain("Bash");
  expect(JSON.stringify(agent.messages)).toContain("missing-file.md does not exist");
  expect(JSON.stringify(agent.messages)).toContain("<details>");
  expect(JSON.stringify(agent.messages)).toContain("errandd.notice.v1");
  expect(JSON.stringify(agent.messages)).toContain("User turn 1");
  agent.addMessage({ id: "user-2", role: "user", content: "Follow up" });
  await agent.runAgent();
  expect(JSON.stringify(agent.messages)).toContain("User turn 2");
  agent.addMessage({ id: "user-3", role: "user", content: "/error" });
  let error = "";
  await agent.runAgent(
    {},
    {
      onRunErrorEvent: ({ event }) => {
        error = event.message;
      },
    },
  );
  expect(error).toContain("Scripted failure");
}, 15000);

test("direct scripted route rejects malformed bodies", async () => {
  for (const body of [
    "bad json",
    "null",
    "{}",
    JSON.stringify({ threadId: "t", runId: "r", messages: [null] }),
  ]) {
    const response = await request(body);
    expect(response?.status).toBe(400);
  }
});
