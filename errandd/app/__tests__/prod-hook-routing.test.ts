import { describe, expect, test } from "bun:test";
import { handleWebhook } from "../hooks/receiver";
import { parseTriggers } from "../hooks/schema";
import type { Job } from "../jobs";

/**
 * Production-derived hook-routing coverage.
 *
 * Asserts that the receiver routes every GitHub webhook event type to the right
 * routines, using the CURRENT deployed routine configs (transcribed from the
 * managed jobs repo's `on:` blocks). Payloads are synthetic + leak-safe
 * (repo `acme/app`, neutral human handle `alice`, real public bot logins where
 * they drive routing) but carry the real structural variety seen in production:
 * PR actions, base branches, the `claw:babysit` label, review states, and
 * commenter identities (human / denylisted noise bot / allowed bug-bot).
 *
 * Sentry/Datadog events go through their own handlers (see
 * provider-receivers.test.ts) — this file covers the GitHub receiver, which is
 * what PRs like #1803/#1804 actually exercise.
 *
 * The deployed configs encoded here:
 *   pr-review   : pr rule, any repo/user, any base branch (opened/sync/reopened, non-draft)
 *   pr-comments : same pr rule + a comments rule (any user minus the noise bots)
 *   pr-accepted : reviews rule, states approved (pull_request_review only)
 *   pr-babysit  : pr rule requiring the claw:babysit label, action incl. labeled
 *   pr-sweep / dependabot-merge : schedule-only, never fire on a webhook
 */

function makeJob(name: string, on: unknown[]): Job {
  const { schedules, hookConfig } = parseTriggers(on, undefined);
  return {
    name,
    schedules,
    prompt: "x",
    recurring: false,
    notify: true,
    reuseSession: false,
    ...(hookConfig ? { hookConfig } : {}),
  };
}

const NOISE_BOTS = [
  "*",
  "!github-actions[bot]",
  "!linear-code[bot]",
  "!greptile-apps[bot]",
  "!graphite-app[bot]",
  "!pulumi[bot]",
  "!sonarqubecloud[bot]",
  "!dependabot[bot]",
];

/** The live production routine set (GitHub-relevant routines). */
function prodJobs(): Job[] {
  return [
    makeJob("pr-review", [{ pr: { repo: ["*/*"], user: ["*"], branch: ["*"] } }]),
    makeJob("pr-comments", [
      { pr: { repo: ["*/*"], user: ["*"], branch: ["*"] } },
      { comments: { user: NOISE_BOTS } },
    ]),
    makeJob("pr-accepted", [{ reviews: { states: ["approved"] } }]),
    makeJob("pr-babysit", [
      {
        pr: {
          repo: ["*/*"],
          user: ["*"],
          labels: ["claw:babysit"],
          action: ["opened", "synchronize", "reopened", "labeled"],
        },
      },
    ]),
    // schedule-only routine — present to prove it never matches a webhook
    makeJob("pr-sweep", [{ schedule: "17 * * * *" }]),
  ];
}

let seq = 0;
async function firedJobs(event: string, body: unknown): Promise<string[]> {
  seq += 1;
  const req = new Request("http://local/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": `prodhook-${seq}`,
    },
    body: JSON.stringify(body),
  });
  const fired: string[] = [];
  const jobs = prodJobs();
  await handleWebhook(req, {
    getJobs: () => jobs,
    onHookFire: (name: string) => {
      fired.push(name);
    },
  });
  return fired.sort();
}

// ---- payload builders (synthetic, leak-safe, real structural shape) -------

function prEvent(
  action: string,
  opts: { base?: string; draft?: boolean; labels?: string[]; user?: string; num?: number } = {},
): unknown {
  const { base = "main", draft = false, labels = [], user = "alice", num = 1803 } = opts;
  return {
    action,
    number: num,
    pull_request: {
      number: num,
      title: "",
      draft,
      base: { ref: base },
      head: { ref: "feature/x" },
      user: { login: user },
      labels: labels.map((name) => ({ name })),
    },
    repository: { full_name: "acme/app" },
    sender: { login: user },
  };
}

function reviewEvent(state: string, reviewer = "alice", num = 1803): unknown {
  return {
    action: "submitted",
    review: { state, user: { login: reviewer }, body: "" },
    pull_request: { number: num },
    repository: { full_name: "acme/app" },
    sender: { login: reviewer },
  };
}

function reviewCommentEvent(author: string, num = 1804): unknown {
  return {
    action: "created",
    comment: { body: "", user: { login: author } },
    pull_request: { number: num },
    repository: { full_name: "acme/app" },
    sender: { login: author },
  };
}

function issueCommentEvent(author: string, num = 1803): unknown {
  return {
    action: "created",
    comment: { body: "", user: { login: author } },
    issue: { number: num, pull_request: { url: "x" } },
    repository: { full_name: "acme/app" },
    sender: { login: author },
  };
}

// ---------------------------------------------------------------------------

