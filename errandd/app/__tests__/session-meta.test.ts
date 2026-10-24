import { test, expect } from "bun:test";
import { normalizeTitle, mergeMeta, isValidEffort } from "../ui/services/session-meta";

test("normalizeTitle trims and caps length", () => {
  expect(normalizeTitle("  hi  ")).toBe("hi");
  expect(normalizeTitle("x".repeat(200)).length).toBe(120);
});

test("mergeMeta applies title and closed flag", () => {
  const store = { sessions: { id1: { title: "Standup", closed: true } } };
  const merged = mergeMeta({ id: "id1", closed: false }, store);
  expect(merged.title).toBe("Standup");
  expect(merged.closed).toBe(true);
});

test("mergeMeta defaults closed to false when absent", () => {
  const merged = mergeMeta({ id: "id2" }, { sessions: {} });
  expect(merged.closed).toBe(false);
  expect(merged.title).toBeUndefined();
});

// isValidEffort
test("isValidEffort accepts valid levels", () => {
  expect(isValidEffort("low")).toBe(true);
  expect(isValidEffort("medium")).toBe(true);
  expect(isValidEffort("high")).toBe(true);
  expect(isValidEffort("xhigh")).toBe(true);
  expect(isValidEffort("max")).toBe(true);
});

test("isValidEffort rejects invalid levels", () => {
  expect(isValidEffort("")).toBe(false);
  expect(isValidEffort("ultra")).toBe(false);
  expect(isValidEffort("High")).toBe(false);
  expect(isValidEffort("LOW")).toBe(false);
});

test("session metadata ignores malformed records and prototype inheritance", async () => {
  const { normalizeSessionMeta } = await import("../ui/services/session-meta");
  const store = normalizeSessionMeta(
    JSON.parse('{"sessions":{"__proto__":{"title":"safe"},"bad":null,"array":[]}}'),
  );
  expect(Object.getPrototypeOf(store.sessions)).toBeNull();
  expect(store.sessions.__proto__).toEqual({ title: "safe" });
  expect(Object.hasOwn(store.sessions, "bad")).toBe(false);
  expect(mergeMeta({ id: "constructor" }, store).title).toBeUndefined();
  expect(normalizeSessionMeta({ sessions: null }).sessions).toEqual({});
});
