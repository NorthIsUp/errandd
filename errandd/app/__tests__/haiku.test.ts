/**
 * Unit tests for the pure validation helpers in src/haiku.ts.
 * These test the regex/validation logic without invoking Claude.
 */
import { test, expect, describe } from "bun:test";
import { isValidGeneratedName, isDateFilename } from "../haiku";

// ─── isValidGeneratedName ──────────────────────────────────────────────────────

describe("isValidGeneratedName", () => {
  // --- valid inputs ---
  test("accepts a 3-word kebab name", () => {
    expect(isValidGeneratedName("check-disk-free")).toBe(true);
  });

  test("accepts a 4-word kebab name", () => {
    expect(isValidGeneratedName("daily-slack-report-job")).toBe(true);
  });

  test("accepts names with digits in the middle", () => {
    expect(isValidGeneratedName("sync-s3-bucket")).toBe(true);
  });

  test("accepts a minimal 3-char name (just meets minimum)", () => {
    // minimum: first char + 1 middle char + last char = 3 chars
    expect(isValidGeneratedName("abc")).toBe(true);
  });

  test("accepts a 40-char name (maximum allowed length)", () => {
    // regex: [a-z0-9] + {1,38} + [a-z0-9] = 2 + 38 = 40 max
    const name = "a" + "b".repeat(38) + "c"; // 40 chars
    expect(isValidGeneratedName(name)).toBe(true);
  });

  test("accepts names with digits as first char", () => {
    expect(isValidGeneratedName("3d-render-check")).toBe(true);
  });

  // --- invalid inputs ---
  test("rejects name with uppercase letters", () => {
    expect(isValidGeneratedName("Check-Disk-Free")).toBe(false);
  });

  test("rejects name with leading hyphen", () => {
    expect(isValidGeneratedName("-check-disk-free")).toBe(false);
  });

  test("rejects name with trailing hyphen", () => {
    expect(isValidGeneratedName("check-disk-free-")).toBe(false);
  });

  test("rejects name that is too short (2 chars)", () => {
    // minimum middle group {1,38} requires at least 1 char, so minimum total is 3
    expect(isValidGeneratedName("ab")).toBe(false);
  });

  test("rejects name that is too long (41 chars)", () => {
    const name = "a" + "b".repeat(39) + "c"; // 41 chars
    expect(isValidGeneratedName(name)).toBe(false);
  });

  test("rejects name with spaces", () => {
    expect(isValidGeneratedName("check disk free")).toBe(false);
  });

  test("rejects name with underscores", () => {
    expect(isValidGeneratedName("check_disk_free")).toBe(false);
  });

  test("rejects name with dots", () => {
    expect(isValidGeneratedName("check.disk.free")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isValidGeneratedName("")).toBe(false);
  });

  test("rejects name with file extension", () => {
    expect(isValidGeneratedName("check-disk-free.md")).toBe(false);
  });

  test("rejects name with backticks", () => {
    expect(isValidGeneratedName("`check-disk-free`")).toBe(false);
  });

  test("rejects name with quotes", () => {
    expect(isValidGeneratedName('"check-disk-free"')).toBe(false);
  });

  test("rejects name with newline", () => {
    expect(isValidGeneratedName("check-disk\nfree")).toBe(false);
  });

  test("rejects name with slash", () => {
    expect(isValidGeneratedName("check/disk/free")).toBe(false);
  });
});

// ─── isDateFilename ────────────────────────────────────────────────────────────

describe("isDateFilename", () => {
  // --- valid patterns ---
  test("accepts standard YYYY-MM-DD-HHmm.md filename", () => {
    expect(isDateFilename("2026-05-22-2156.md")).toBe(true);
  });

  test("accepts midnight timestamp", () => {
    expect(isDateFilename("2024-01-01-0000.md")).toBe(true);
  });

  test("accepts end-of-day timestamp", () => {
    expect(isDateFilename("2024-12-31-2359.md")).toBe(true);
  });

  test("accepts all-zero digits", () => {
    expect(isDateFilename("0000-00-00-0000.md")).toBe(true);
  });

  test("accepts all-nine digits", () => {
    expect(isDateFilename("9999-99-99-9999.md")).toBe(true);
  });

  // --- invalid patterns ---
  test("rejects a normal kebab name", () => {
    expect(isDateFilename("check-disk-free.md")).toBe(false);
  });

  test("rejects filename without .md extension", () => {
    expect(isDateFilename("2026-05-22-2156")).toBe(false);
  });

  test("rejects filename with wrong extension", () => {
    expect(isDateFilename("2026-05-22-2156.txt")).toBe(false);
  });

  test("rejects date pattern without time part", () => {
    expect(isDateFilename("2026-05-22.md")).toBe(false);
  });

  test("rejects date pattern with too few time digits (3)", () => {
    expect(isDateFilename("2026-05-22-215.md")).toBe(false);
  });

  test("rejects date pattern with too many time digits (5)", () => {
    expect(isDateFilename("2026-05-22-21566.md")).toBe(false);
  });

  test("rejects date pattern with a leading subdirectory", () => {
    // isDateFilename takes the bare filename, not a path
    expect(isDateFilename("subdir/2026-05-22-2156.md")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isDateFilename("")).toBe(false);
  });

  test("rejects letters in the numeric fields", () => {
    expect(isDateFilename("2026-XX-22-2156.md")).toBe(false);
  });
});
