import { formatPatch, parsePatch, structuredPatch, type StructuredPatchHunk } from "diff";

function viewerPatch(patches: ReturnType<typeof parsePatch>) {
  return formatPatch(patches.map((patch) => ({ ...patch, isGit: true,
    oldFileName: patch.oldFileName === "/dev/null" ? "/dev/null" : `a/${(patch.oldFileName ?? "changes").replace(/^a\//, "")}`,
    newFileName: patch.newFileName === "/dev/null" ? "/dev/null" : `b/${(patch.newFileName ?? "changes").replace(/^b\//, "")}`,
  })));
}

export interface DisplayDiff {
  patch: string;
  format: "unified" | "snippet" | "normal" | "context";
  approximate: boolean;
}
const hunkHeader = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;
function hunk(lines: string[], oldStart = 1, newStart = 1): StructuredPatchHunk {
  const oldLines = lines.filter((line) => !line.startsWith("+") && !line.startsWith("\\")).length;
  const newLines = lines.filter((line) => !line.startsWith("-") && !line.startsWith("\\")).length;
  return { oldStart, oldLines,
    newStart, newLines, lines };
}
function canonical(hunks: StructuredPatchHunk[], format: DisplayDiff["format"], oldFileName = "changes", newFileName = "changes"): DisplayDiff | null {
  if (!hunks.length) return null;
  return { patch: viewerPatch([{ oldFileName, newFileName, oldHeader: undefined, newHeader: undefined, hunks }]), format, approximate: format === "snippet" };
}
function range(start: string, end?: string) {
  const first = Number(start);
  return { start: first, count: first === 0 ? 0 : Number(end ?? start) - first + 1 };
}

function normalDiff(lines: string[]): DisplayDiff | null {
  const hunks: StructuredPatchHunk[] = [];
  let index = 0;
  while (index < lines.length) {
    const match = /^(\d+)(?:,(\d+))?([acd])(\d+)(?:,(\d+))?$/.exec(lines[index] ?? "");
    if (!match) return null;
    index++;
    const old = range(match[1] ?? "", match[2]);
    const next = range(match[4] ?? "", match[5]);
    const kind = match[3];
    const changes: string[] = [];
    if (kind !== "a") {
      for (let n = 0; n < old.count; n++) {
        const line = lines[index++];
        if (!line?.startsWith("< ")) return null;
        changes.push(`-${line.slice(2)}`);
      }
      if (lines[index]?.startsWith("\\ No newline")) changes.push(lines[index++] ?? "");
    }
    if (kind === "c" && lines[index++] !== "---") return null;
    if (kind !== "d") {
      for (let n = 0; n < next.count; n++) {
        const line = lines[index++];
        if (!line?.startsWith("> ")) return null;
        changes.push(`+${line.slice(2)}`);
      }
      if (lines[index]?.startsWith("\\ No newline")) changes.push(lines[index++] ?? "");
    }
    hunks.push({ oldStart: old.start + (kind === "a" ? 1 : 0), oldLines: kind === "a" ? 0 : old.count,
      newStart: next.start + (kind === "d" ? 1 : 0), newLines: kind === "d" ? 0 : next.count, lines: changes });
  }
  return canonical(hunks, "normal");
}

