import { describe, expect, test } from "bun:test";
import { fetchReviewPreflight, pendingReviewFingerprint, recordPendingReview, reviewPreflightReason } from "../hooks/reviewPreflight";

const policy = "<!-- errandd:review-policy=ultra-trivial-v2 -->";
const body = `<!-- errandd:routine=pr-review -->\n${policy}\n<!-- errandd:review-state=complete -->`;
const review = {
  author: { login: "reviewer[bot]" }, commit: { oid: "current-sha" }, state: "COMMENTED", body, updatedAt: "2026-10-27T01:00:00Z",
};
function snapshot(overrides = {}) {
  return {
    viewer: { login: "reviewer[bot]" },
    repository: { pullRequest: { state: "OPEN", isDraft: false, headRefOid: "current-sha", reviews: { nodes: [review] }, ...overrides } },
  };
}

describe("deterministic review preflight", () => {
  test.each(["CLOSED", "MERGED"])("does not spawn a reviewer for a %s PR", (state) => {
    expect(reviewPreflightReason(snapshot({ state }), policy)).toBe(`PR is ${state.toLowerCase()}`);
  });
  test("drafts never need model interaction", () => {
    expect(reviewPreflightReason(snapshot({ isDraft: true }), policy)).toBe("PR is a draft");
  });
  test("completed current-policy review of this SHA skips duplicate analysis", () => {
    expect(reviewPreflightReason(snapshot(), policy)).toContain("already reviewed current-sha");
  });
  test.each([
    { author: { login: "other-person" } },
    { author: null },
    { commit: { oid: "old-sha" } },
    { commit: null },
    { state: "DISMISSED" },
    { state: "PENDING" },
    { body: body.replace("v2", "v1") },
    { body: body.replace("routine=pr-review", "routine=pr-comments") },
    { body: body.replace("state=complete", "state=pending") },
    { body: `${body}\n<!-- errandd:review-state=pending -->` },
    { body: "Looks good to me" },
  ])("does not trust stale, incomplete, dismissed or foreign evidence: %j", (change) => {
    expect(reviewPreflightReason(snapshot({ reviews: { nodes: [{ ...review, ...change }] } }), policy)).toBeNull();
  });
  test("a newer pending review supersedes an older complete review on the same SHA", () => {
    const newer = { ...review, body: body.replace("state=complete", "state=pending") };
    expect(reviewPreflightReason(snapshot({ reviews: { nodes: [review, newer] } }), policy)).toBeNull();
  });
  test("new heads and missing policy markers require actual review", () => {
    expect(reviewPreflightReason(snapshot({ headRefOid: "new-sha" }), policy)).toBeNull();
    expect(reviewPreflightReason(snapshot(), "ordinary routine")).toBeNull();
    expect(reviewPreflightReason(snapshot({ reviews: { nodes: [null] } }), policy)).toBeNull();
  });
  test("missing or malformed GitHub state never establishes completion", () => {
    for (const invalid of [null, {}, { viewer: null, repository: null }, snapshot({ isDraft: "false" })]) {
      expect(reviewPreflightReason(invalid, policy)).toBeNull();
    }
    expect(reviewPreflightReason({ ...snapshot(), viewer: null }, policy)).toBeNull();
  });
  test("identity aliases normalize without trusting another reviewer", () => {
    expect(reviewPreflightReason({ ...snapshot(), viewer: { login: "app/REVIEWER" } }, policy)).toContain("already reviewed");
  });
  test("GitHub API failures and partial GraphQL errors fail open to review", async () => {
    expect(await fetchReviewPreflight("owner/repo", 1, policy, async () => { throw new Error("offline"); })).toBeNull();
    expect(await fetchReviewPreflight("owner/repo", 1, policy, async () => ({ data: snapshot(), errors: [{}] }))).toBeNull();
    expect(await fetchReviewPreflight("owner/repo", 1, policy, async () => ({ data: {} }))).toBeNull();
  });
  test("repository and PR number are bound as arguments, with invalid identities rejected", async () => {
    let calls = 0;
    const read = async (args: string[]) => {
      calls += 1;
      expect(args).toContain("owner=owner");
      expect(args).toContain("name=repo");
      expect(args).toContain("number=7");
      return { data: snapshot() };
    };
    expect(await fetchReviewPreflight("owner/repo", 7, policy, read)).toContain("already reviewed");
    expect(await fetchReviewPreflight("owner/repo/extra", 7, policy, read)).toBeNull();
    expect(await fetchReviewPreflight("owner/repo", 0, policy, read)).toBeNull();
    expect(calls).toBe(1);
  });
});


