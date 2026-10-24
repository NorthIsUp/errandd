import { expect, test } from "bun:test";
import { parsePatch } from "diff";
import { detectDiff } from "./diffFormat";

function parsed(text: string, language?: string) {
  const result = detectDiff(text, language);
  expect(result).not.toBeNull();
  return { display: result!, patches: parsePatch(result!.patch) };
}

test("headerless file-edit diffs become unified snippets without claiming line numbers", () => {
  const raw = "-description: old\n-metadata:\n-  modified: before\n+description: new\n+metadata:\n+  modified: after\n";
  const { display, patches } = parsed(raw);
  expect(display.format).toBe("snippet");
  expect(display.approximate).toBe(true);
  expect(patches[0]?.hunks[0]?.lines).toEqual(raw.trimEnd().split("\n"));
});
test("Git and ordinary unified patches preserve file paths, hunks and positions", () => {
  for (const prefix of ["diff --git a/file.txt b/file.txt\n", ""]) {
    const { display, patches } = parsed(`${prefix}--- a/file.txt\n+++ b/file.txt\n@@ -4,2 +4,2 @@\n same\n-old\n+new\n`);
    expect(display.format).toBe("unified");
    expect(patches[0]?.newFileName).toBe("b/file.txt");
    expect(patches[0]?.hunks[0]?.oldStart).toBe(4);
  }
  expect(parsed("@@ -8 +8 @@\n-old\n+new\n").patches[0]?.hunks[0]?.oldStart).toBe(8);
});
test("normal change, addition and deletion formats preserve their line ranges", () => {
  const change = parsed("2,3c2,3\n< old one\n< old two\n---\n> new one\n> new two\n");
  expect(change.display.format).toBe("normal");
  expect(change.patches[0]?.hunks[0]).toMatchObject({ oldStart: 2, oldLines: 2, newStart: 2, newLines: 2 });
  expect(parsed("0a1\n> added\n").patches[0]?.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1 });
  expect(parsed("1d0\n< removed\n").patches[0]?.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 0 });
});
test("context diffs convert changed and omitted unchanged sides to unified hunks", () => {
  const changed = parsed("*** old.txt\n--- new.txt\n***************\n*** 4,5 ****\n  same\n! old\n--- 4,5 ----\n  same\n! new\n");
  expect(changed.display.format).toBe("context");
  expect(changed.patches[0]?.hunks[0]).toMatchObject({ oldStart: 4, oldLines: 2, newStart: 4, newLines: 2 });
  expect(changed.patches[0]?.hunks[0]?.lines).toEqual([" same", "-old", "+new"]);
  const inserted = parsed("*** old.txt\n--- new.txt\n***************\n*** 1,2 ****\n--- 1,3 ----\n  first\n+ inserted\n  last\n");
  expect(inserted.patches[0]?.hunks[0]?.lines).toContain("+inserted");
});
test("ordinary code and incomplete or invalid patches remain code", () => {
  for (const raw of ["const total = a + b - c;", "x++;\ny--;", "-single bullet", "@@ -1,2 +1,2 @@\n-old\n+new\n", "2c2\n< old\n---\n", "not a diff"]) {
    expect(detectDiff(raw)).toBeNull();
  }
  expect(detectDiff("+only added\n", "diff")?.format).toBe("snippet");
  expect(detectDiff("+only added\n")).toBeNull();
});


test("multiple files and no-newline context markers survive normalization", () => {
  const multi = parsed("diff --git a/one b/one\n--- a/one\n+++ b/one\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/two b/two\n--- a/two\n+++ b/two\n@@ -1 +1 @@\n-c\n+d\n");
  expect(multi.patches.map((patch) => patch.newFileName)).toEqual(["b/one", "b/two"]);
  const eof = parsed("*** old.txt\n--- new.txt\n***************\n*** 1 ****\n! old\n\\ No newline at end of file\n--- 1 ----\n! new\n\\ No newline at end of file\n");
  expect(eof.patches[0]?.hunks[0]?.lines).toContain("\\ No newline at end of file");
});