function contextDiff(lines: string[]): DisplayDiff | null {
  const hunks: StructuredPatchHunk[] = [];
  let index = 0;
  let oldName = "changes";
  let newName = "changes";
  if (/^\*\*\* [^\d]/.test(lines[0] ?? "") && (lines[1] ?? "").startsWith("--- ")) {
    oldName = (lines[0] ?? "").slice(4).split("\t")[0] ?? oldName;
    newName = (lines[1] ?? "").slice(4).split("\t")[0] ?? newName;
    index = 2;
  }
  while (index < lines.length) {
    if (lines[index++] !== "***************") return null;
    const before = /^\*\*\* (\d+)(?:,(\d+))? \*{4}$/.exec(lines[index++] ?? "");
    if (!before) return null;
    const old = range(before[1] ?? "", before[2]);
    const oldLines: string[] = [];
    const oldContext: string[] = [];
    let oldNoNewline = false;
    while (index < lines.length && !/^--- \d+(?:,\d+)? -{4}$/.test(lines[index] ?? "")) {
      const line = lines[index++];
      if (line?.startsWith("\\ No newline")) { oldNoNewline = true; continue; }
      if (line === undefined || !/^(?: {2}|! |- )/.test(line)) return null;
      oldLines.push(line.slice(2));
      if (line.startsWith("  ")) oldContext.push(line.slice(2));
    }
    const after = /^--- (\d+)(?:,(\d+))? -{4}$/.exec(lines[index++] ?? "");
    if (!after) return null;
    const next = range(after[1] ?? "", after[2]);
    const newLines: string[] = [];
    const newContext: string[] = [];
    let newNoNewline = false;
    while (index < lines.length && lines[index] !== "***************") {
      const line = lines[index++];
      if (line?.startsWith("\\ No newline")) { newNoNewline = true; continue; }
      if (line === undefined || !/^(?: {2}|! |\+ )/.test(line)) return null;
      newLines.push(line.slice(2));
      if (line.startsWith("  ")) newContext.push(line.slice(2));
    }
    // A context diff may omit an unchanged side for pure insertion/deletion.
    if (!oldLines.length && old.count) oldLines.push(...newContext);
    if (!newLines.length && next.count) newLines.push(...oldContext);
    if (oldLines.length !== old.count || newLines.length !== next.count) return null;
    const patch = structuredPatch(oldName, newName, oldLines.join("\n") + (oldLines.length && !oldNoNewline ? "\n" : ""),
      newLines.join("\n") + (newLines.length && !newNoNewline ? "\n" : ""), "", "", { context: Infinity, timeout: 50 });
    if (!patch) return null;
    hunks.push(...patch.hunks.map((part) => ({ ...part,
      oldStart: part.oldStart + Math.max(0, old.start - 1),
      newStart: part.newStart + Math.max(0, next.start - 1),
    })));
  }
  return canonical(hunks, "context", oldName, newName);
}

/** Conservative content detection: ordinary code/inline +/- operators stay
 * code. Incomplete/malformed patches stay readable while a block streams. */
export function detectDiff(raw: string, language = ""): DisplayDiff | null {
  if (raw.length > 500_000) return null;
  // eslint-disable-next-line no-control-regex -- Strip ANSI color for parsing; copy retains the original.
  const text = raw.replace(/\r\n/g, "\n").replace(/\u001b\[[0-9;]*m/g, "");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  try {
    if (hunkHeader.test(text) || /^diff --git /m.test(text)) {
      const patches = parsePatch(text);
      if (patches.length && patches.some((patch) => patch.hunks.length || patch.isRename || patch.isCopy || patch.isDelete || patch.isCreate || patch.isBinary || patch.oldMode !== undefined)) {
        for (const patch of patches) {
          patch.oldFileName ??= "changes";
          patch.newFileName ??= "changes";
        }
        return { patch: viewerPatch(patches), format: "unified", approximate: false };
      }
      return null;
    }
    if (/^\d+(?:,\d+)?[acd]\d+(?:,\d+)?$/.test(lines[0] ?? "")) return normalDiff(lines);
    if (lines.includes("***************")) return contextDiff(lines);
    const added = lines.some((line) => line.startsWith("+"));
    const removed = lines.some((line) => line.startsWith("-"));
    const explicit = /^(?:diff|patch|udiff)$/i.test(language);
    if ((added && removed || explicit && (added || removed)) && lines.every((line) => /^[ +\-\\]/.test(line) || line === "")) {
      return canonical([hunk(lines.map((line) => line || " "))], "snippet");
    }
  } catch { /* Invalid/incomplete diff: retain the original code block. */ }
  return null;
}
