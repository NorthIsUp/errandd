import { describe, expect, test } from "bun:test";
import { extractHookScope } from "../hooks/match";

describe("extractHookScope", () => {
  // PR number is the stable identity — intentionally NO branch slug, so a
  // force-push that renames the head doesn't fork the conversation.
  test("pull_request → pr-<num> (no slug)", () => {
    expect(
      extractHookScope("pull_request", {
        pull_request: { number: 42, head: { ref: "feature/auth-redo" } },
      }),
    ).toBe("pr-42");
  });

  test("issue_comment on a PR → pr-<num>", () => {
    expect(
      extractHookScope("issue_comment", {
        issue: { number: 7, pull_request: { url: "..." } },
      }),
    ).toBe("pr-7");
  });

  test("issue_comment on a plain issue → issue-<num>", () => {
    expect(extractHookScope("issue_comment", { issue: { number: 7 } })).toBe("issue-7");
  });

  test("pull_request_review → pr-<num>", () => {
    expect(
      extractHookScope("pull_request_review", {
        pull_request: { number: 100, head: { ref: "main" } },
      }),
    ).toBe("pr-100");
  });

  // CI events carry the PR they belong to in `pull_requests` — coalesce onto
  // that PR's thread so the babysit loop re-enters the same session.
  test("check_run with a PR → pr-<num>", () => {
    expect(
      extractHookScope("check_run", {
        check_run: {
          status: "completed",
          pull_requests: [{ number: 42 }],
          check_suite: { head_branch: "feature/auth-redo" },
        },
      }),
    ).toBe("pr-42");
  });

  test("check_suite with a PR → pr-<num>", () => {
    expect(
      extractHookScope("check_suite", {
        check_suite: { pull_requests: [{ number: 99 }], head_branch: "x" },
      }),
    ).toBe("pr-99");
  });

  test("workflow_run with a PR → pr-<num>", () => {
    expect(
      extractHookScope("workflow_run", {
        workflow_run: { pull_requests: [{ number: 5 }], head_branch: "x" },
      }),
    ).toBe("pr-5");
  });

  // No PR in the array (fork PRs / timing) → fall back to the branch scope.
  test("check_run with empty pull_requests → branch-<slug>", () => {
    expect(
      extractHookScope("check_run", {
        check_run: { pull_requests: [], check_suite: { head_branch: "feature/x" } },
      }),
    ).toBe("branch-feature-x");
  });

  // push carries no PR — branch is the coalescing key.
  test("push → branch-<slug>", () => {
    expect(extractHookScope("push", { ref: "refs/heads/main" })).toBe("branch-main");
  });

  test("branch ref with weird chars gets slugged", () => {
    expect(extractHookScope("push", { ref: "refs/heads/Feature/UPPER_Case With Spaces!" })).toBe(
      "branch-feature-upper_case-with-spaces",
    );
  });

  test("null / non-object payloads → null", () => {
    expect(extractHookScope("pull_request", null)).toBeNull();
    expect(extractHookScope("pull_request", "garbage")).toBeNull();
  });
});
