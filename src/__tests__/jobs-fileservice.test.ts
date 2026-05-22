import { test, expect } from "bun:test";
import { isSafeJobPath } from "../ui/services/jobs";

test("accepts simple job file names", () => {
  expect(isSafeJobPath("daily.md")).toBe(true);
  expect(isSafeJobPath("sub/weekly.md")).toBe(true);
});

test("rejects path traversal", () => {
  expect(isSafeJobPath("../secret")).toBe(false);
  expect(isSafeJobPath("a/../../b")).toBe(false);
  expect(isSafeJobPath("/etc/passwd")).toBe(false);
});

test("rejects illegal characters", () => {
  expect(isSafeJobPath("a b.md")).toBe(false);
  expect(isSafeJobPath("a$.md")).toBe(false);
  expect(isSafeJobPath("")).toBe(false);
});

test("rejects trailing slash (directory path)", () => {
  expect(isSafeJobPath("sub/")).toBe(false);
});
