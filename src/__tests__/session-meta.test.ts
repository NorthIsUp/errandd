import { test, expect } from "bun:test";
import { normalizeTitle, mergeMeta } from "../ui/services/session-meta";

test("normalizeTitle trims and caps length", () => {
  expect(normalizeTitle("  hi  ")).toBe("hi");
  expect(normalizeTitle("x".repeat(200)).length).toBe(120);
});

test("mergeMeta applies title and closed flag", () => {
  const store = { sessions: { "id1": { title: "Standup", closed: true } } };
  const merged = mergeMeta({ id: "id1", closed: false } as any, store);
  expect(merged.title).toBe("Standup");
  expect(merged.closed).toBe(true);
});

test("mergeMeta defaults closed to false when absent", () => {
  const merged = mergeMeta({ id: "id2" } as any, { sessions: {} });
  expect(merged.closed).toBe(false);
  expect(merged.title).toBeUndefined();
});
