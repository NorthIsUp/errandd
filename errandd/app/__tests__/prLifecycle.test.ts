import { describe, expect, test } from "bun:test";
import {
  classifyCheck,
  formatPrLifecycle,
  parsePrLifecycle,
  type PrLifecycleData,
} from "../hooks/prLifecycle";

describe("classifyCheck", () => {
  test("failing conclusions", () => {
    for (const c of ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR"]) {
      expect(classifyCheck({ name: "x", status: "COMPLETED", conclusion: c })).toBe("failing");
    }
    // StatusContext (no status) carrying a FAILURE state
    expect(classifyCheck({ name: "legacy", conclusion: "FAILURE" })).toBe("failing");
  });

  test("pending while not completed, regardless of conclusion", () => {
    expect(classifyCheck({ name: "x", status: "IN_PROGRESS" })).toBe("pending");
    expect(classifyCheck({ name: "x", status: "QUEUED" })).toBe("pending");
    expect(classifyCheck({ name: "x", conclusion: "PENDING" })).toBe("pending");
    // completed CheckRun with no conclusion yet ≈ still settling
    expect(classifyCheck({ name: "x", status: "COMPLETED" })).toBe("pending");
  });

  test("passing conclusions", () => {
    for (const c of ["SUCCESS", "NEUTRAL", "SKIPPED"]) {
      expect(classifyCheck({ name: "x", status: "COMPLETED", conclusion: c })).toBe("passing");
    }
    expect(classifyCheck({ name: "legacy", conclusion: "SUCCESS" })).toBe("passing");
  });
});

describe("formatPrLifecycle", () => {
  const base: PrLifecycleData = {
    repo: "teamclara/Clara_V1",
    number: 1763,
    title: "Fix magic-link email verification",
    state: "OPEN",
    isDraft: false,
    mergeable: "CONFLICTING",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "APPROVED",
    baseRefName: "main",
    headRefName: "fix/magic-link",
    checks: [
      { name: "Quality Gate", status: "COMPLETED", conclusion: "FAILURE" },
      { name: "pytest", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "deploy-preview", status: "IN_PROGRESS" },
    ],
  };

  test("surfaces the failing check and authoritative framing", () => {
    const out = formatPrLifecycle(base);
    expect(out).toContain("AUTHORITATIVE");
    expect(out).toContain("teamclara/Clara_V1#1763");
    expect(out).toContain("APPROVED");
    expect(out).toContain("CONFLICTING");
    expect(out).toContain("merge state: BLOCKED");
    // CI summary counts + the failing check spelled out
    expect(out).toContain("❌ 1 failing");
    expect(out).toContain("⏳ 1 pending");
    expect(out).toContain("✅ 1 passing");
    expect(out).toContain("Quality Gate — FAILURE");
    expect(out).toContain("deploy-preview — IN_PROGRESS");
    // passing checks are NOT individually listed
    expect(out).not.toContain("pytest — SUCCESS");
  });

  test("merged PR is flagged as done", () => {
    const out = formatPrLifecycle({ ...base, state: "MERGED", checks: [] });
    expect(out).toContain("MERGED");
    expect(out).toContain("already merged");
    expect(out).toContain("no checks reported");
  });

  test("closed-not-merged is flagged", () => {
    const out = formatPrLifecycle({ ...base, state: "CLOSED" });
    expect(out).toContain("closed (not merged)");
  });
});

describe("parsePrLifecycle", () => {
  test("normalizes CheckRun and StatusContext rollup entries", () => {
    const data = parsePrLifecycle("o/r", {
      number: 7,
      title: "t",
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      baseRefName: "main",
      headRefName: "feat",
      statusCheckRollup: [
        { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "StatusContext", context: "ci/legacy", state: "FAILURE" },
        { nonsense: true },
      ],
    });
    expect(data).not.toBeNull();
    expect(data?.number).toBe(7);
    expect(data?.checks).toEqual([
      { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "ci/legacy", conclusion: "FAILURE" },
    ]);
  });

  test("returns null without a usable number", () => {
    expect(parsePrLifecycle("o/r", { title: "no number" })).toBeNull();
    expect(parsePrLifecycle("o/r", null)).toBeNull();
  });
});
