import { expect, test } from "bun:test";
import { EventType, HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { workflowDemoEvents } from "../ui/services/workflowDemo";
import { scriptedChatResponse } from "../ui/services/chatDemo";
import { workflowStateSchema } from "../../shared/workflowCards";

const input = (): RunAgentInput => ({
  threadId: "workflow-test",
  runId: "preview-run",
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
  messages: [{ id: "request", role: "user", content: "Review a webhook with subagents" }],
});

test("workflow uses attributed subagents, stable activity patches and explicit stages", () => {
  const events = workflowDemoEvents(input())!;
  const children = events.filter((event) => event.type === EventType.SUBAGENT_STARTED);
  expect(children).toHaveLength(2);
  const snapshots = events.filter((event) => event.type === EventType.ACTIVITY_SNAPSHOT);
  expect(snapshots).toHaveLength(1);
  const updates = events.filter((event) => event.type === EventType.ACTIVITY_DELTA);
  expect(updates).toHaveLength(3);
  expect(new Set([...snapshots, ...updates].map((event) => event.messageId)).size).toBe(1);
  expect(events.filter((event) => event.type === EventType.STEP_STARTED)).toHaveLength(3);
  for (const child of children) {
    expect(
      events.some(
        (event) =>
          event.type === EventType.TOOL_CALL_START && event.toolCallId === child.parentToolCallId,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === EventType.TEXT_MESSAGE_CONTENT &&
          event.subagentRunId === child.subagentRunId,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === EventType.SUBAGENT_FINISHED && event.subagentRunId === child.subagentRunId,
      ),
    ).toBe(true);
  }
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  expect(JSON.stringify(events.at(-1))).toContain('"type":"interrupt"');
});

for (const approved of [true, false]) {
  test(`stock client round-trips state and resumes a ${approved ? "approved" : "declined"} workflow`, async () => {
    const agent = new HttpAgent({
      url: "http://localhost/api/demos/agui",
      initialMessages: input().messages,
      fetch: async (_url, init) =>
        scriptedChatResponse(
          JSON.parse(typeof init?.body === "string" ? init.body : "{}") as RunAgentInput,
          0,
        ),
    });
    let interruptId = "";
    await agent.runAgent(
      {},
      {
        onRunFinishedEvent: ({ event }) => {
          if (event.outcome?.type === "interrupt") interruptId = event.outcome.interrupts[0].id;
        },
      },
    );
    expect(interruptId).not.toBe("");
    const shared = workflowStateSchema.parse(agent.state);
    expect(shared.erranddDemo.status).toBe("waiting");
    expect(shared.erranddDemo.completed).toBe(3);
    agent.setState({ erranddDemo: { ...shared.erranddDemo, detail: "summary" } });
    await agent.runAgent({ resume: [{ interruptId, status: "resolved", payload: { approved } }] });
    const settled = workflowStateSchema.parse(agent.state).erranddDemo;
    expect(settled.status).toBe(approved ? "completed" : "declined");
    expect(settled.completed).toBe(4);
    expect(settled.interruptId).toBeUndefined();
    expect(JSON.stringify(agent.messages)).toContain(
      approved ? "Review approved" : "Draft kept unpublished",
    );
    if (approved) expect(JSON.stringify(agent.messages)).toContain("summary");
  });
}

test("unknown workflow decisions fail without completing the preview", () => {
  const request = {
    ...input(),
    resume: [{ interruptId: "stale", status: "resolved" as const, payload: { approved: true } }],
  };
  expect(workflowDemoEvents(request)?.at(-1)?.type).toBe(EventType.RUN_ERROR);
  expect(
    workflowDemoEvents({ ...input(), messages: [{ id: "simple", role: "user", content: "Hi" }] }),
  ).toBeNull();
});
