import { z } from "zod";
import { getReadCache } from "../readCache";

const reviewSchema = z.object({
  author: z.object({ login: z.string() }).nullable(),
  commit: z.object({ oid: z.string() }).nullable(),
  state: z.string(),
  body: z.string(),
  updatedAt: z.string().optional(),
});
const connectionSchema = z.object({
  nodes: z.array(z.unknown()), pageInfo: z.object({ hasNextPage: z.boolean() }),
});
const threadConnectionSchema = z.object({
  nodes: z.array(z.object({
    id: z.string(), isResolved: z.boolean(), isOutdated: z.boolean(), comments: connectionSchema,
  }).nullable()),
  pageInfo: z.object({ hasNextPage: z.boolean() }),
});
const snapshotSchema = z.object({
  viewer: z.object({ login: z.string() }).nullable(),
  repository: z.object({
    pullRequest: z.object({
      state: z.string(),
      isDraft: z.boolean(),
      headRefOid: z.string().min(1),
      reviews: z.object({ nodes: z.array(reviewSchema.nullable()) }),
      statusCheckRollup: z.object({ contexts: connectionSchema }).nullable().optional(),
      reviewThreads: threadConnectionSchema.optional(),
      comments: connectionSchema.optional(),
      reviewDecision: z.string().nullable().optional(),
    }).nullable(),
  }).nullable(),
});

