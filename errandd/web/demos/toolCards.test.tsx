import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { AssistantTranscript } from "./AssistantUI";
import { CUSTOM_CARD_EXAMPLES } from "./customCardExamples";
import { ErranddToolCard, frameworkTool } from "./toolCards";

test("assistant-ui renders the shared routine card and native Bash error details", () => {
  const assistant = renderToString(
    <AssistantTranscript data={CUSTOM_CARD_EXAMPLES} selection="composite" />,
  );
  for (const html of [assistant]) {
    expect(html).toContain('data-custom-card="routine"');
    expect(html).toContain("pr-review");
    expect(html).toContain("checks completed");
    expect(html).toContain("git diff --stat");
    expect(html).toContain("Completed");
    expect(html).toContain("Input");
    expect(html).toContain("Output");
    expect(html).toContain("Exit code 1: missing-file.md does not exist");
    expect(html).toContain("cat: missing-file.md: No such file or directory");
    expect(html).toContain("Call ID:");
    expect(html).toContain("bash-error");
  }
});

test("framework adapters preserve streaming arguments, scalar results and errors", () => {
  const streaming = frameworkTool({
    name: "Bash",
    id: "one",
    args: '{"command":',
    result: undefined,
    phase: "streaming",
  });
  expect(streaming.state).toBe("input-streaming");
  expect(streaming.input).toEqual({ partial: '{"command":' });
  const scalar = frameworkTool({
    name: "Bash",
    id: "two",
    args: { command: "echo hi" },
    result: "hello",
    phase: "complete",
  });
  expect(scalar.output).toEqual({ text: "hello" });
  const failed = frameworkTool({
    name: "Bash",
    id: "three",
    args: {},
    result: '{"error":"command failed"}',
    phase: "complete",
  });
  expect(failed.state).toBe("output-error");
  expect(failed.errorText).toBe("command failed");
  expect(renderToString(<ErranddToolCard tool={failed} />)).toContain("command failed");
});

test("direct shell JSON results retain their original bytes for the output copy action", () => {
  const raw = ' { "ready":true, "items": [1,2] }\n';
  const tool = frameworkTool({
    name: "Bash",
    id: "json",
    args: {},
    result: raw,
    phase: "complete",
  });
  expect(tool.output).toEqual({ text: raw });
});
