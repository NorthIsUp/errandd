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

function makeJob(name: string, on: unknown[]): Job {
  const { schedules, hookConfig } = parseTriggers(on, undefined);
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
});
