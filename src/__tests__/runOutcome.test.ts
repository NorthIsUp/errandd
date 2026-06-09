import { describe, expect, test } from "bun:test";
import { runOutcome } from "../commands/start";

describe("runOutcome (Runs-view status from a finished run) — P0-7", () => {
  test("non-zero exit → error (regardless of output)", () => {
    expect(runOutcome({ exitCode: 1, stdout: "[skip] all good" })).toBe("error");
    expect(runOutcome({ exitCode: 137, stdout: "", stderr: "killed" })).toBe("error");
  });

  test("plain exit 0 with no marker → ok", () => {
    expect(runOutcome({ exitCode: 0, stdout: "did the thing\nall done" })).toBe("ok");
  });

  test("[skip] as the final line → pass", () => {
    expect(runOutcome({ exitCode: 0, stdout: "looked at it\n[skip] nothing to do" })).toBe("pass");
  });

  // The bug: trailing tool-metadata after the marker pushed it out of the old
  // "last 5 stdout lines" window, mislabeling pass → ok.
  test("[skip] followed by many trailing metadata lines → still pass", () => {
    const trailing = Array.from({ length: 20 }, (_, i) => `tool_meta_${i}: {...}`).join("\n");
    const stdout = `[skip] nothing actionable\n${trailing}`;
    expect(runOutcome({ exitCode: 0, stdout })).toBe("pass");
  });

  test("[skip] printed to stderr (not stdout) → still pass", () => {
    expect(
      runOutcome({ exitCode: 0, stdout: "thinking...\nmore output", stderr: "[skip] no-op" }),
    ).toBe("pass");
  });

  test("anchored: a mid-line '[skip]' inside prose does NOT count", () => {
    expect(
      runOutcome({ exitCode: 0, stdout: "I considered whether to [skip] but decided to act" }),
    ).toBe("ok");
  });

  test("[skip:fyi] / suffixed markers still classify as pass", () => {
    expect(runOutcome({ exitCode: 0, stdout: "[skip:ignore] labeled claw:ignore" })).toBe("pass");
  });

  test("explicit [ok] / [done] markers → ok (not pass)", () => {
    expect(runOutcome({ exitCode: 0, stdout: "[ok] addressed the comment" })).toBe("ok");
    expect(runOutcome({ exitCode: 0, stdout: "[done] merged" })).toBe("ok");
  });

  test("newest status line wins when both appear (later [skip])", () => {
    expect(runOutcome({ exitCode: 0, stdout: "[ok] first pass\n[skip] then no-op'd" })).toBe("pass");
  });

  test("leading whitespace before the marker is tolerated", () => {
    expect(runOutcome({ exitCode: 0, stdout: "work\n   [skip] indented marker" })).toBe("pass");
  });
});
