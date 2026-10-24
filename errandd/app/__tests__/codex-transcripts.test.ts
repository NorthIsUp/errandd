import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTranscriptFile } from "../runtime/transcripts";
import { parseTranscript, seedParser, tail } from "../ui/services/threadParts";

const record = (type: string, payload: unknown) =>
  JSON.stringify({ type, timestamp: "2026-10-22T12:00:00Z", payload });

test("native Codex response items produce user, assistant and paired tools", () => {
  const parts = parseTranscript(
    [
      record("response_item", {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "private instructions" }],
      }),
      record("response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      }),
      record("response_item", {
        type: "function_call",
        name: "exec_command",
        call_id: "call1",
        arguments: '{"cmd":"ls"}',
      }),
      record("response_item", {
        type: "function_call_output",
        call_id: "call1",
        output: "file.txt",
      }),
      record("response_item", {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      }),
    ].join("\n"),
  );
  expect(parts.map((p) => p.kind)).toEqual(["text", "tool", "text"]);
  expect(parts[0]).toMatchObject({ role: "user", markdown: "hello" });
  expect(parts[1]).toMatchObject({
    tool: {
      type: "exec_command",
      state: "output-available",
      input: { cmd: "ls" },
      output: { text: "file.txt" },
    },
  });
  expect(parts[2]).toMatchObject({ role: "assistant", markdown: "done" });
});

test("Codex transcript resolution and tail preserve partial lines and emit updated tools", async () => {
  const home = await mkdtemp(join(tmpdir(), "errandd-codex-history-"));
  const original = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  const id = "12345678-1234-1234-1234-123456789abc";
  try {
    const dir = join(home, "sessions", "2026", "10", "22");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `rollout-2026-10-22T12-00-00-${id}.jsonl`);
    const tool = `${record("response_item", { type: "function_call", name: "exec_command", call_id: "call1", arguments: '{"cmd":"ls"}' })}\n`;
    const output = `${record("response_item", { type: "function_call_output", call_id: "call1", output: "done" })}\n`;
    await writeFile(file, tool + output.slice(0, 20));
    expect(await resolveTranscriptFile(id)).toBe(file);
    const seeded = await seedParser(id);
    expect(seeded.byteOffset).toBe(Buffer.byteLength(tool));
    expect(seeded.parser.parts).toHaveLength(1);
    await appendFile(file, output.slice(20));
    const update = await tail(id, seeded.byteOffset, seeded.parser);
    expect(update.parts).toHaveLength(1);
    expect(update.parts[0]).toMatchObject({
      kind: "tool",
      tool: { state: "output-available", output: { text: "done" } },
    });
    expect(update.byteOffset).toBe(Buffer.byteLength(tool + output));
    const replacement = `${record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "new 🦞" }] })}\n`;
    await writeFile(file, replacement);
    const truncated = await tail(id, update.byteOffset, seeded.parser);
    expect(truncated.reset).toBe(true);
    expect(seeded.parser.parts).toEqual(parseTranscript(replacement));
    expect(truncated.parts[0]).toMatchObject({ role: "user", markdown: "new 🦞" });
    await writeFile(`${file}.new`, replacement.replace("new", "old"));
    await rename(`${file}.new`, file);
    const replaced = await tail(id, truncated.byteOffset, seeded.parser);
    expect(replaced.reset).toBe(true);
    expect(replaced.parts[0]).toMatchObject({ role: "user", markdown: "old 🦞" });
  } finally {
    if (original === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = original;
    }
    await rm(home, { recursive: true, force: true });
  }
});
