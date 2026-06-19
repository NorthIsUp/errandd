import { describe, expect, test } from "bun:test";
import { parseTranscript, TranscriptParser } from "../ui/services/threadParts";

// A minimal but representative transcript: a user turn, an assistant turn with
// thinking + text + a tool_use, then the tool_result in a following user turn.
const FIXTURE = [
  JSON.stringify({
    type: "user",
    uuid: "u1",
    message: { role: "user", content: "please check the build" },
  }),
  JSON.stringify({
    type: "assistant",
    uuid: "a1",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "let me look at the logs", signature: "sig" },
        { type: "text", text: "I'll run the tests." },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "bun test" } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    uuid: "u2",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "12 pass, 0 fail" }],
    },
  }),
].join("\n");

describe("parseTranscript (spec §6)", () => {
  test("parses text / reasoning / tool_use+result into ChatPart[]", () => {
    const parts = parseTranscript(FIXTURE);
    const kinds = parts.map((p) => p.kind);
    expect(kinds).toEqual(["text", "reasoning", "text", "tool"]);

    const userTurn = parts[0];
    expect(userTurn).toMatchObject({ kind: "text", role: "user", markdown: "please check the build" });

    const reasoning = parts[1];
    expect(reasoning).toMatchObject({ kind: "reasoning", markdown: "let me look at the logs" });

    const assistantText = parts[2];
    expect(assistantText).toMatchObject({ kind: "text", role: "assistant", markdown: "I'll run the tests." });

    const tool = parts[3];
    if (tool?.kind !== "tool") throw new Error("expected tool part");
    expect(tool.tool.type).toBe("Bash");
    expect(tool.tool.toolCallId).toBe("toolu_1");
    expect(tool.tool.input).toEqual({ command: "bun test" });
    // tool_result paired in → output available.
    expect(tool.tool.state).toBe("output-available");
    expect(tool.tool.output).toEqual({ text: "12 pass, 0 fail" });
  });

  test("a tool_use without a result stays input-available", () => {
    const t = [
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_x", name: "Read", input: { file_path: "/x" } }],
        },
      }),
    ].join("\n");
    const parts = parseTranscript(t);
    expect(parts).toHaveLength(1);
    const tool = parts[0];
    if (tool?.kind !== "tool") throw new Error("expected tool part");
    expect(tool.tool.state).toBe("input-available");
    expect(tool.tool.output).toBeUndefined();
  });

  test("is_error tool_result marks the tool part output-error with errorText", () => {
    const t = [
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: "te", name: "Bash", input: {} }] },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "te", content: "boom", is_error: true }],
        },
      }),
    ].join("\n");
    const parts = parseTranscript(t);
    const tool = parts[0];
    if (tool?.kind !== "tool") throw new Error("expected tool part");
    expect(tool.tool.state).toBe("output-error");
    expect(tool.tool.errorText).toBe("boom");
  });

  test("tool_result content as a block array is flattened to text", () => {
    const t = [
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: "tb", name: "Task", input: {} }] },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tb",
              content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }],
            },
          ],
        },
      }),
    ].join("\n");
    const parts = parseTranscript(t);
    const tool = parts[0];
    if (tool?.kind !== "tool") throw new Error("expected tool part");
    expect(tool.tool.output).toEqual({ text: "line one\nline two" });
  });

  test("TranscriptParser feeds incrementally: a later batch pairs a result with an earlier tool_use", () => {
    const parser = new TranscriptParser();
    parser.feed(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: "split", name: "Bash", input: {} }] },
      }),
    );
    expect(parser.parts).toHaveLength(1);
    let tool = parser.parts[0];
    if (tool?.kind !== "tool") throw new Error("expected tool part");
    expect(tool.tool.state).toBe("input-available");

    // Second batch (as the SSE tail would feed) carries the result.
    parser.feed(
      "\n" +
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "split", content: "done" }],
          },
        }),
    );
    // No new part — the existing tool part was updated in place.
    expect(parser.parts).toHaveLength(1);
    tool = parser.parts[0];
    if (tool?.kind !== "tool") throw new Error("expected tool part");
    expect(tool.tool.state).toBe("output-available");
    expect(tool.tool.output).toEqual({ text: "done" });
  });

  test("strips ClawdCode-injected timestamp prefix from user text", () => {
    const t = JSON.stringify({
      type: "user",
      message: { role: "user", content: "[2026-06-08 12:00:00 UTC]\nthe real message" },
    });
    const parts = parseTranscript(t);
    expect(parts[0]).toMatchObject({ kind: "text", role: "user", markdown: "the real message" });
  });

  test("a hook-trigger user turn becomes a system part, not a text wall", () => {
    const t = JSON.stringify({
      type: "user",
      timestamp: "2026-06-08T22:00:00.000Z",
      message: {
        role: "user",
        content: "Triggered by GitHub pull_request (delivery d1):\n\nrepo: x/y\n\nLONG ROUTINE PROMPT…",
      },
    });
    const parts = parseTranscript(t);
    expect(parts[0]?.kind).toBe("system");
    expect(parts[0]).toMatchObject({ kind: "system" });
    // timestamp carried through
    expect(parts[0]?.at).toBe(Date.parse("2026-06-08T22:00:00.000Z"));
  });

  test("a resume lead ('New event on …') is also a system trigger", () => {
    const t = JSON.stringify({
      type: "user",
      message: { role: "user", content: "New event on `pr-1` since you last ran — handle it…" },
    });
    expect(parseTranscript(t)[0]?.kind).toBe("system");
  });

  test("a normal composer reply stays a user text turn", () => {
    const t = JSON.stringify({
      type: "user",
      message: { role: "user", content: "can you also bump the version?" },
    });
    expect(parseTranscript(t)[0]).toMatchObject({ kind: "text", role: "user" });
  });

  test("the agent's terminal [skip]/[ok] line becomes a system notice", () => {
    const t = JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-08T23:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "[skip] PR #1195: looks fine, nothing to do" }],
      },
    });
    const parts = parseTranscript(t);
    expect(parts[0]?.kind).toBe("system");
    expect(parts[0]?.at).toBe(Date.parse("2026-06-08T23:00:00.000Z"));
    // A plain [skip] with a free-form (agent) reason is in-context, NOT flagged.
    expect(parts[0]?.notInContext).toBeUndefined();
  });

  test("a plain [skip] with a FILTER reason is a SYSTEM skip (notInContext), not the agent", () => {
    // Older transcripts emitted a plain [skip] for config-filter rejections; the
    // reason wording ("not in the action filter") marks it as a system skip.
    const t = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "[skip] PR #1670: action `edited` not in the action filter" }],
      },
    });
    const parts = parseTranscript(t);
    expect(parts[0]?.kind).toBe("system");
    expect(parts[0]?.notInContext).toBe(true);
  });

  test("a [skip:fyi] prefilter line is a system notice flagged notInContext (FYI box)", () => {
    const t = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "[skip:fyi] PR #42: bot noise: greptile-bot" }],
      },
    });
    const parts = parseTranscript(t);
    expect(parts[0]?.kind).toBe("system");
    expect(parts[0]).toMatchObject({ kind: "system", notInContext: true });
    // text is kept verbatim (mirrors the plain-[skip] behavior).
    expect((parts[0] as { text: string }).text).toContain("[skip:fyi]");
  });

  test("a [skip:rule] config/self-filter line is flagged notInContext (FYI box)", () => {
    const t = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "[skip:rule] PR #7: base branch `main` excluded by the branch filter" }],
      },
    });
    const parts = parseTranscript(t);
    expect(parts[0]).toMatchObject({ kind: "system", notInContext: true });
    expect((parts[0] as { text: string }).text).toContain("[skip:rule]");
  });

  test("a [skip:ignore] label line is also flagged notInContext", () => {
    const t = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "[skip:ignore] claw:ignore label present" }],
      },
    });
    const parts = parseTranscript(t);
    expect(parts[0]).toMatchObject({ kind: "system", notInContext: true });
  });

  test("a model usage-cap notice renders as a system block, not an assistant chat", () => {
    const t = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "You've hit your Sonnet limit · resets Jun 20, 6pm (UTC)" }],
      },
    });
    const parts = parseTranscript(t);
    expect(parts[0]?.kind).toBe("system");
    // It's a real condition, not a filtered FYI — stays in-context (no blue box).
    expect((parts[0] as { notInContext?: boolean }).notInContext).toBeUndefined();
  });

  test("review prose that merely mentions 'limit' stays an assistant message", () => {
    const t = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The rate-limit guard in apiFetch looks correct." }],
      },
    });
    const parts = parseTranscript(t);
    expect(parts[0]).toMatchObject({ kind: "text", role: "assistant" });
  });
});
