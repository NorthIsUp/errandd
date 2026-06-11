import { describe, expect, test } from "bun:test";
import { isBlockValue } from "./tool";

describe("tool Input renders block markdown for multi-line / long string args", () => {
  test("a multi-line string (e.g. Agent prompt) is a block value", () => {
    const prompt = "### Goal\n\nDo the thing with **bold** and:\n\n```python\nprint('hi')\n```\n\n- one\n- two";
    expect(isBlockValue(prompt)).toBe(true);
  });

  test("a long single-line string walls up inline, so render as block", () => {
    expect(isBlockValue("x".repeat(121))).toBe(true);
  });

  test("short one-line scalars stay inline", () => {
    expect(isBlockValue("general-purpose")).toBe(false);
    expect(isBlockValue("Search the codebase")).toBe(false);
  });

  test("non-strings are never block values (objects keep their <pre> JSON)", () => {
    expect(isBlockValue(42)).toBe(false);
    expect(isBlockValue(true)).toBe(false);
    expect(isBlockValue({ a: 1 })).toBe(false);
    expect(isBlockValue(null)).toBe(false);
    expect(isBlockValue(undefined)).toBe(false);
  });
});
