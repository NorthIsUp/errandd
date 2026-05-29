import { describe, expect, test } from "bun:test";
import { matchPatternList } from "../hooks/match";

describe("matchPatternList", () => {
  test("empty list matches nothing", () => {
    expect(matchPatternList([], "anything")).toBe(false);
  });

  test("positive glob includes; default-deny otherwise", () => {
    expect(matchPatternList(["main"], "main")).toBe(true);
    expect(matchPatternList(["main"], "develop")).toBe(false);
    expect(matchPatternList(["*"], "develop")).toBe(true);
  });

  // Pure-exclusion lists mean "everything EXCEPT these" — the case that
  // broke `prs: true` (branch: ["!main"]) so it matched no PR commits.
  test("pure-exclusion list = everything except", () => {
    expect(matchPatternList(["!main"], "develop")).toBe(true);
    expect(matchPatternList(["!main"], "feature/x")).toBe(true);
    expect(matchPatternList(["!main"], "main")).toBe(false);
  });

  test("include-then-exclude (humans only)", () => {
    expect(matchPatternList(["*", "!*[bot]"], "alice")).toBe(true);
    expect(matchPatternList(["*", "!*[bot]"], "dependabot[bot]")).toBe(false);
  });

  test("bots only", () => {
    expect(matchPatternList(["*[bot]"], "cursor[bot]")).toBe(true);
    expect(matchPatternList(["*[bot]"], "alice")).toBe(false);
  });
});
