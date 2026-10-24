/** Vercel puts an opaque deployment/edit marker in `[vc]: #...` references.
 * Incoming-hook headings run directly into the comment, so Markdown can show
 * this normally invisible metadata as hundreds of characters of prose.
 * This is a display-only transform: never use it to rewrite stored payloads
 * or the agent's input. Other reference definitions and URL anchors stay intact.
 */
export function webhookDisplayMarkdown(markdown: string): string {
  if (!/^##\s*Incoming hooks?\b/.test(markdown.trimStart())) {
    return markdown;
  }
  let fence: { character: string; length: number } | null = null;
  const lines = markdown.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence) {
        fence = { character: delimiter[0] ?? "", length: delimiter.length };
      } else if (delimiter.startsWith(fence.character) && delimiter.length >= fence.length) {
        fence = null;
      }
      output.push(line);
      continue;
    }
    if (fence || line.startsWith("    ") || line.startsWith("\t")) {
      output.push(line);
      continue;
    }
    // A reference can place its destination on the following line.
    if (/^ {0,3}\[vc\]:[ \t]*$/i.test(line) && /^ {0,3}#[A-Za-z0-9+/_=:-]{80,}[ \t]*\r?$/.test(lines[index + 1] ?? "")) {
      index++;
      continue;
    }
    const cleaned = line.replace(/^([ \t]{0,3}|\d+\. [^\n]*? — ")\[vc\]:[ \t]*#[A-Za-z0-9+/_=:-]{80,}(?:…⟨\+\d+⟩)?/gi, "$1");
    if (cleaned !== line) {
      if (!cleaned.trim()) {
        continue;
      }
      // Coalesced hook summaries wrap the truncated bot body in quotes.
      output.push(cleaned.replace(/\s+—\s+""[ \t]*$/, ""));
    } else {
      output.push(line);
    }
  }
  return output.join("\n");
}