function pendingSnapshot() {
  return snapshot({
    reviews: { nodes: [{ ...review, body: body.replace("state=complete", "state=pending") }] },
    statusCheckRollup: { contexts: { nodes: [{ name: "tests", status: "COMPLETED", conclusion: "FAILURE" }], pageInfo: { hasNextPage: false } } },
    reviewThreads: { nodes: [{ id: "thread", isResolved: false, isOutdated: false, comments: { nodes: [{ id: "comment", updatedAt: "2026-10-27T01:00:00Z" }], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false } },
    comments: { nodes: [], pageInfo: { hasNextPage: false } },
    reviewDecision: "REVIEW_REQUIRED",
  });
}

describe("unchanged pending reviews need no LLM", () => {
  test("an unchanged verified pending baseline skips repeated CI events", () => {
    const current = pendingSnapshot();
    const baseline = pendingReviewFingerprint(current, policy);
    expect(baseline).not.toBeNull();
    expect(reviewPreflightReason(current, policy, baseline!)).toContain("pending validation unchanged");
    expect(reviewPreflightReason(current, policy)).toBeNull();
  });

  test("head, CI, discussion, reviewer decisions and policy changes invalidate the baseline", () => {
    const current = pendingSnapshot();
    const baseline = pendingReviewFingerprint(current, policy)!;
    const pr = current.repository.pullRequest;
    const changes = [
      { headRefOid: "new-head" },
      { statusCheckRollup: { contexts: { nodes: [{ name: "tests", status: "COMPLETED", conclusion: "SUCCESS" }], pageInfo: { hasNextPage: false } } } },
      { reviewThreads: { nodes: [{ id: "thread", isResolved: true, isOutdated: false, comments: { nodes: [{ id: "comment", updatedAt: "2026-10-27T01:00:00Z" }], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false } } },
      { comments: { nodes: [{ updatedAt: "new-reply" }], pageInfo: { hasNextPage: false } } },
      { reviewDecision: "APPROVED" },
      { reviews: { nodes: [...pr.reviews.nodes, { ...review, author: { login: "human" }, body: "Please reconsider" }] } },
    ];
    for (const change of changes) {
      const changed = { ...current, repository: { pullRequest: { ...pr, ...change } } };
      expect(reviewPreflightReason(changed, policy, baseline)).toBeNull();
    }
    expect(reviewPreflightReason(current, policy.replace("v2", "v3"), baseline)).toBeNull();
  });

  test("incomplete API visibility cannot certify an unchanged blocker", () => {
    for (const change of [
      { statusCheckRollup: null },
      { reviewThreads: { nodes: [], pageInfo: { hasNextPage: true } } },
      { statusCheckRollup: { contexts: { nodes: [], pageInfo: { hasNextPage: true } } } },
      { comments: undefined },
      { comments: { nodes: [], pageInfo: { hasNextPage: true } } },
      { reviewThreads: { nodes: [{ id: "thread", isResolved: false, isOutdated: false, comments: { nodes: [], pageInfo: { hasNextPage: true } } }], pageInfo: { hasNextPage: false } } },
    ]) {
      const current = pendingSnapshot();
      const changed = { ...current, repository: { pullRequest: { ...current.repository.pullRequest, ...change } } };
      expect(pendingReviewFingerprint(changed, policy)).toBeNull();
    }
  });

  test("only a recorded baseline is reused, and failed API reads still run the reviewer", async () => {
    const read = async () => ({ data: pendingSnapshot() });
    await recordPendingReview("fixture/repo", 33, policy, 0, read);
    expect(await fetchReviewPreflight("fixture/repo", 33, policy, read)).toContain("pending validation unchanged");
    const error = async () => { throw new Error("offline"); };
    expect(await fetchReviewPreflight("fixture/repo", 33, policy, error)).toBeNull();
  });
});


test("an old pending review cannot certify changed CI after a run that posted nothing", async () => {
  const read = async () => ({ data: pendingSnapshot() });
  await recordPendingReview("fixture/repo", 34, policy, Date.parse("2026-10-27T01:00:01Z"), read);
  expect(await fetchReviewPreflight("fixture/repo", 34, policy, read)).toBeNull();
});

test("editing an older discussion comment invalidates pending evidence too", () => {
  const original = pendingSnapshot();
  const before = JSON.stringify(original);
  const changed = JSON.parse(before) as typeof original;
  const baseline = pendingReviewFingerprint(original, policy)!;
  // Keep the newest reply unchanged while an earlier comment is edited.
  const old = { id: "old-comment", updatedAt: "2026-10-26T01:00:00Z" };
  const updated = { ...old, updatedAt: "2026-10-27T02:00:00Z" };
  const extend = (value: typeof original, comment: typeof old) => ({
    ...value,
    repository: { pullRequest: { ...value.repository.pullRequest,
      comments: { nodes: [comment, { id: "newest", updatedAt: "2026-10-27T01:00:00Z" }], pageInfo: { hasNextPage: false } },
    } },
  });
  expect(baseline).not.toBeNull();
  expect(reviewPreflightReason(extend(changed, updated), policy, pendingReviewFingerprint(extend(original, old), policy)!)).toBeNull();
});

function mergeSnapshot(overrides = {}) {
  return snapshot({
    reviews: { nodes: [{ ...review, state: "APPROVED" }] },
    reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", autoMergeRequest: null,
    labels: { nodes: [{ name: "errandd:automerge" }], pageInfo: { hasNextPage: false } },
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    ...overrides,
  });
}

async function mergePass(initial = mergeSnapshot(), live = initial, checks: unknown = [{ bucket: "pass" }], outcome = mergeSnapshot({ state: "MERGED" })) {
  const calls: string[][] = [];
  let snapshots = 0;
  const reason = await fetchReviewPreflight("owner/repo", 7, policy, async (args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "checks") return checks;
    if (args[0] === "pr" && args[1] === "merge") return null;
    return { data: [initial, live, outcome][Math.min(snapshots++, 2)] };
  });
  return { calls, reason, merges: calls.filter((args) => args[1] === "merge") };
}

describe("deterministic approval-to-automerge handoff", () => {
  test.each(["errandd:automerge", "errandd:automergeable"])("a late %s label reuses approval and merges without review", async (name) => {
    const result = await mergePass(mergeSnapshot({ labels: { nodes: [{ name }], pageInfo: { hasNextPage: false } } }));
    expect(result.reason).toBe("merged approved current-sha");
    expect(result.merges).toEqual([["pr", "merge", "7", "--repo", "owner/repo", "--auto", "--squash", "--match-head-commit", "current-sha"]]);
  });
  test("verifies auto-merge enabled rather than claiming a merge", async () => {
    const result = await mergePass(mergeSnapshot(), mergeSnapshot(), [{ bucket: "pass" }], mergeSnapshot({ autoMergeRequest: { enabledAt: "now" } }));
    expect(result.reason).toBe("approved current-sha; auto-merge enabled");
  });
  test.each([
    { labels: { nodes: [], pageInfo: { hasNextPage: false } } },
    { labels: { nodes: [{ name: "errandd:automerge" }], pageInfo: { hasNextPage: true } } },
    { state: "CLOSED" }, { isDraft: true }, { headRefOid: "moved" },
    { reviews: { nodes: [{ ...review, state: "APPROVED", author: { login: "stranger" } }] } },
    { reviews: { nodes: [{ ...review, state: "APPROVED", body: body.replace("v2", "v1") }] } },
    { reviews: { nodes: [{ ...review, state: "APPROVED" }, { ...review, state: "DISMISSED" }] } },
    { reviews: { nodes: [{ ...review, state: "APPROVED" }, { ...review, state: "PENDING" }] } },
  ])("never merges without current authoritative authorization and approval: %j", async (change) => {
    expect((await mergePass(mergeSnapshot(change))).merges).toEqual([]);
  });
  test.each([
    { headRefOid: "moved" }, { state: "MERGED" }, { isDraft: true },
    { labels: { nodes: [], pageInfo: { hasNextPage: false } } },
    { labels: { nodes: [{ name: "errandd:automerge" }, { name: "claw:hold" }], pageInfo: { hasNextPage: false } } },
    { reviewDecision: "CHANGES_REQUESTED" }, { reviewDecision: "REVIEW_REQUIRED" },
    { mergeStateStatus: "DIRTY" }, { mergeStateStatus: "UNKNOWN" },
    { reviewThreads: { nodes: [{ id: "thread", isResolved: false, isOutdated: true, comments: { nodes: [], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false } } },
    { reviewThreads: { nodes: [], pageInfo: { hasNextPage: true } } },
  ])("live recheck blocks a changed or incomplete gate: %j", async (change) => {
    const result = await mergePass(mergeSnapshot(), mergeSnapshot(change));
    expect(result.merges).toEqual([]);
    expect(result.reason).toContain("auto-merge not enabled");
  });
  test.each([[], [{ bucket: "fail" }], [{ bucket: "pending" }], [{ bucket: "cancel" }], [{}], [{ bucket: "pass" }, { bucket: "pending" }]].map((checks) => ({ checks })))("required checks must pass: %j", async ({ checks }) => {
    if (checks.some((check) => !("bucket" in check))) {
      await expect(mergePass(mergeSnapshot(), mergeSnapshot(), checks)).rejects.toThrow("deterministic auto-merge will retry");
    } else {
      expect((await mergePass(mergeSnapshot(), mergeSnapshot(), checks)).merges).toEqual([]);
    }
  });
  test("already armed auto-merge does not issue another mutation", async () => {
    const result = await mergePass(mergeSnapshot({ autoMergeRequest: { enabledAt: "now" } }));
    expect(result.reason).toContain("already enabled");
    expect(result.merges).toEqual([]);
  });
  test("unverified outcome cannot claim success", async () => {
    expect((await mergePass(mergeSnapshot(), mergeSnapshot(), [{ bucket: "pass" }], mergeSnapshot())).reason).toContain("outcome is not yet verified");
  });
  test("a rejected merge never retries with weaker safeguards or invokes a reviewer", async () => {
    let reads = 0;
    const calls: string[][] = [];
    const result = fetchReviewPreflight("owner/repo", 7, policy, async (args) => {
      calls.push(args);
      if (args[1] === "merge") throw new Error("head moved");
      if (args[1] === "checks") return [{ bucket: "pass" }];
      reads++;
      return { data: mergeSnapshot() };
    });
    await expect(result).rejects.toThrow("deterministic auto-merge will retry (no LLM interaction): head moved");
    expect(reads).toBe(2);
    expect(calls.filter((args) => args[1] === "merge")).toHaveLength(1);
  });
});

test("restricted third-party check apps cannot disable deterministic merging", async () => {
  let merged = false;
  let mergeCalls = 0;
  const result = await fetchReviewPreflight("owner/repo", 7, policy, async (args) => {
    if (args[0] === "api") {
      // Production returns the PR plus FORBIDDEN when resolving Cursor's app
      // through checkSuite.app; the pod is outside that organization's IP list.
      if (args.some((arg) => arg.includes("checkSuite"))) {
        return { data: mergeSnapshot(), errors: [{ type: "FORBIDDEN", path: ["repository", "pullRequest", "statusCheckRollup", "contexts", "nodes", 0, "checkSuite", "app"] }] };
      }
      return { data: mergeSnapshot(merged ? { state: "MERGED" } : {}) };
    }
    if (args[1] === "checks") return [{ bucket: "pass" }];
    if (args[1] === "merge") { merged = true; mergeCalls++; return null; }
    throw new Error("unexpected command");
  });
  expect(result).toBe("merged approved current-sha");
  expect(mergeCalls).toBe(1);
});
