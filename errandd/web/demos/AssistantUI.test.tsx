import { expect, test } from "bun:test";
import { fromAgUiMessages } from "@assistant-ui/react-ag-ui";
import { renderToString } from "react-dom/server";
import { toAnnotatedMessages } from "../../shared/chatAnnotations";
import type { ChatExamples } from "../../shared/chatExamples";
import { AssistantTranscript } from "./AssistantUI";
import { toAssistantMessages } from "./assistantMessages";

const data: ChatExamples = {
  version: 1,
  sourceOrigin: "https://example.com",
  capturedAt: "2026-10-23T00:00:00Z",
  examples: [
    {
      id: "capture",
      title: "Example capture",
      threadId: "pr-review:hook:1",
      sourceUrl: "https://example.com/thread",
      totalParts: 4,
      sources: [{ href: "https://example.com/pr", label: "Pull request" }],
      parts: [
        {
          id: "hook",
          kind: "text",
          role: "user",
          markdown:
            "## Hook payload\n\n**author:** alice\n\n| Item | Status |\n| --- | --- |\n| PR | Ready |",
        },
        {
          id: "reply",
          kind: "text",
          role: "assistant",
          markdown: "### Review result\n\n- **Looks good**\n\n```ts\nconst ready = true;\n```",
        },
        { id: "notice", kind: "system", text: "Outside model context", notInContext: true },
        {
          id: "tool",
          kind: "tool",
          tool: {
            type: "Bash",
            toolCallId: "tool-1",
            state: "output-error",
            input: { command: "false" },
            errorText: "Command failed",
          },
        },
      ],
    },
  ],
};

test("assistant-ui renders captured Markdown, tools and typed activities read-only", () => {
  const html = renderToString(<AssistantTranscript data={data} selection="composite" />);
  expect(html).toContain("<h2>Hook payload</h2>");
  expect(html).toContain("<table>");
  expect(html).toContain("<h3>Review result</h3>");
  expect(html).toContain("<strong>Looks good</strong>");
  expect(html).toContain("Outside model context");
  expect(html).toContain('aria-label="GitHub webhook"');
  expect(html).toContain("Command failed");
  expect(html).toContain("Pull request");
  expect(html).toContain("Captured transcript");
  expect(html).toContain('class="aui-demo-text-box"><button');
  expect(html).toContain('aria-label="Copy message"');
  expect(html).not.toContain('class="aui-demo-actions"');
  expect(html).not.toContain("textarea");
});

test("assistant-ui baseline excludes activity cards while preserving ordinary messages", () => {
  const html = renderToString(
    <AssistantTranscript data={data} selection="capture" annotated={false} />,
  );
  expect(html).toContain("Hook payload");
  expect(html).not.toContain("Outside model context");
  expect(html).not.toContain("external-party message");
});

test("native AG-UI conversion preserves external payloads as user messages and activities as data parts", () => {
  const messages = fromAgUiMessages(toAnnotatedMessages(data.examples));
  expect(
    messages.some(
      (message) =>
        message.role === "user" && JSON.stringify(message.content).includes("Hook payload"),
    ),
  ).toBe(true);
  expect(JSON.stringify(messages)).toContain("agui-activity/errandd.notice.v1");
  expect(JSON.stringify(messages)).toContain("agui-activity/errandd.sources.v1");
});

test("capture adapter keeps provenance before the user and origin on the sender", () => {
  const messages = toAssistantMessages(toAnnotatedMessages(data.examples));
  expect(messages[0]?.id).toBe("capture:capture");
  expect(messages[1]?.role).toBe("user");
  expect(messages[1]?.id).toBe("capture:hook");
  expect(JSON.stringify(messages[1]?.metadata)).toContain('"provider":"github"');
  expect(messages.some((message) => message.id === "capture:hook:origin")).toBe(false);
});