const policyPattern = /<!-- errandd:review-policy=([\w.-]+) -->/;
const normalizeLogin = (login: string): string => login.toLowerCase().replace(/^app\//, "").replace(/\[bot\]$/, "");

function latestPolicyReview(
  reviews: (z.infer<typeof reviewSchema> | null)[], head: string, viewer: string, version: string,
): z.infer<typeof reviewSchema> | undefined {
  return reviews.filter((review) =>
    review?.author && normalizeLogin(review.author.login) === normalizeLogin(viewer) &&
    review.commit?.oid === head && ["APPROVED", "COMMENTED", "CHANGES_REQUESTED"].includes(review.state) &&
    review.body.includes("<!-- errandd:routine=pr-review -->") &&
    review.body.includes(`<!-- errandd:review-policy=${version} -->`)).at(-1) ?? undefined;
}

/** Only authoritative GitHub state and this routine's own, SHA-bound completed review can skip analysis. */
export function reviewPreflightReason(snapshot: unknown, prompt: string, previousPending?: string): string | null {
  const parsed = snapshotSchema.safeParse(snapshot);
  if (!parsed.success) return null;
  const { viewer, repository } = parsed.data;
  const pr = repository?.pullRequest;
  if (!pr) return null;
  if (pr.state !== "OPEN") return `PR is ${pr.state.toLowerCase()}`;
  if (pr.isDraft) return "PR is a draft";
  const version = policyPattern.exec(prompt)?.[1];
  if (!version || !viewer) return null;
  const latest = latestPolicyReview(pr.reviews.nodes, pr.headRefOid, viewer.login, version);
  if (latest?.body.includes("<!-- errandd:review-state=complete -->") &&
      !latest.body.includes("<!-- errandd:review-state=pending -->")) {
    return `already reviewed ${pr.headRefOid} under ${version}`;
  }
  const fingerprint = pendingReviewFingerprint(snapshot, prompt);
  return fingerprint && fingerprint === previousPending ? `pending validation unchanged for ${pr.headRefOid}` : null;
}

/** Persist only verified pending reviews with complete check/thread visibility. */
export function pendingReviewFingerprint(snapshot: unknown, prompt: string): string | null {
  const parsed = snapshotSchema.safeParse(snapshot);
  const version = policyPattern.exec(prompt)?.[1];
  if (!parsed.success || !version) return null;
  const { viewer, repository } = parsed.data;
  const pr = repository?.pullRequest;
  const checks = pr?.statusCheckRollup?.contexts;
  if (!viewer || pr?.state !== "OPEN" || pr.isDraft || !checks || checks.pageInfo.hasNextPage ||
      pr.reviewThreads?.pageInfo.hasNextPage !== false || !pr.comments || pr.comments.pageInfo.hasNextPage ||
      pr.reviewThreads.nodes.some((thread) => !thread || thread.comments.pageInfo.hasNextPage)) return null;
  const latest = latestPolicyReview(pr.reviews.nodes, pr.headRefOid, viewer.login, version);
  if (latest?.state !== "COMMENTED" || !latest.body.includes("<!-- errandd:review-state=pending -->") ||
      latest.body.includes("<!-- errandd:review-state=complete -->")) return null;
  return JSON.stringify({
    version, viewer: viewer.login, head: pr.headRefOid, decision: pr.reviewDecision,
    checks: checks.nodes.map((node) => JSON.stringify(node)).sort(),
    threads: pr.reviewThreads.nodes.map((node) => JSON.stringify(node)).sort(),
    comments: pr.comments.nodes, reviews: pr.reviews.nodes,
  });
}

const query = `query($owner:String!,$name:String!,$number:Int!){
  viewer{login}
  repository(owner:$owner,name:$name){pullRequest(number:$number){
    state isDraft headRefOid reviewDecision
    statusCheckRollup{contexts(first:100){nodes{
      ... on CheckRun{name status conclusion checkSuite{app{slug}}}
      ... on StatusContext{context state}
    } pageInfo{hasNextPage}}}
    reviewThreads(first:100){nodes{id isResolved isOutdated comments(first:100){nodes{id updatedAt} pageInfo{hasNextPage}}} pageInfo{hasNextPage}}
    comments(first:100){nodes{id updatedAt} pageInfo{hasNextPage}}
    reviews(last:100){nodes{author{login} commit{oid} state body updatedAt}}
  }}
}`;

const cacheNamespace = "pending-review-preflight";

export async function fetchReviewPreflight(
  repo: string,
  number: number,
  prompt: string,
  read: (args: string[]) => Promise<unknown> = readGithub,
): Promise<string | null> {
  try {
    const snapshot = await readReviewSnapshot(repo, number, read);
    const previous = getReadCache().get<string>(cacheNamespace, `${repo}#${number}`)?.value;
    return reviewPreflightReason(snapshot, prompt, previous);
  } catch {
    return null;
  }
}

export async function recordPendingReview(
  repo: string,
  number: number,
  prompt: string,
  startedAt: number,
  read: (args: string[]) => Promise<unknown> = readGithub,
): Promise<void> {
  try {
    const snapshot = await readReviewSnapshot(repo, number, read);
    const parsed = snapshotSchema.safeParse(snapshot);
    const version = policyPattern.exec(prompt)?.[1];
    const pr = parsed.success ? parsed.data.repository?.pullRequest : null;
    const viewer = parsed.success ? parsed.data.viewer : null;
    const latest = pr && viewer && version ? latestPolicyReview(pr.reviews.nodes, pr.headRefOid, viewer.login, version) : undefined;
    const updatedAt = Date.parse(latest?.updatedAt ?? "");
    const fingerprint = updatedAt >= startedAt ? pendingReviewFingerprint(snapshot, prompt) : null;
    if (fingerprint) getReadCache().set(cacheNamespace, `${repo}#${number}`, fingerprint);
    else getReadCache().delete(cacheNamespace, `${repo}#${number}`);
  } catch {
    // Missing evidence cannot make a successful review fail or certify a new baseline.
  }
}

async function readReviewSnapshot(
  repo: string,
  number: number,
  read: (args: string[]) => Promise<unknown>,
): Promise<unknown> {
  const [owner, name, extra] = repo.split("/");
  if (!owner || !name || extra || !Number.isSafeInteger(number) || number < 1) return null;
  const response = await read([
    "api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`,
  ]);
  const envelope = z.object({ data: z.unknown(), errors: z.array(z.unknown()).optional() }).safeParse(response);
  if (!envelope.success || envelope.data.errors?.length) return null;
  return envelope.data.data;
}

async function readGithub(args: string[]): Promise<unknown> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 10_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    return JSON.parse(stdout) as unknown;
  } finally {
    clearTimeout(timer);
  }
}
