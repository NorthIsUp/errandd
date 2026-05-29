import { describe, expect, test } from "bun:test";
import type { Job } from "../jobs";
import { parseTriggers } from "../hooks/schema";
import { handleWebhook } from "../hooks/receiver";

// The matcher (+ the routine's `on:` config) is the SINGLE source of truth for
// which deliveries fire. There is no server-side "static skip" layer that can
// override config — these tests lock that behavior, in particular that comment
// events fire purely on the `comments` config regardless of the PR's base
// branch (the bug where a `comments: true` routine got skipped on a
// main-targeting PR).

function makeJob(name: string, on: unknown[], skipSelf?: boolean): Job {
  const { schedules, hookConfig } = parseTriggers(on, skipSelf === false ? false : undefined);
  return {
    name,
    schedules,
    prompt: "do the thing",
    recurring: false,
    notify: true,
    reuseSession: false,
    ...(hookConfig ? { hookConfig } : {}),
  } as Job;
}

let deliverySeq = 0;
function ghRequest(event: string, body: unknown): Request {
  deliverySeq += 1;
  return new Request("http://local/api/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": `test-${deliverySeq}-${event}`,
    },
    body: JSON.stringify(body),
  });
}

async function firedJobs(event: string, body: unknown, jobs: Job[]): Promise<string[]> {
  const fired: string[] = [];
  await handleWebhook(ghRequest(event, body), {
    getJobs: () => jobs,
    onHookFire: (name: string) => {
      fired.push(name);
    },
  });
  return fired;
}

async function skipReasons(event: string, body: unknown, jobs: Job[]): Promise<string[]> {
  const reasons: string[] = [];
  await handleWebhook(ghRequest(event, body), {
    getJobs: () => jobs,
    onHookFire: () => {},
    onHookSkip: (_name: string, _e: string, _d: string, _p: unknown, reason: string) => {
      reasons.push(reason);
    },
  });
  return reasons;
}

describe("webhook matcher — config is authoritative", () => {
  test("comment on a main-targeting PR fires when comments: true", async () => {
    const job = makeJob("pr-comments", [{ comments: true }]);
    const fired = await firedJobs(
      "pull_request_review_comment",
      {
        action: "created",
        repository: { full_name: "teamclara/Clara_V1" },
        pull_request: { number: 1544, base: { ref: "main" }, head: { ref: "feature/x" } },
        comment: { user: { login: "cursor[bot]" } },
        sender: { login: "cursor[bot]" },
      },
      [job],
    );
    expect(fired).toContain("pr-comments");
  });

  test("comment fires for any commenter (incl. bots) when comments: true", async () => {
    const job = makeJob("pr-comments", [{ comments: true }]);
    const fired = await firedJobs(
      "issue_comment",
      {
        action: "created",
        repository: { full_name: "org/repo" },
        issue: { number: 7, pull_request: { url: "x" } },
        comment: { user: { login: "datadog-official[bot]" } },
        sender: { login: "datadog-official[bot]" },
      },
      [job],
    );
    expect(fired).toContain("pr-comments");
  });

  test("pull_request opened on main does NOT fire under prs: true (branch !main)", async () => {
    const job = makeJob("pr-comments", [{ prs: true }]);
    const fired = await firedJobs(
      "pull_request",
      {
        action: "opened",
        repository: { full_name: "org/repo" },
        pull_request: {
          number: 10,
          base: { ref: "main" },
          head: { ref: "feature/x" },
          user: { login: "alice" },
          draft: false,
          labels: [],
        },
        sender: { login: "alice" },
      },
      [job],
    );
    expect(fired).not.toContain("pr-comments");
  });

  // Comment matching keys on the ACTOR (sender), not the comment author.
  // A GitHub App authors comments as its bot user, but `sender` is who
  // triggered it — a humans-only filter should fire when a human acted
  // through an app, and skip a genuine bot action.
  test("humans-only comment fires when sender is human (app authored)", async () => {
    // skip_self: false isolates the user-glob from the self-skip (which would
    // otherwise depend on the test runner's resolved `gh` login).
    const job = makeJob("pr-comments", [{ comments: { user: ["*", "!*[bot]"] } }], false);
    const fired = await firedJobs(
      "pull_request_review_comment",
      {
        action: "created",
        repository: { full_name: "teamclara/Clara_V1" },
        pull_request: { number: 1424, base: { ref: "main" }, head: { ref: "feat/x" } },
        comment: { user: { login: "graphite-app[bot]" } },
        sender: { login: "some-human" },
      },
      [job],
    );
    expect(fired).toContain("pr-comments");
  });

  test("humans-only comment skips when sender is a bot", async () => {
    const job = makeJob("pr-comments", [{ comments: { user: ["*", "!*[bot]"] } }]);
    const fired = await firedJobs(
      "issue_comment",
      {
        action: "created",
        repository: { full_name: "org/repo" },
        issue: { number: 9, pull_request: { url: "x" } },
        comment: { user: { login: "NorthIsUp" } },
        sender: { login: "graphite-app[bot]" },
      },
      [job],
    );
    expect(fired).not.toContain("pr-comments");
  });

  test("pull_request opened on a feature branch fires under prs: true", async () => {
    const job = makeJob("pr-comments", [{ prs: true }]);
    const fired = await firedJobs(
      "pull_request",
      {
        action: "opened",
        repository: { full_name: "org/repo" },
        pull_request: {
          number: 11,
          base: { ref: "develop" },
          head: { ref: "feature/y" },
          user: { login: "alice" },
          draft: false,
          labels: [],
        },
        sender: { login: "alice" },
      },
      [job],
    );
    expect(fired).toContain("pr-comments");
  });

  // Config-driven skips surface a reason (no Claude spawned) instead of a
  // silent drop.
  test("PR on main under prs: true emits a base-branch skip reason", async () => {
    const job = makeJob("pr-comments", [{ prs: true }]);
    const reasons = await skipReasons(
      "pull_request",
      {
        action: "opened",
        repository: { full_name: "org/repo" },
        pull_request: {
          number: 12,
          base: { ref: "main" },
          head: { ref: "f/x" },
          user: { login: "alice" },
          draft: false,
          labels: [],
        },
        sender: { login: "alice" },
      },
      [job],
    );
    expect(reasons.some((r) => r.includes("base branch") && r.includes("main"))).toBe(true);
  });

  test("bot comment under humans-only emits a user-filter skip reason", async () => {
    const job = makeJob("pr-comments", [{ comments: { user: ["*", "!*[bot]"] } }]);
    const reasons = await skipReasons(
      "issue_comment",
      {
        action: "created",
        repository: { full_name: "org/repo" },
        issue: { number: 3, pull_request: { url: "x" } },
        comment: { user: { login: "x" } },
        sender: { login: "graphite-app[bot]" },
      },
      [job],
    );
    expect(reasons.some((r) => r.includes("not matched by the comment user filter"))).toBe(true);
  });
});
