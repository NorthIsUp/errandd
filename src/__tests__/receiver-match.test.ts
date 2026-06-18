import { describe, expect, test } from "bun:test";
import { recentDeliveries } from "../hooks/deliveries";
import { handleWebhook } from "../hooks/receiver";
import { parseTriggers } from "../hooks/schema";
import type { Job } from "../jobs";

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
  return new Request("http://local/api/webhooks/github", {
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

/** Capture skip (reason, prefilter) pairs so tests can assert the prefilter
 *  `[skip:fyi]` bot-noise drops distinctly from plain config skips. */
async function skipOutcomes(
  event: string,
  body: unknown,
  jobs: Job[],
): Promise<{ reason: string; prefilter: boolean }[]> {
  const out: { reason: string; prefilter: boolean }[] = [];
  await handleWebhook(ghRequest(event, body), {
    getJobs: () => jobs,
    onHookFire: () => {},
    onHookSkip: (
      _name: string,
      _e: string,
      _d: string,
      _p: unknown,
      reason: string,
      prefilter?: boolean,
    ) => {
      out.push({ reason, prefilter: prefilter === true });
    },
  });
  return out;
}

/** The per-routine outcomes recorded onto the delivery (drives the Deliveries
 *  table) — including the synthetic delivery-level "no matching rule" entry the
 *  onHookSkip callback never sees. Finds the just-recorded delivery by id. */
async function deliveryRoutines(
  event: string,
  body: unknown,
  jobs: Job[],
): Promise<{ job: string; outcome: string; reason?: string }[]> {
  const req = ghRequest(event, body);
  const id = req.headers.get("x-github-delivery") ?? "";
  await handleWebhook(req, { getJobs: () => jobs, onHookFire: () => {}, onHookSkip: () => {} });
  return recentDeliveries().find((d) => d.id === id)?.routines ?? [];
}

/** Like firedJobs but with a `hasActiveThread` dep, so `requireActiveThread`
 *  checks rules can be exercised. `active` is the set of threadIds that exist. */
async function firedJobsWithThreads(
  event: string,
  body: unknown,
  jobs: Job[],
  active: Set<string>,
): Promise<string[]> {
  const fired: string[] = [];
  await handleWebhook(ghRequest(event, body), {
    getJobs: () => jobs,
    onHookFire: (name: string) => {
      fired.push(name);
    },
    onHookSkip: () => {},
    hasActiveThread: (threadId: string) => active.has(threadId),
  });
  return fired;
}

describe("checks (CI) webhooks", () => {
  const checkRun = (conclusion: string, extra: Record<string, unknown> = {}) => ({
    action: "completed",
    repository: { full_name: "org/repo" },
    check_run: {
      name: "build",
      status: "completed",
      conclusion,
      head_sha: "abcdef1234567",
      check_suite: { head_branch: "feature/x" },
      ...extra,
    },
    sender: { login: "github-actions[bot]" },
  });

  test("a failing check fires a `checks: true` routine (bad-CI default)", async () => {
    const job = makeJob("ci", [{ checks: true }], false);
    expect(await firedJobs("check_run", checkRun("failure"), [job])).toContain("ci");
  });

  test("a green check is skipped with a conclusion reason (not silently dropped)", async () => {
    const job = makeJob("ci", [{ checks: true }], false);
    expect(await firedJobs("check_run", checkRun("success"), [job])).not.toContain("ci");
    const reasons = await skipReasons("check_run", checkRun("success"), [job]);
    expect(reasons.some((r) => r.includes("conclusion") && r.includes("success"))).toBe(true);
  });

  test("an in-progress check (no conclusion yet) is skipped, not fired", async () => {
    const job = makeJob("ci", [{ checks: true }], false);
    const inProgress = {
      action: "created",
      repository: { full_name: "org/repo" },
      check_run: { name: "build", status: "in_progress", conclusion: null },
      sender: { login: "x" },
    };
    expect(await firedJobs("check_run", inProgress, [job])).not.toContain("ci");
  });

  test("branch filter narrows by head branch", async () => {
    const job = makeJob("ci", [{ checks: { conclusion: ["failure"], branch: ["main"] } }], false);
    expect(await firedJobs("check_run", checkRun("failure"), [job])).not.toContain("ci");
    const onMain = checkRun("failure", { check_suite: { head_branch: "main" } });
    expect(await firedJobs("check_run", onMain, [job])).toContain("ci");
  });

  test("workflow_run is covered by the same checks rule", async () => {
    const job = makeJob("ci", [{ checks: true }], false);
    const wf = {
      action: "completed",
      repository: { full_name: "org/repo" },
      workflow_run: { name: "CI", status: "completed", conclusion: "timed_out", head_branch: "f/x" },
      sender: { login: "x" },
    };
    expect(await firedJobs("workflow_run", wf, [job])).toContain("ci");
  });

  const wfRun = (name: string, conclusion: string, extra: Record<string, unknown> = {}) => ({
    action: "completed",
    repository: { full_name: "org/repo" },
    workflow_run: { name, status: "completed", conclusion, head_branch: "f/x", ...extra },
    sender: { login: "x" },
  });

  test("`only` allowlist fires solely on listed workflows (alias for name)", async () => {
    const job = makeJob("ci", [{ checks: { conclusion: ["failure"], only: ["CI Testing"] } }], false);
    expect(await firedJobs("workflow_run", wfRun("Deploy", "failure"), [job])).not.toContain("ci");
    expect(await firedJobs("workflow_run", wfRun("CI Testing", "failure"), [job])).toContain("ci");
  });

  test("`ignore` denylist drops listed workflows (deny wins)", async () => {
    const job = makeJob("ci", [{ checks: { conclusion: ["failure"], ignore: ["CI Auto-fix", "*Dependabot*"] } }], false);
    expect(await firedJobs("workflow_run", wfRun("CI Auto-fix", "failure"), [job])).not.toContain("ci");
    expect(await firedJobs("workflow_run", wfRun("CI Testing", "failure"), [job])).toContain("ci");
    const reasons = await skipReasons("workflow_run", wfRun("CI Auto-fix", "failure"), [job]);
    expect(reasons.some((r) => r.includes("ignore"))).toBe(true);
  });

  test("non-completed CI events are early-dropped (no dispatch, no skip recorded)", async () => {
    const job = makeJob("ci", [{ checks: true }], false);
    // action != completed (requested/in_progress) → can't match → early-dropped
    const requested = {
      action: "requested",
      repository: { full_name: "org/repo" },
      check_suite: { status: "queued", conclusion: null, head_branch: "f/x" },
      sender: { login: "x" },
    };
    expect(await firedJobs("check_suite", requested, [job])).not.toContain("ci");
    // and it produces NO routine outcome at all (dropped before dispatch)
    const routs = await deliveryRoutines("check_suite", requested, [job]);
    expect(routs.length).toBe(0);
  });

  test("requireActiveThread: fires only when a session thread exists for the PR", async () => {
    const job = makeJob("ci", [{ checks: { conclusion: ["failure"], requireActiveThread: true } }], false);
    // workflow_run carrying PR #42 → scope pr-42 → threadId `ci:hook:pr-42`.
    const wf = wfRun("CI", "failure", { pull_requests: [{ number: 42 }] });
    expect(await firedJobsWithThreads("workflow_run", wf, [job], new Set())).not.toContain("ci");
    expect(
      await firedJobsWithThreads("workflow_run", wf, [job], new Set(["ci:hook:pr-42"])),
    ).toContain("ci");
  });
});

describe("issues webhooks", () => {
  const issue = (action: string, labels: string[] = []) => ({
    action,
    repository: { full_name: "org/repo" },
    issue: { number: 5, title: "Bug report", user: { login: "alice" }, labels: labels.map((name) => ({ name })) },
    sender: { login: "alice" },
  });

  test("opened issue fires an `issues: true` routine", async () => {
    const job = makeJob("triage", [{ issues: true }], false);
    expect(await firedJobs("issues", issue("opened"), [job])).toContain("triage");
  });

  test("closed issue is skipped with an action reason (default is opened-only)", async () => {
    const job = makeJob("triage", [{ issues: true }], false);
    expect(await firedJobs("issues", issue("closed"), [job])).not.toContain("triage");
    const reasons = await skipReasons("issues", issue("closed"), [job]);
    expect(reasons.some((r) => r.includes("action") && r.includes("closed"))).toBe(true);
  });

  test("label filter requires the label", async () => {
    const job = makeJob("triage", [{ issues: { action: ["opened"], label: ["bug"] } }], false);
    expect(await firedJobs("issues", issue("opened", ["enhancement"]), [job])).not.toContain("triage");
    expect(await firedJobs("issues", issue("opened", ["bug"]), [job])).toContain("triage");
  });
});

describe("no silent drops — every event records an outcome", () => {
  test("an unconfigured event type records a delivery-level skip reason", async () => {
    const job = makeJob("pr-review", [{ prs: true }]);
    const routines = await deliveryRoutines(
      "push",
      { ref: "refs/heads/main", repository: { full_name: "org/repo" }, sender: { login: "alice" } },
      [job],
    );
    expect(routines).toHaveLength(1);
    expect(routines[0]?.outcome).toBe("skip");
    expect(routines[0]?.reason).toBe("event type `push` has no matching rule");
  });

  test("a check event with no checks routine still records a skip reason", async () => {
    const job = makeJob("pr-review", [{ prs: true }]); // no checks rule
    const routines = await deliveryRoutines(
      "check_suite",
      {
        action: "completed",
        repository: { full_name: "org/repo" },
        check_suite: { status: "completed", conclusion: "failure", head_branch: "main" },
        sender: { login: "x" },
      },
      [job],
    );
    expect(routines.some((r) => r.reason === "event type `check_suite` has no matching rule")).toBe(
      true,
    );
  });

  test("ping is acknowledged quietly — no routine noise", async () => {
    const job = makeJob("pr-review", [{ prs: true }]);
    const routines = await deliveryRoutines("ping", { zen: "Keep it logically awesome." }, [job]);
    expect(routines).toHaveLength(0);
  });
});

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

  // A humans-only filter (`!*[bot]`) that excludes a bot is exactly the
  // bot-noise case the context diet targets: the delivery is dropped BEFORE the
  // model as a prefilter `[skip:fyi]` drop (so the chat blue-boxes the
  // suppressed bot body), not a plain user-filter skip row.
  test("bot comment under humans-only is a prefilter bot-noise drop", async () => {
    const job = makeJob("pr-comments", [{ comments: { user: ["*", "!*[bot]"] } }]);
    const outcomes = await skipOutcomes(
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
    const noise = outcomes.find((o) => o.prefilter);
    expect(noise).toBeDefined();
    expect(noise?.reason).toContain("bot noise");
  });

  // A non-bot actor excluded by an explicit glob still gets the plain
  // user-filter skip reason (no prefilter — it's a config decision, not noise).
  test("human excluded by the comment filter gets a plain user-filter skip", async () => {
    const job = makeJob("pr-comments", [{ comments: { user: ["alice"] } }], false);
    const outcomes = await skipOutcomes(
      "issue_comment",
      {
        action: "created",
        repository: { full_name: "org/repo" },
        issue: { number: 4, pull_request: { url: "x" } },
        comment: { user: { login: "bob" } },
        sender: { login: "bob" },
      },
      [job],
    );
    expect(outcomes.some((o) => !o.prefilter && o.reason.includes("not matched"))).toBe(true);
  });
});

describe("claw:ignore label pauses all hooks for a PR", () => {
  const ignoredPr = (extra: Record<string, unknown> = {}) => ({
    action: "synchronize",
    repository: { full_name: "org/repo" },
    pull_request: {
      number: 9,
      base: { ref: "feature/x" },
      head: { ref: "feature/x" },
      labels: [{ name: "needs-review" }, { name: "claw:ignore" }],
    },
    sender: { login: "alice" },
    ...extra,
  });

  test("ignored PR does not fire, and skips with the ignore reason", async () => {
    const job = makeJob("pr-review", [{ prs: true }]);
    const fired = await firedJobs("pull_request", ignoredPr(), [job]);
    expect(fired).not.toContain("pr-review");
    const reasons = await skipReasons("pull_request", ignoredPr(), [job]);
    expect(reasons.some((r) => r.startsWith("ignore"))).toBe(true);
  });

  test("ignored PR also skips comment hooks (label read from issue.labels)", async () => {
    const job = makeJob("pr-comments", [{ comments: true }]);
    const body = {
      action: "created",
      repository: { full_name: "org/repo" },
      issue: { number: 9, pull_request: { url: "x" }, labels: [{ name: "claw:ignore" }] },
      comment: { user: { login: "bob" } },
      sender: { login: "bob" },
    };
    expect(await firedJobs("issue_comment", body, [job])).not.toContain("pr-comments");
    expect(
      (await skipReasons("issue_comment", body, [job])).some((r) => r.startsWith("ignore")),
    ).toBe(true);
  });

  test("without the label the same PR fires normally", async () => {
    const job = makeJob("pr-review", [{ prs: true }]);
    const fired = await firedJobs(
      "pull_request",
      {
        action: "synchronize",
        repository: { full_name: "org/repo" },
        pull_request: { number: 9, base: { ref: "feature/x" }, labels: [{ name: "needs-review" }] },
        sender: { login: "alice" },
      },
      [job],
    );
    expect(fired).toContain("pr-review");
  });
});
