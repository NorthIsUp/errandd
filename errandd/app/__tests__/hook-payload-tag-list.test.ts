import { describe, expect, test } from "bun:test";
import { matchesGlob, matchTagList, tagListSkipReason } from "../../shared/hookPayload";

describe("matchesGlob", () => {
  test("* matches any run, ? matches exactly one char, anchored both ends", () => {
    expect(matchesGlob("release/*", "release/1.2")).toBe(true);
    expect(matchesGlob("v?", "v1")).toBe(true);
    expect(matchesGlob("v?", "v12")).toBe(false);
    expect(matchesGlob("main", "not-main")).toBe(false);
  });

  test("regex metacharacters are literal", () => {
    expect(matchesGlob("a.b", "a.b")).toBe(true);
    expect(matchesGlob("a.b", "axb")).toBe(false);
    expect(matchesGlob("*[bot]", "renovate[bot]")).toBe(true);
    expect(matchesGlob("(x)+", "(x)+")).toBe(true);
  });

  test("is case-sensitive; callers lowercase", () => {
    expect(matchesGlob("prod", "PROD")).toBe(false);
  });
});

describe("matchTagList / tagListSkipReason", () => {
  const cases: [string, string[], string[], string | null][] = [
    ["no patterns", [], ["a"], null],
    ["required present", ["env:prod"], ["env:prod", "x"], null],
    ["required glob present", ["env:*"], ["env:staging"], null],
    ["required missing", ["env:prod"], ["env:staging"], "required tag `env:prod` not present"],
    ["required missing, no tags", ["env:prod"], [], "required tag `env:prod` not present"],
    ["excluded present", ["!flaky"], ["flaky"], "tag `flaky` is excluded"],
    ["excluded absent", ["!flaky"], ["stable"], null],
    ["excluded glob present", ["!team:*"], ["team:web"], "tag `team:*` is excluded"],
    ["case-insensitive pattern and tag", ["ENV:Prod"], ["env:PROD"], null],
    ["reason lowercases the pattern", ["!Flaky"], ["FLAKY"], "tag `flaky` is excluded"],
    ["first failing pattern wins", ["a", "!b", "c"], ["b"], "required tag `a` not present"],
    ["mixed, all satisfied", ["env:*", "!flaky"], ["env:prod"], null],
  ];

  for (const [name, patterns, tags, reason] of cases) {
    test(name, () => {
      expect(tagListSkipReason(patterns, tags)).toBe(reason);
      expect(matchTagList(patterns, tags)).toBe(reason === null);
    });
  }
});
