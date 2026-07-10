import { test, expect, describe } from "bun:test";
import { createAguiAdapter, extractPrompt, contentToText, type AguiEvent } from "../ui/agui";

function collect(): { send: (e: AguiEvent) => void; events: AguiEvent[] } {
  const events: AguiEvent[] = [];
  return { send: (e) => void events.push(e), events };
}

describe("createAguiAdapter: normalized stream → AG-UI events", () => {
  test("an assistant text turn becomes a closed START→CONTENT→END triplet", () => {
    const { send, events } = collect();
    const { handlers, resultText } = createAguiAdapter(send);
    void handlers.onAssistant?.([{ type: "text", text: "hello world" }], "m1");

    expect(events.map((e) => e.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
    ]);
    expect(events[0]).toMatchObject({ messageId: "m1", role: "assistant" });
    expect(events[1]).toMatchObject({ messageId: "m1", delta: "hello world" });
    expect(events[2]).toMatchObject({ messageId: "m1" });
    expect(resultText()).toBe("hello world");
  });

  test("multiple text blocks in one turn are concatenated into one message", () => {
    const { send, events } = collect();
    const { handlers } = createAguiAdapter(send);
    void handlers.onAssistant?.([
      { type: "text", text: "foo " },
      { type: "text", text: "bar" },
    ], "m1");
    const contents = events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT");
    expect(contents.length).toBe(1);
    expect(contents[0].delta).toBe("foo bar");
  });

  test("a tool_use block becomes START→ARGS→END with stringified args", () => {
    const { send, events } = collect();
    const { handlers } = createAguiAdapter(send);
    void handlers.onAssistant?.([{ type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } }], "m2");

    expect(events.map((e) => e.type)).toEqual(["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]);
    expect(events[0]).toMatchObject({ toolCallId: "t1", toolCallName: "bash", parentMessageId: "m2" });
    expect(events[1]).toMatchObject({ toolCallId: "t1", delta: JSON.stringify({ cmd: "ls" }) });
    expect(events[2]).toMatchObject({ toolCallId: "t1" });
  });

  test("text then tool_use in one turn: text triplet first, then tool triplet", () => {
    const { send, events } = collect();
    const { handlers } = createAguiAdapter(send);
    void handlers.onAssistant?.([
      { type: "text", text: "let me look" },
      { type: "tool_use", id: "t1", name: "bash", input: {} },
    ], "m3");
    expect(events.map((e) => e.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
    ]);
  });

  test("onToolResult becomes TOOL_CALL_RESULT with flattened string content", () => {
    const { send, events } = collect();
    const { handlers } = createAguiAdapter(send);
    void handlers.onToolResult?.("t1", [{ type: "text", text: "file.txt" }], false);
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      type: "TOOL_CALL_RESULT",
      toolCallId: "t1",
      content: "file.txt",
      role: "tool",
    });
    expect(events[0].isError).toBeUndefined();
  });

  test("an errored tool result carries isError:true", () => {
    const { send, events } = collect();
    const { handlers } = createAguiAdapter(send);
    void handlers.onToolResult?.("t1", "boom", true);
    expect(events[0]).toMatchObject({ content: "boom", isError: true });
  });

  test("onResult text overrides the RUN_FINISHED result", () => {
    const { send } = collect();
    const { handlers, resultText } = createAguiAdapter(send);
    void handlers.onResult?.({ text: "final", contextTokens: 0 });
    expect(resultText()).toBe("final");
  });

  test("no dangling open message/tool: every START has its END", () => {
    const { send, events } = collect();
    const { handlers } = createAguiAdapter(send);
    void handlers.onAssistant?.([
      { type: "text", text: "hi" },
      { type: "tool_use", id: "t1", name: "bash", input: {} },
    ], "m1");
    const starts = events.filter((e) => e.type.endsWith("_START")).length;
    const ends = events.filter((e) => e.type.endsWith("_END")).length;
    expect(starts).toBe(ends);
  });
});

describe("contentToText", () => {
  test("string passes through", () => expect(contentToText("x")).toBe("x"));
  test("block array joins text", () =>
    expect(contentToText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("ab"));
  test("null → empty", () => expect(contentToText(null)).toBe(""));
  test("object → json", () => expect(contentToText({ k: 1 })).toBe('{"k":1}'));
});

describe("extractPrompt", () => {
  test("plain {prompt}", () => expect(extractPrompt({ prompt: "hi" })).toBe("hi"));
  test("AG-UI messages[]: last user string content", () =>
    expect(extractPrompt({ messages: [{ role: "user", content: "first" }, { role: "assistant", content: "x" }, { role: "user", content: "last" }] })).toBe("last"));
  test("AG-UI messages[]: user content as block array", () =>
    expect(extractPrompt({ messages: [{ role: "user", content: [{ type: "text", text: "blocky" }] }] })).toBe("blocky"));
  test("empty when neither present", () => expect(extractPrompt({})).toBe(""));
  test("ignores non-object body", () => expect(extractPrompt(null)).toBe(""));
});
