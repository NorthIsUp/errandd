import { describe, expect, test } from "bun:test";
import { evalReviewRule, matchReviewRule, readReviewPayload } from "../hooks/match";
import { handleWebhook } from "../hooks/receiver";
import { DEFAULT_PR_SCOPE, parseTriggers } from "../hooks/schema";
import type { Job } from "../jobs";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("parseTriggers — reviews", () => {
  test("bare `reviews: true` → any state, any author", () => {
    const { hookConfig } = parseTriggers([{ reviews: true }], undefined);
    expect(hookConfig?.reviews).toEqual({ states: [], user: ["*"] });
  });

  test("filtered reviews narrows by state; user defaults to any", () => {
    const { hookConfig } = parseTriggers([{ reviews: { states: ["approved"] } }], undefined);
    expect(hookConfig?.reviews).toEqual({ states: ["approved"], user: ["*"] });
  });

  test("explicit reviewer filter is preserved", () => {
    const { hookConfig } = parseTriggers(
      [{ reviews: { states: ["approved", "changes_requested"], user: ["*", "!*[bot]"] } }],
      undefined,
    );
    expect(hookConfig?.reviews).toEqual({
      states: ["approved", "changes_requested"],
      user: ["*", "!*[bot]"],
    });
  });

  test("unset/false → reviews absent from hookConfig", () => {
    const { hookConfig } = parseTriggers([{ comments: true }], undefined);
    expect(hookConfig?.reviews).toBeUndefined();
  });

  test("a bad reviews value throws (so the typo surfaces, not silently drops)", () => {
    expect(() => parseTriggers([{ reviews: ["approved"] }], undefined)).toThrow(/must be a boolean or a mapping/);
  });
});

// ---------------------------------------------------------------------------
// Payload extraction + rule eval
// ---------------------------------------------------------------------------

function reviewBody(state: string, reviewer = "alice", num = 42, repo = "o/r"): unknown {
  return {
    action: "submitted",
    review: { state, user: { login: reviewer } },
    pull_request: { number: num },
    repository: { full_name: repo },
    sender: { login: reviewer },
  };
}

describe("readReviewPayload + evalReviewRule", () => {
  test("normalizes state to lowercase and pulls repo/number/user", () => {
    expect(readReviewPayload(reviewBody("APPROVED", "bob", 7, "x/y"))).toEqual({
      state: "approved",
      repo: "x/y",
      number: "7",
      user: "bob",
    });
  });

  test("state filter", () => {
    const rule = { states: ["approved"], user: ["*"] };
    const p = readReviewPayload(reviewBody("approved"));
    if (!p) throw new Error("payload");
    expect(matchReviewRule(rule, p)).toBe(true);
    const commented = readReviewPayload(reviewBody("commented"));
    if (!commented) throw new Error("payload");
    expect(matchReviewRule(rule, commented)).toBe(false);
    expect(evalReviewRule(rule, commented).reason).toContain("commented");
  });

  test("empty states matches any state", () => {
    const rule = { states: [], user: ["*"] };
    for (const s of ["approved", "changes_requested", "commented", "dismissed"]) {
      const p = readReviewPayload(reviewBody(s));
      if (!p) throw new Error("payload");
      expect(matchReviewRule(rule, p)).toBe(true);
    }
  });

  test("reviewer filter", () => {
    const rule = { states: [], user: ["*", "!*[bot]"] };
    const human = readReviewPayload(reviewBody("approved", "alice"));
    const bot = readReviewPayload(reviewBody("approved", "greptile[bot]"));
    if (!human || !bot) throw new Error("payload");
    expect(matchReviewRule(rule, human)).toBe(true);
    expect(matchReviewRule(rule, bot)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Receiver precedence: reviews vs comments on pull_request_review
// ---------------------------------------------------------------------------

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

let seq = 0;
async function firedJobs(event: string, body: unknown, jobs: Job[]): Promise<string[]> {
  seq += 1;
  const fired: string[] = [];
  const req = new Request("http://local/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": `rev-${seq}`,
    },
    body: JSON.stringify(body),
  });
  await handleWebhook(req, {
    getJobs: () => jobs,
    onHookFire: (name: string) => {
      fired.push(name);
    },
  });
  return fired;
}

describe("receiver — reviews trigger dispatch", () => {
  test("reviews:{states:[approved]} fires on approval, skips a plain comment review", async () => {
    const job = makeJob("pr-accepted", [{ reviews: { states: ["approved"] } }]);
    expect(await firedJobs("pull_request_review", reviewBody("approved"), [job])).toEqual(["pr-accepted"]);
    expect(await firedJobs("pull_request_review", reviewBody("commented"), [job])).toEqual([]);
    expect(await firedJobs("pull_request_review", reviewBody("changes_requested"), [job])).toEqual([]);
  });

  test("a comments:true job STILL gets review events (backward compat)", async () => {
    const job = makeJob("legacy", [{ comments: true }]);
    expect(await firedJobs("pull_request_review", reviewBody("commented"), [job])).toEqual(["legacy"]);
  });

  test("reviews config does not steal issue_comment events (those go to comments)", async () => {
    // job has BOTH: reviews for approvals, comments for everything else
    const job = makeJob("both", [{ reviews: { states: ["approved"] } }, { comments: true }]);
    const issueComment = {
      action: "created",
      comment: { body: "hi", user: { login: "alice" } },
      issue: { number: 42 },
      repository: { full_name: "o/r" },
      sender: { login: "alice" },
    };
    // issue_comment → comments path → fires
    expect(await firedJobs("issue_comment", issueComment, [job])).toEqual(["both"]);
    // a `commented` review → reviews path (precedence) → does NOT fire (only approved)
    expect(await firedJobs("pull_request_review", reviewBody("commented"), [job])).toEqual([]);
    // an `approved` review → reviews path → fires
    expect(await firedJobs("pull_request_review", reviewBody("approved"), [job])).toEqual(["both"]);
  });
});

// ---------------------------------------------------------------------------
// Configurable PR-scope defaults (feature A)
// ---------------------------------------------------------------------------

describe("parseTriggers — configurable pr defaults", () => {
  test("a label-only pr rule inherits the built-in any/any default", () => {
    const { hookConfig } = parseTriggers([{ pr: { labels: ["claw:babysit"] } }], undefined);
    expect(hookConfig?.pr[0]?.repo).toEqual(DEFAULT_PR_SCOPE.repo);
    expect(hookConfig?.pr[0]?.user).toEqual(DEFAULT_PR_SCOPE.user);
  });

  test("prDefaults override the omitted repo/user", () => {
    const prDefaults = { repo: ["teamclara/*"], user: ["*", "!*[bot]"] };
    const { hookConfig } = parseTriggers([{ pr: { labels: ["claw:babysit"] } }], undefined, prDefaults);
    expect(hookConfig?.pr[0]?.repo).toEqual(["teamclara/*"]);
    expect(hookConfig?.pr[0]?.user).toEqual(["*", "!*[bot]"]);
  });

  test("an explicit repo/user still wins over the defaults", () => {
    const prDefaults = { repo: ["teamclara/*"], user: ["*", "!*[bot]"] };
    const { hookConfig } = parseTriggers(
      [{ pr: { repo: "only/this", user: ["specific"], labels: ["x"] } }],
      undefined,
      prDefaults,
    );
    expect(hookConfig?.pr[0]?.repo).toEqual("only/this");
    expect(hookConfig?.pr[0]?.user).toEqual(["specific"]);
  });
});
