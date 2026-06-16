export interface ParsedRun {
  date?: string;
  session?: string;
  model?: string;
  prompt?: string;
  exitCode?: string;
  output?: string;
}

/**
 * Parse the lines of a routine run log (as returned by /api/home) into a
 * structured form. Same format as src/ui/services/home logs.
 */
export function parseRunLog(lines: string[]): ParsedRun {
  const parsed: ParsedRun = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("Date:")) parsed.date = line.slice(5).trim();
    else if (line.startsWith("Session:")) parsed.session = line.slice(8).trim();
    else if (line.startsWith("Model config:"))
      parsed.model = line.slice(13).trim();
    else if (line.startsWith("Exit code:"))
      parsed.exitCode = line.slice(10).trim();
    else if (line.startsWith("Prompt:")) {
      const parts: string[] = [line.slice(7).trim()];
      i++;
      while (
        i < lines.length &&
        !(lines[i] ?? "").startsWith("Exit code:") &&
        !(lines[i] ?? "").startsWith("## Output")
      ) {
        parts.push(lines[i] ?? "");
        i++;
      }
      parsed.prompt = parts.join("\n").trim();
      continue;
    } else if (line.trim() === "## Output") {
      parsed.output = lines.slice(i + 1).join("\n").trim();
      break;
    }
    i++;
  }
  return parsed;
}
