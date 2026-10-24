import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { JOB_ACTIVITY, workflowStateSchema } from "../../../shared/workflowCards";

function textEvents(text: string, subagentRunId?: string): BaseEvent[] {
  const messageId = crypto.randomUUID();
  const scope = subagentRunId ? { subagentRunId } : {};
  return [
    { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", ...scope },
    ...Array.from(text.matchAll(/[\s\S]{1,48}/g), ([delta]) => ({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta,
      ...scope,
    })),
    { type: EventType.TEXT_MESSAGE_END, messageId, ...scope },
  ];
}
function toolStart(
  name: string,
  args: Record<string, unknown>,
  toolCallId: string,
  subagentRunId?: string,
): BaseEvent[] {
  const scope = subagentRunId ? { subagentRunId } : {};
  return [
    { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: name, ...scope },
    { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(args), ...scope },
    { type: EventType.TOOL_CALL_END, toolCallId, ...scope },
  ];
}
function toolResult(toolCallId: string, content: unknown, subagentRunId?: string): BaseEvent {
  return {
    type: EventType.TOOL_CALL_RESULT,
    toolCallId,
    messageId: crypto.randomUUID(),
    role: "tool",
    content: JSON.stringify(content),
    ...(subagentRunId ? { subagentRunId } : {}),
  };
}

/** The workflow is synthetic and stateless: the stock runtime round-trips its
 * state and interrupt response. No approval here authorizes an actual action. */
export function workflowDemoEvents(input: RunAgentInput): BaseEvent[] | null {
  const last = input.messages.filter((message) => message.role === "user").at(-1);
  const prompt = last && typeof last.content === "string" ? last.content : "";
  if (!input.resume?.length && !/\b(webhook|workflow|subagents)\b/i.test(prompt)) return null;
  const events: BaseEvent[] = [
    { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
  ];
  const state = workflowStateSchema.safeParse(input.state);
  if (input.resume?.length) {
    if (
      !state.success ||
      state.data.erranddDemo.status !== "waiting" ||
      !state.data.erranddDemo.interruptId ||
      !state.data.erranddDemo.decisionToolId ||
      input.resume.length !== 1 ||
      input.resume[0]?.interruptId !== state.data.erranddDemo.interruptId
    ) {
      return [
        ...events,
        {
          type: EventType.RUN_ERROR,
          message: "This preview decision is no longer pending. Start a new workflow.",
        },
      ];
    }
    const decision = input.resume[0];
    const payload = decision.payload as { approved?: unknown } | undefined;
    if (decision.status === "resolved" && typeof payload?.approved !== "boolean") {
      return [
        ...events,
        { type: EventType.RUN_ERROR, message: "Choose approve or decline for this preview." },
      ];
    }
    const approved = decision.status === "resolved" && payload?.approved === true;
    const job = state.data.erranddDemo;
    const status = approved ? "completed" : "declined";
    const stage = approved ? "Preview complete" : "Draft left unpublished";
    events.push(
      { type: EventType.STEP_STARTED, stepName: "Record decision" },
      toolResult(job.decisionToolId!, { approved, preview: true }),
      {
        type: EventType.STATE_DELTA,
        delta: [
          { op: "replace", path: "/erranddDemo/status", value: status },
          { op: "replace", path: "/erranddDemo/stage", value: stage },
          { op: "replace", path: "/erranddDemo/completed", value: 4 },
          { op: "remove", path: "/erranddDemo/interruptId" },
          { op: "remove", path: "/erranddDemo/decisionToolId" },
        ],
      },
      ...textEvents(
        approved
          ? `### Review approved\n\nYour decision resumed the same workflow. The draft is ready in this **scripted preview**; nothing was posted to GitHub.\n\n${job.detail === "full" ? "Both reviewers completed. The report covers the checkout ordering change, passing fixture checks, and the proposed schedule.\n\n" : ""}Result detail: **${job.detail}**.`
          : "### Draft kept unpublished\n\nYour decision resumed the workflow and declined the preview action. Nothing was posted to GitHub.",
      ),
      { type: EventType.STEP_FINISHED, stepName: "Record decision" },
      { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId },
    );
    return events;
  }
  const activityId = crypto.randomUUID();
  const decisionToolId = crypto.randomUUID();
  const interruptId = crypto.randomUUID();
  const job = {
    jobId: `preview-${input.runId}`,
    title: "PR review · incoming GitHub hook",
    provider: "GitHub",
    action: "edited",
    author: "preview[bot]",
    status: "received",
    stage: "Receive webhook",
    completed: 0,
  };
  events.push(
    ...textEvents(
      "I’ll inspect this incoming webhook, ask two reviewers to check it, and prepare a draft for your decision. This is a scripted preview.",
    ),
    {
      type: EventType.STATE_SNAPSHOT,
      snapshot: {
        erranddDemo: { ...job, detail: "full", activityId, decisionToolId, interruptId },
      },
    },
    {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: activityId,
      activityType: JOB_ACTIVITY,
      content: job,
    },
  );
  const phase = (status: string, stage: string, completed: number) => {
    events.push(
      {
        type: EventType.STATE_DELTA,
        delta: [
          { op: "replace", path: "/erranddDemo/status", value: status },
          { op: "replace", path: "/erranddDemo/stage", value: stage },
          { op: "replace", path: "/erranddDemo/completed", value: completed },
        ],
      },
      {
        type: EventType.ACTIVITY_DELTA,
        messageId: activityId,
        activityType: JOB_ACTIVITY,
        patch: [
          { op: "replace", path: "/status", value: status },
          { op: "replace", path: "/stage", value: stage },
          { op: "replace", path: "/completed", value: completed },
        ],
      },
    );
  };
  events.push({ type: EventType.STEP_STARTED, stepName: "Validate webhook" });
  phase("queued", "Validate webhook", 1);
  events.push({ type: EventType.STEP_FINISHED, stepName: "Validate webhook" });
  events.push({ type: EventType.STEP_STARTED, stepName: "Review changes" });
  phase("running", "Two reviewers checking changes", 2);
  const reviewers = [
    {
      name: "Code reviewer",
      command: "git diff -- .github/workflows/ci.yml",
      finding:
        "The fixture only reorders checkout before authentication. No application logic changed.",
    },
    {
      name: "Checks reviewer",
      command: "gh pr checks 4056",
      finding:
        "The fixture checks pass. The proposed routine runs every 15 minutes and waits while a human is actively pushing.",
    },
  ].map((reviewer) => ({
    ...reviewer,
    id: crypto.randomUUID(),
    toolId: crypto.randomUUID(),
    shellId: crypto.randomUUID(),
  }));
  for (const reviewer of reviewers) {
    events.push(...toolStart("delegate_review", { reviewer: reviewer.name }, reviewer.toolId), {
      type: EventType.SUBAGENT_STARTED,
      subagentRunId: reviewer.id,
      name: reviewer.name,
      description: "Scripted review worker",
      parentToolCallId: reviewer.toolId,
    });
  }
  for (const reviewer of reviewers) {
    events.push(
      ...toolStart("Bash", { command: reviewer.command }, reviewer.shellId, reviewer.id),
      toolResult(reviewer.shellId, { text: reviewer.finding }, reviewer.id),
      ...textEvents(reviewer.finding, reviewer.id),
      {
        type: EventType.SUBAGENT_FINISHED,
        subagentRunId: reviewer.id,
        result: { status: "complete" },
      },
      toolResult(reviewer.toolId, { reviewer: reviewer.name, status: "complete" }),
    );
  }
  events.push({ type: EventType.STEP_FINISHED, stepName: "Review changes" });
  events.push({ type: EventType.STEP_STARTED, stepName: "Prepare report" });
  const reportId = crypto.randomUUID();
  events.push(
    ...toolStart("review_report", { routine: "pr-review", schedule: "Every 15 minutes" }, reportId),
    toolResult(reportId, {
      title: "Review report · PR #4056",
      checks: [
        { name: "Workflow order", result: "Checkout precedes authentication" },
        { name: "CI checks", result: "Fixture checks passed" },
        { name: "Schedule", result: "Every 15 minutes · defer during human activity" },
      ],
      files: [".github/workflows/ci.yml"],
      diff: "-      - uses: google-github-actions/auth@v2\n       - uses: actions/checkout@v4\n+      - uses: google-github-actions/auth@v2",
      artifact: {
        name: "review-preview.md",
        text: "# PR #4056 review preview\n\nCheckout precedes authentication. Fixture checks passed.\nSchedule: every 15 minutes; defer during human activity.\n\nSynthetic demo: no commands ran and no comment was posted.\n",
      },
    }),
    { type: EventType.STEP_FINISHED, stepName: "Prepare report" },
  );
  phase("waiting", "Waiting for your decision", 3);
  events.push(
    ...toolStart(
      "review_decision",
      { action: "Publish the review draft (preview only)" },
      decisionToolId,
    ),
    {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: interruptId,
            reason: "tool_call",
            toolCallId: decisionToolId,
            message:
              "Approve this review draft? This only completes the demo; nothing will be posted.",
            responseSchema: {
              type: "object",
              properties: { approved: { type: "boolean" } },
              required: ["approved"],
            },
          },
        ],
      },
    },
  );
  return events;
}
