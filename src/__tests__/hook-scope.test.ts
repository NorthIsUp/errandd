import { describe, expect, test } from "bun:test";
import { extractHookScope } from "../hooks/match";

describe("extractHookScope", () => {
  test("pull_request → pr-<num>-<slug>", () => {
    expect(
      extractHookScope("pull_request", {
        pull_request: { number: 42, head: { ref: "feature/auth-redo" } },
      }),
    ).toBe("pr-42-feature-auth-redo");
  });

  test("issue_comment on a PR → pr-<num> (no branch in payload)", () => {
    expect(
      extractHookScope("issue_comment", {
        issue: { number: 7, pull_request: { url: "..." } },
      }),
    ).toBe("pr-7");
  });

  test("issue_comment on a plain issue → null", () => {
    expect(
      extractHookScope("issue_comment", { issue: { number: 7 } }),
    ).toBeNull();
  });

  test("pull_request_review → uses head ref", () => {
    expect(
      extractHookScope("pull_request_review", {
        pull_request: { number: 100, head: { ref: "main" } },
      }),
    ).toBe("pr-100-main");
  });

  test("non-PR event (push) → null", () => {
    expect(extractHookScope("push", { ref: "refs/heads/main" })).toBeNull();
  });

  test("ref with weird chars gets slugged", () => {
    expect(
      extractHookScope("pull_request", {
        pull_request: { number: 1, head: { ref: "Feature/UPPER_Case With Spaces!" } },
      }),
    ).toBe("pr-1-feature-upper_case-with-spaces");
  });

  test("ref shorter than slug limit is preserved", () => {
    expect(
      extractHookScope("pull_request", {
        pull_request: { number: 1, head: { ref: "abc" } },
      }),
    ).toBe("pr-1-abc");
  });

  test("null / non-object payloads → null", () => {
    expect(extractHookScope("pull_request", null)).toBeNull();
    expect(extractHookScope("pull_request", "garbage")).toBeNull();
  });
});