describe("pull_request routing", () => {
  test("opened on main → pr-review + pr-comments (not babysit: no label)", async () => {
    expect(await firedJobs("pull_request", prEvent("opened"))).toEqual(["pr-comments", "pr-review"]);
  });

  test("synchronize → pr-review + pr-comments", async () => {
    expect(await firedJobs("pull_request", prEvent("synchronize"))).toEqual([
      "pr-comments",
      "pr-review",
    ]);
  });

  test("reopened on a feature branch → pr-review + pr-comments (branch * matches non-main)", async () => {
    expect(await firedJobs("pull_request", prEvent("reopened", { base: "release/9" }))).toEqual([
      "pr-comments",
      "pr-review",
    ]);
  });

  test("opened WITH claw:babysit label → pr-review + pr-comments + pr-babysit", async () => {
    expect(
      await firedJobs("pull_request", prEvent("opened", { labels: ["claw:babysit"] })),
    ).toEqual(["pr-babysit", "pr-comments", "pr-review"]);
  });

  test("labeled (claw:babysit) → pr-babysit ONLY (review/comments don't list `labeled`)", async () => {
    expect(
      await firedJobs("pull_request", prEvent("labeled", { labels: ["claw:babysit"] })),
    ).toEqual(["pr-babysit"]);
  });

  test("closed → nothing (no routine subscribes to closed)", async () => {
    expect(await firedJobs("pull_request", prEvent("closed"))).toEqual([]);
  });

  test("draft opened → nothing (all PR rules skip drafts by default)", async () => {
    expect(
      await firedJobs("pull_request", prEvent("opened", { draft: true, labels: ["claw:babysit"] })),
    ).toEqual([]);
  });
});

describe("pull_request_review routing (reviews: trigger + comments fall-through)", () => {
  test("approved by human → pr-accepted (reviews) + pr-comments (allowed commenter)", async () => {
    expect(await firedJobs("pull_request_review", reviewEvent("approved", "alice"))).toEqual([
      "pr-accepted",
      "pr-comments",
    ]);
  });

  test("changes_requested → pr-comments only (not an approval, so no pr-accepted)", async () => {
    expect(await firedJobs("pull_request_review", reviewEvent("changes_requested"))).toEqual([
      "pr-comments",
    ]);
  });

  test("commented → pr-comments only", async () => {
    expect(await firedJobs("pull_request_review", reviewEvent("commented"))).toEqual([
      "pr-comments",
    ]);
  });

  test("approved by cursor[bot] → pr-accepted + pr-comments (cursor not denylisted)", async () => {
    expect(await firedJobs("pull_request_review", reviewEvent("approved", "cursor[bot]"))).toEqual([
      "pr-accepted",
      "pr-comments",
    ]);
  });

  test("approved by a denylisted noise bot → pr-accepted only (reviews user is any; pr-comments drops the bot)", async () => {
    expect(
      await firedJobs("pull_request_review", reviewEvent("approved", "github-actions[bot]")),
    ).toEqual(["pr-accepted"]);
  });
});

describe("pull_request_review_comment routing (the #1804 Bugbot case)", () => {
  test("cursor[bot] inline finding → pr-comments only; pr-accepted does NOT wake", async () => {
    // The whole point of moving pr-accepted to reviews: a review COMMENT (not an
    // approval) must no longer spin pr-accepted just to [skip].
    expect(await firedJobs("pull_request_review_comment", reviewCommentEvent("cursor[bot]"))).toEqual(
      ["pr-comments"],
    );
  });

  test("human review comment → pr-comments only", async () => {
    expect(await firedJobs("pull_request_review_comment", reviewCommentEvent("alice"))).toEqual([
      "pr-comments",
    ]);
  });

  test("github-actions[bot] review comment → nothing (denylisted; pr-accepted unaffected)", async () => {
    expect(
      await firedJobs("pull_request_review_comment", reviewCommentEvent("github-actions[bot]")),
    ).toEqual([]);
  });
});

describe("issue_comment routing", () => {
  test("human comment → pr-comments only (pr-accepted no longer fires on comments)", async () => {
    expect(await firedJobs("issue_comment", issueCommentEvent("alice"))).toEqual(["pr-comments"]);
  });

  test("denylisted bot (linear-code[bot]) → nothing", async () => {
    expect(await firedJobs("issue_comment", issueCommentEvent("linear-code[bot]"))).toEqual([]);
  });

  test("denylisted bot (dependabot[bot]) → nothing", async () => {
    expect(await firedJobs("issue_comment", issueCommentEvent("dependabot[bot]"))).toEqual([]);
  });
});

describe("events no routine subscribes to → nothing fires (no misrouting)", () => {
  test("issues (opened) → nothing", async () => {
    expect(
      await firedJobs("issues", {
        action: "opened",
        issue: { number: 5, title: "", labels: [], user: { login: "alice" } },
        repository: { full_name: "acme/app" },
        sender: { login: "alice" },
      }),
    ).toEqual([]);
  });

  test("check_run (failure) → nothing (no routine subscribes to checks)", async () => {
    expect(
      await firedJobs("check_run", {
        action: "completed",
        check_run: {
          name: "CI",
          status: "completed",
          conclusion: "failure",
          check_suite: { head_branch: "main" },
        },
        repository: { full_name: "acme/app" },
        sender: { login: "github-actions[bot]" },
      }),
    ).toEqual([]);
  });

  test("workflow_run (success) → nothing", async () => {
    expect(
      await firedJobs("workflow_run", {
        action: "completed",
        workflow_run: {
          name: "deploy",
          status: "completed",
          conclusion: "success",
          head_branch: "main",
        },
        repository: { full_name: "acme/app" },
        sender: { login: "github-actions[bot]" },
      }),
    ).toEqual([]);
  });

  test("deployment_status (success) → nothing", async () => {
    expect(
      await firedJobs("deployment_status", {
        deployment_status: { state: "success" },
        repository: { full_name: "acme/app" },
        sender: { login: "github-actions[bot]" },
      }),
    ).toEqual([]);
  });
});
