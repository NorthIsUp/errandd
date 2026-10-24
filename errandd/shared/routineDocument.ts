/** Historical hook turns combine the event and the routine's Markdown. Keep
 * the event attributed to its sender while presenting the instructions as a
 * separate document. This is a display projection; the stored turn is intact. */
export function routineDocument(markdown: string): {
  context: string;
  body: string;
  content: string;
  title: string;
} | null {
  const text = markdown.trimStart();
  if (!/^(?:## Incoming hooks?\b|Triggered by |New event on |\d+ new events on |<errandd-session-carryover\b)/.test(text)) return null;
  let start = 0;
  if (text.startsWith("<errandd-session-carryover")) {
    const end = markdown.indexOf("</errandd-session-carryover>");
    if (end < 0) return null;
    start = end + "</errandd-session-carryover>".length;
  }
  let fence: { character: string; length: number } | undefined;
  let offset = start;
  for (const line of markdown.slice(start).split(/(?<=\n)/)) {
    const boundary = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (boundary) {
      if (!fence) fence = { character: boundary.charAt(0), length: boundary.length };
      else if (boundary.startsWith(fence.character) && boundary.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined;
    } else if (!fence) {
      const heading = /^# ([^\r\n]+)\r?\n?$/.exec(line)?.[1];
      if (heading) return {
        context: markdown.slice(0, offset).trimEnd(),
        body: markdown.slice(offset),
        content: markdown.slice(offset + line.length).trimStart(),
        title: heading.replace(/\s+#+\s*$/, "").trim(),
      };
    }
    offset += line.length;
  }
  return null;
}
