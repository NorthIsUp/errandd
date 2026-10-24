import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { workflowDemoEvents } from "./workflowDemo";
import { NOTICE_ACTIVITY } from "../../../shared/chatAnnotations";

function toolEvents(
  name: string,
  args: Record<string, unknown>,
  output: Record<string, unknown>,
): BaseEvent[] {
  const toolCallId = crypto.randomUUID();
  return [
    { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: name },
    { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(args) },
    { type: EventType.TOOL_CALL_END, toolCallId },
    {
      type: EventType.TOOL_CALL_RESULT,
      messageId: crypto.randomUUID(),
      toolCallId,
      role: "tool",
      content: JSON.stringify(output),
    },
  ];
}

/** Deterministic AG-UI server fixture: no models, external calls or job runs. */
export function scriptedChatResponse(input: RunAgentInput, delayMs = 35): Response {
  const messageId = crypto.randomUUID();
  const count = input.messages.filter((message) => message.role === "user").length;
  const last = input.messages.filter((message) => message.role === "user").at(-1);
  const content = last && typeof last.content === "string" ? last.content : "";
  const workflow = workflowDemoEvents(input);
  const events: BaseEvent[] = workflow ?? [
    { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
  ];
  if (!workflow) {
    if (/^\/?error\b/i.test(content.trim())) {
      events.push({
        type: EventType.RUN_ERROR,
        message: "Scripted failure. Start a new chat or send another message to try again.",
      });
    } else {
      events.push(
        ...toolEvents(
          "inspect_routine",
          { routine: "pr-review", mode: "preview" },
          { status: "ready", checks: 3, changedFiles: ["app/runner.ts", "web/demos/App.tsx"] },
        ),
        ...toolEvents(
          "Bash",
          { command: "git diff --stat", description: "Inspect changed files" },
          { text: "app/runner.ts | 8 ++++----\n1 file changed, 4 insertions(+), 4 deletions(-)" },
        ),
        ...toolEvents(
          "Bash",
          {
            command: "gh pr view 4056 --json number,title,author,labels",
            description: "Inspect PR metadata",
          },
          {
            text: '  {"number":4056,"title":"Reorder checkout","author":{"login":"preview-reviewer"},"labels":[{"name":"maintenance"}]}\n',
          },
        ),
        ...toolEvents(
          "Bash",
          { command: "cat missing-file.md", description: "Read a missing file" },
          {
            text: "cat: missing-file.md: No such file or directory",
            error: "Exit code 1: missing-file.md does not exist",
          },
        ),
        { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
      );
      const answer = `### Routine review\n\nThis is a **scripted preview** of a completed agent turn. No jobs or model calls ran.\n\n| Check | Result |\n| --- | --- |\n| Routine configuration | Ready |\n| Tool output | Rendered by the chat framework |\n| Conversation | User turn ${count} |\n\n\`\`\`typescript\nconst agent = new HttpAgent({ url: "/api/agui" });\n\`\`\`\n\n<details><summary>Webhook details</summary><p>Action: edited<br>Author: preview[bot]</p></details>\n\nTry a follow-up to see another turn, copy this response, or send **/error** to test failure handling.\n`;
      const chunks = answer.match(/[\s\S]{1,32}/g) ?? [answer];
      for (const delta of chunks)
        events.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta });
      events.push(
        { type: EventType.TEXT_MESSAGE_END, messageId },
        {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: crypto.randomUUID(),
          activityType: NOTICE_ACTIVITY,
          content: {
            kind: "fyi",
            title: "FYI · display only",
            body: "This card comes from an AG-UI activity event and stays outside model context.",
          },
        },
        { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId },
      );
    }
  }
  const encoder = new TextEncoder();
  let cancelled = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const event of events) {
          if (cancelled) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            return; // The framework stopped the run while a frame was pending.
          }
          if (delayMs) await Bun.sleep(delayMs);
        }
        if (!cancelled) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    },
  );
}
