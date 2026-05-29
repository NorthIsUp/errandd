import { describe, expect, test } from "bun:test";
import type { Job } from "../jobs";
import { staticSkipReason } from "../hooks/skip";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    name: "test",
    schedule: "*/5 * * * *",
    prompt: "do the thing",
    recurring: true,
    reuseSession: false,
    ...overrides,
  } as Job;
}

describe("staticSkipReason", () => {
  test("returns null for unknown payload", () => {
    expect(staticSkipReason("pull_request", null, makeJob())).toBeNull();
  });

  // Bot actors are NOT statically skipped. Self-events are dropped upstream
  // in the receiver (via the resolved self login); excluding other bots is
  // the routine's call through its `user` globs, not a blanket daemon rule.
  test("does not skip bot users on a non-main PR", () => {
    const skip = staticSkipReason(
      "pull_request",
      {
        action: "opened",
        sender: { login: "dependabot[bot]" },
        pull_request: { number: 42, base: { ref: "feature/x" } },
      },
      makeJob(),
    );
    expect(skip).toBeNull();
  });

  test("does not skip bot commenters on issue_comment", () => {
    const skip = staticSkipReason(
      "issue_comment",
      {
        action: "created",
        sender: { login: "human" },
        comment: { user: { login: "github-actions[bot]" } },
        issue: { number: 7, pull_request: {} },
      },
      makeJob(),
    );
    expect(skip).toBeNull();
  });

  test("flags PR targeting main", () => {
    const skip = staticSkipReason(
      "pull_request",
      {
        action: "opened",
        sender: { login: "alice" },
        pull_request: { number: 99, base: { ref: "main" } },
      },
      makeJob(),
    );
    expect(skip?.reason).toBe("PR targets main");
    expect(skip?.message).toContain("PR #99");
    expect(skip?.message).toContain("release/landing");
  });

  test("does not skip when PR targets a non-main branch", () => {
    const skip = staticSkipReason(
      "pull_request",
      {
        action: "opened",
        sender: { login: "alice" },
        pull_request: { number: 5, base: { ref: "develop" } },
      },
      makeJob(),
    );
    expect(skip).toBeNull();
  });

  test("does not skip when actor is a human and base is not main", () => {
    expect(
      staticSkipReason(
        "issue_comment",
        {
          action: "created",
          sender: { login: "alice" },
          comment: { user: { login: "bob" } },
          issue: { number: 1, pull_request: {} },
        },
        makeJob(),
      ),
    ).toBeNull();
  });

  test("honors hookConfig.skipSelf=false opt-out", () => {
    const job = makeJob({
      hookConfig: { pr: [], skipSelf: false },
    });
    expect(
      staticSkipReason(
        "pull_request",
        {
          action: "opened",
          sender: { login: "dependabot[bot]" },
          pull_request: { number: 42, base: { ref: "main" } },
        },
        job,
      ),
    ).toBeNull();
  });

  test("ignores base=main on comment events that don't carry a base ref", () => {
    // issue_comment doesn't have pull_request.base — the static "PR targets main"
    // rule shouldn't accidentally fire on non-PR events.
    const skip = staticSkipReason(
      "issue_comment",
      {
        action: "created",
        sender: { login: "alice" },
        comment: { user: { login: "bob" } },
        issue: { number: 3, pull_request: {} },
      },
      makeJob(),
    );
    expect(skip).toBeNull();
  });
});
