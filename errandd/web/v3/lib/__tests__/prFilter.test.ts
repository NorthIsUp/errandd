import { describe, expect, test } from "bun:test";
import { DEFAULT_PR_FILTER, filterByPrState, type PrStateFilter } from "../prFilter";
import type { PrGitState, TreeItem } from "../tree";

/** Wednesday 10:00 local — mid-week, so the window is a plain 24h. */
const WED = new Date(2026, 7, 19, 10).getTime();
const MON = new Date(2026, 7, 24, 10).getTime();
const HOURS = (n: number) => n * 60 * 60 * 1000;

function item(key: string, lastAt: number, num: number | null = 1): TreeItem {
  return {
    key,
    title: key,
    routines: [],
    lastAt,
    ...(num == null ? {} : { num }),
  };
}

function filter(overrides: Partial<PrStateFilter> = {}): PrStateFilter {
  return { ...DEFAULT_PR_FILTER, ...overrides };
}

const keys = (items: TreeItem[]) => items.map((i) => i.key);

describe("filterByPrState", () => {
  test("default: open stays regardless of age, merged/closed only if recent", () => {
    const items = [
      item("a/b#1", WED - HOURS(500)),
      item("a/b#2", WED - HOURS(2)),
      item("a/b#3", WED - HOURS(500)),
    ];
    const states: Record<string, PrGitState> = {
      "a/b#1": "open",
      "a/b#2": "merged",
      "a/b#3": "closed",
    };
    expect(keys(filterByPrState(items, states, filter(), WED))).toEqual(["a/b#1", "a/b#2"]);
  });

  test("monday reaches back through the weekend for merged PRs", () => {
    const items = [item("a/b#1", MON - HOURS(60))]; // Friday evening
    const states: Record<string, PrGitState> = { "a/b#1": "merged" };
    expect(keys(filterByPrState(items, states, filter(), MON))).toEqual(["a/b#1"]);
    // …but the same PR is out on a Wednesday, where 60h ago is Monday.
    expect(filterByPrState([item("a/b#1", WED - HOURS(60))], states, filter(), WED)).toHaveLength(0);
  });

  test("recentTerminalOnly off shows old merged/closed PRs", () => {
    const items = [item("a/b#2", WED - HOURS(500))];
    const states: Record<string, PrGitState> = { "a/b#2": "merged" };
    expect(filterByPrState(items, states, filter({ recentTerminalOnly: false }), WED)).toHaveLength(1);
  });

  test("unchecking a state hides it whatever its age", () => {
    const items = [item("a/b#1", WED), item("a/b#4", WED)];
    const states: Record<string, PrGitState> = { "a/b#1": "open", "a/b#4": "conflicted" };
    const f = filter({ visible: { ...DEFAULT_PR_FILTER.visible, open: false } });
    expect(keys(filterByPrState(items, states, f, WED))).toEqual(["a/b#4"]);
  });

  test("a PR with no known state is filtered as 'unknown'", () => {
    const items = [item("a/b#9", WED)];
    const f = filter({ visible: { ...DEFAULT_PR_FILTER.visible, unknown: false } });
    expect(filterByPrState(items, {}, f, WED)).toHaveLength(0);
    expect(filterByPrState(items, {}, filter(), WED)).toHaveLength(1);
  });

  test("non-PR rows are never filtered out", () => {
    const items = [item("routine:nightly", WED - HOURS(500), null)];
    const f = filter({ visible: { ...DEFAULT_PR_FILTER.visible, unknown: false } });
    expect(filterByPrState(items, {}, f, WED)).toHaveLength(1);
  });
});
