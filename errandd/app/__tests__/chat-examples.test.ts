import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  displayExamples,
  exampleMetrics,
  toStockMessages,
  type CapturedChat,
} from "../../shared/chatExamples";
import { readChatExamples } from "../ui/services/chatExamples";

function example(id = "a"): CapturedChat {
  return {
    id,
    title: "Sample capture",
    threadId: "routine:hook:pr-1",
    sourceUrl: "https://example.com/v3/#/chat/routine",
    totalParts: 6,
    sources: [{ href: "https://example.com/pr/1", label: "PR #1" }],
    parts: [
      { id: "user", kind: "text", role: "user", markdown: "Investigate this failure" },
      { id: "fyi", kind: "system", text: "[skip:rule] Not sent to the model", notInContext: true },
      { id: "reason", kind: "reasoning", markdown: "Inspect the configuration" },
      {
        id: "tool",
        kind: "tool",
        tool: {
          type: "Edit",
          toolCallId: "call1",
          state: "output-error",
          input: { file_path: "a.ts", old_string: "a", new_string: "b" },
          errorText: "File missing",
        },
      },
      { id: "answer", kind: "text", role: "assistant", markdown: "The file was missing" },
      {
        id: "sources",
        kind: "sources",
        sources: [{ href: "https://example.com/pr/1", label: "PR #1" }],
      },
    ],
  };
}

test("capture adapter maps standard messages without promoting FYI annotations into context", () => {
  const messages = toStockMessages([example()]);
  expect(messages.map((message) => message.role)).toEqual([
    "user",
    "reasoning",
    "assistant",
    "tool",
    "assistant",
  ]);
  expect(JSON.stringify(messages)).not.toContain("Not sent to the model");
  expect(JSON.stringify(messages)).toContain("File missing");
  expect(JSON.stringify(messages)).not.toContain("https://example.com/pr/1");
});
test("composite namespaces tool and message IDs across source conversations", () => {
  const messages = toStockMessages([example("a"), example("b")]);
  expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
  const resultIds = messages
    .filter((message) => message.role === "tool")
    .map((message) => message.toolCallId);
  expect(resultIds).toEqual(["a:call1", "b:call1"]);
});
test("comparison metrics report features actually present", () => {
  expect(exampleMetrics([example()])).toEqual({
    parts: 6,
    tools: 1,
    errors: 1,
    fyi: 1,
    reasoning: 1,
    edits: 1,
    sources: 1,
  });
});

test("short excerpts preserve the private capture and mark omitted text", () => {
  const capture = example();
  capture.parts = [{ kind: "text", id: "long", role: "user", markdown: "a".repeat(5000) }];
  const preview = displayExamples([capture], true)[0].parts[0];
  expect(preview.kind === "text" && preview.markdown).toContain("Comparison excerpt");
  expect(capture.parts[0].kind === "text" && capture.parts[0].markdown.length).toBe(5000);
  expect(displayExamples([capture], false)[0]).toBe(capture);
});
test("private captures are loaded from a local file, with a clean missing-file state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "errandd-captures-"));
  try {
    const file = join(dir, "capture.json");
    expect(await readChatExamples(file)).toBeNull();
    const data = {
      version: 1 as const,
      sourceOrigin: "https://example.com",
      capturedAt: new Date().toISOString(),
      examples: [example()],
    };
    await writeFile(file, JSON.stringify(data));
    expect(await readChatExamples(file)).toEqual(data);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compact captures keep embedded HTML intact instead of cutting through tags", () => {
  const capture = example();
  const markdown = `<details><summary>Preview</summary><a href="https://example.com/${"x".repeat(3000)}">Review</a></details>`;
  capture.parts = [{ kind: "text", id: "html", role: "user", markdown }];
  expect(displayExamples([capture], true)[0].parts[0]).toEqual(capture.parts[0]);
});