test("assistant-ui renders GitHub HTML in user, assistant and activity Markdown", () => {
  const body =
    '<details><summary>Deployment preview</summary><p>Ready<br>for review</p></details>\n\n<a href="https://vercel.com/review"><picture><source media="(prefers-color-scheme: dark)" srcset="https://example.com/dark.svg"><img src="https://example.com/light.svg" alt="Request Review" width="150"></picture></a>\n\n<table><tr><th>Check</th></tr><tr><td>Passed</td></tr></table>';
  for (const role of ["user", "assistant", "activity"] as const) {
    const fixture: ChatExamples = {
      ...data,
      examples: data.examples.map((example) => ({
        ...example,
        parts: [
          role === "activity"
            ? { id: "html", kind: "system", text: body, notInContext: true }
            : { id: "html", kind: "text", role, markdown: body },
        ],
      })),
    };
    const html = renderToString(<AssistantTranscript data={fixture} selection="composite" />);
    expect(html).toContain("<details><summary>Deployment preview</summary>");
    expect(html).toContain('<a href="https://vercel.com/review"><picture>');
    expect(html).toContain('srcSet="https://example.com/dark.svg"');
    expect(html).toContain('media="(prefers-color-scheme: dark)"');
    expect(html).toContain('alt="Request Review"');
    expect(html).toContain("<table>");
    expect(html).not.toContain("&lt;details&gt;");
  }
});

test("embedded HTML strips executable elements, handlers and unsafe URLs", () => {
  const body =
    '<script>alert("bad")</script><iframe src="https://example.com/embed"></iframe><img src="https://example.com/badge.svg" onerror="alert(1)"><a href="javascript:alert(1)">Unsafe link</a><img src="data:text/html,bad"><p style="position:fixed" onclick="alert(1)">Safe text</p>';
  const fixture: ChatExamples = {
    ...data,
    examples: data.examples.map((example) => ({
      ...example,
      parts: [{ id: "unsafe", kind: "text", role: "user", markdown: body }],
    })),
  };
  const html = renderToString(<AssistantTranscript data={fixture} selection="composite" />);
  expect(html).toContain("Safe text");
  expect(html).toContain('src="https://example.com/badge.svg"');
  for (const unsafe of [
    "<script",
    "<iframe",
    "onerror",
    "onclick",
    "javascript:",
    "data:text/html",
    "position:fixed",
  ]) {
    expect(html).not.toContain(unsafe);
  }
});

test("captured thought grouping preserves answers, notices and user turn boundaries", () => {
  const call = (id: string) => ({
    id,
    role: "assistant" as const,
    content: "",
    toolCalls: [
      {
        id: `tool-${id}`,
        type: "function" as const,
        function: { name: "Bash", arguments: '{"command":"pwd"}' },
      },
    ],
  });
  const converted = toAssistantMessages([
    call("first"),
    call("second"),
    { id: "answer", role: "assistant", content: "Answer" },
    call("third"),
    { id: "notice", role: "activity", activityType: "notice", content: {} },
    call("fourth"),
    call("fifth"),
    { id: "user", role: "user", content: "Next turn" },
    call("sixth"),
  ]);
  expect(converted.map((message) => message.id)).toEqual([
    "first",
    "answer",
    "third",
    "notice",
    "fourth",
    "user",
    "sixth",
  ]);
  expect(converted[0]?.content).toHaveLength(2);
  expect(converted[4]?.content).toHaveLength(2);
});

test("hook comments have named senders and FYI stays in a display-only notice", () => {
  const fixture: ChatExamples = {
    ...data,
    examples: [
      {
        ...data.examples[0]!,
        parts: [
          {
            id: "comment",
            kind: "text",
            role: "user",
            markdown:
              "## Incoming hook · github issue_comment\n\naction: edited · author: alice\n\nPlease check the tests.",
          },
          {
            id: "fyi",
            kind: "system",
            notInContext: true,
            text: "Human is still pushing commits.",
          },
        ],
      },
    ],
  };
  const html = renderToString(<AssistantTranscript data={fixture} selection="composite" />);
  expect(html).toContain('aria-label="Message sender"');
  expect(html).toContain("<strong>alice</strong>");
  expect(html).toContain('aria-label="GitHub webhook"');
  expect(html).toContain("github.com/alice.png");
  expect(html).toContain('role="note" aria-label="FYI — not sent to the agent"');
  expect(html).toContain("Human is still pushing commits.");
  expect(html).not.toContain("external-party message");
});
