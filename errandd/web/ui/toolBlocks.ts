/**
 * Parse the runner's text-rendered tool calls from a chat message.
 *
 * The runner prints tool calls as:
 *
 *     ● Bash(ls -la)
 *       ⎿  [Bash] -rw-r--r-- 1 adam ...
 *
 * Lines starting with `● ` are a tool invocation; the indented `⎿  [Tool] …`
 * (or a sequence of indented lines) is its result. We split a transcript
 * message into a flat list of fragments — text spans and tool calls —
 * so the renderer can show them inline.
 */

export type Fragment =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; call: string; result: string };

const CALL_RE = /^●\s+([A-Za-z_][\w-]*)(?:\((.*)\))?$/;
const RESULT_RE = /^\s+⎿\s+(?:\[([A-Za-z_][\w-]*)]\s+)?(.*)$/;

export function parseToolFragments(source: string): Fragment[] {
  if (!source) {
    return [];
  }
  const lines = source.split("\n");
  const out: Fragment[] = [];
  let textBuf: string[] = [];
  let i = 0;

  const flushText = () => {
    if (textBuf.length === 0) {
      return;
    }
    const text = textBuf.join("\n");
    textBuf = [];
    if (text.trim()) {
      out.push({ kind: "text", text });
    }
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const callMatch = CALL_RE.exec(line);
    if (callMatch) {
      flushText();
      const { result, end } = readResultBlock(lines, i + 1);
      out.push({
        kind: "tool",
        name: callMatch[1] ?? "tool",
        call: callMatch[2] ?? "",
        result,
      });
      i = end;
      continue;
    }
    textBuf.push(line);
    i++;
  }
  flushText();
  return out;
}

/** Walk forward collecting `⎿  [Tool] …` result lines plus any indented
 *  continuation lines. Returns the joined body and the index after the block. */
function readResultBlock(lines: string[], start: number): { result: string; end: number } {
  const acc: string[] = [];
  let j = start;
  while (j < lines.length) {
    const next = lines[j] ?? "";
    const resMatch = RESULT_RE.exec(next);
    if (resMatch) {
      acc.push(resMatch[2] ?? "");
      j++;
      continue;
    }
    // Indented continuation of the previous result. Stop at a new ● call.
    if (next.startsWith("    ") && !(CALL_RE.exec(next))) {
      acc.push(next.replace(/^\s+/, ""));
      j++;
      continue;
    }
    break;
  }
  return { result: acc.join("\n"), end: j };
}
