import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFrontmatter, writeFrontmatter } from "../../web/ui/schedule";
import { recentDeliveries } from "../hooks/deliveries";
import { evalChecksRule, readChecksPayload } from "../hooks/match";
import { handleWebhook } from "../hooks/receiver";
import { parseTriggers } from "../hooks/schema";
import type { Job } from "../jobs";

const workflow = "https://github.com/teamclara/Clara_V1/actions/workflows/ci-deploy.yml";
const previousSecret = process.env.ERRANDD_GITHUB_WEBHOOK_SECRET;
beforeAll(() => { delete process.env.ERRANDD_GITHUB_WEBHOOK_SECRET; });
afterAll(() => {
  if (previousSecret === undefined) delete process.env.ERRANDD_GITHUB_WEBHOOK_SECRET;
  else process.env.ERRANDD_GITHUB_WEBHOOK_SECRET = previousSecret;
});

function job(rule: Record<string, unknown>): Job {
  const { hookConfig, schedules } = parseTriggers([{ checks: rule }], false);
  return { name: "deployments", prompt: "Inspect deployment", recurring: false,
    notify: true, reuseSession: false, schedules, ...(hookConfig ? { hookConfig } : {}) };
}
function payload(status = "completed", conclusion: string | null = "success", repo = "teamclara/Clara_V1", path = ".github/workflows/ci-deploy.yml") {
  return { action: status === "queued" ? "requested" : status,
    repository: { full_name: repo }, sender: { login: "github-actions[bot]" },
    workflow_run: { id: 123, name: "🚀 CI-Deploy", path, status, conclusion, head_branch: "main", head_sha: "abc123" } };
}
let sequence = 0;
async function receive(body: unknown, jobs: Job[], event = "workflow_run", id = `actions-monitor-${++sequence}`) {
  const fired: string[] = [];
  const response = await handleWebhook(new Request("http://local/api/webhooks/github", {
    method: "POST", headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": id }, body: JSON.stringify(body),
  }), { getJobs: async () => jobs, onHookFire: name => { fired.push(name); } });
  return { fired, response, id };
}

test("workflow URL binds repository and file, without depending on display name", async () => {
  const jobs = [job({ workflow, conclusion: ["success"] })];
  expect((await receive(payload(), jobs)).fired).toEqual(["deployments"]);
  expect((await receive(payload("completed", "success", "other/repo"), jobs)).fired).toEqual([]);
  expect((await receive(payload("completed", "success", undefined, ".github/workflows/tests.yml"), jobs)).fired).toEqual([]);
  expect((await receive(payload("completed", "failure"), jobs)).fired).toEqual([]);
  expect((await receive({ ...payload(), check_run: payload().workflow_run }, jobs, "check_run")).fired).toEqual([]);
});

test("workflow path and repository globs include and exclude strictly", async () => {
  const jobs = [job({ workflow: ["*.yml", "!tests.yml"], repo: ["teamclara/*", "!teamclara/archived"], conclusion: [] })];
  expect((await receive(payload(), jobs)).fired).toEqual(["deployments"]);
  expect((await receive(payload("completed", "success", "teamclara/archived"), jobs)).fired).toEqual([]);
  expect((await receive(payload("completed", "success", ""), jobs)).fired).toEqual([]);
  expect((await receive(payload("completed", "success", undefined, ".github/workflows/tests.yml"), jobs)).fired).toEqual([]);
  expect((await receive(payload(), [job({ workflow: ".github/workflows/ci-deploy.yml", conclusion: [] })])).fired).toEqual(["deployments"]);
});

test("explicit statuses opt into lifecycle events; default failure rules remain quiet", async () => {
  const monitor = job({ workflow, status: ["queued", "in_progress", "completed"] });
  const legacy = { ...job({}), name: "legacy" };
  for (const status of ["queued", "in_progress", "completed"]) {
    expect((await receive(payload(status, status === "completed" ? "success" : null), [monitor, legacy])).fired).toEqual(["deployments"]);
  }
  expect((await receive(payload("completed", "failure"), [legacy])).fired).toEqual(["legacy"]);
  const ignored = await receive(payload("in_progress", null), [legacy]);
  expect(recentDeliveries().some(d => d.id === ignored.id)).toBe(false);
  const unrelated = await receive(payload("in_progress", null, "other/repo"), [monitor]);
  expect(recentDeliveries().some(d => d.id === unrelated.id)).toBe(false);
});

test("status and conclusion filters intersect and missing workflow identity fails closed", async () => {
  const jobs = [job({ workflow, status: ["*"], conclusion: ["success"] })];
  expect((await receive(payload("in_progress", null), jobs)).fired).toEqual([]);
  expect((await receive(payload(), jobs)).fired).toEqual(["deployments"]);
  const p = payload();
  const body = { ...p, workflow_run: { ...p.workflow_run, path: undefined } };
  expect((await receive(body, jobs)).fired).toEqual([]);
  expect((await receive({ ...body, workflow: { path: ".github/workflows/ci-deploy.yml" } }, jobs)).fired).toEqual(["deployments"]);
});

test("repeat delivery fires once and a rerequest is not mistaken for completion", async () => {
  const jobs = [job({ workflow, status: ["completed"] })];
  const first = await receive(payload(), jobs);
  expect(first.fired).toEqual(["deployments"]);
  expect((await receive(payload(), jobs, "workflow_run", first.id)).response.body.duplicate).toBe(true);
  expect((await receive({ ...payload(), action: "rerequested" }, jobs)).fired).toEqual([]);
});

test("workflow path extraction and skip reasons expose the failed filter", () => {
  const check = readChecksPayload("workflow_run", payload());
  if (!check) throw Error("missing check payload");
  const rule = job({ repo: "other/*" }).hookConfig?.checks;
  if (!rule || rule === true) throw Error("missing rule");
  expect(check.workflow).toBe(".github/workflows/ci-deploy.yml");
  expect(evalChecksRule(rule, check).reason).toContain("repository");
});

test("editor saves preserve workflow, status, repository and existing check guards", () => {
  const content = `---\non:\n  - checks:\n      workflow: ${workflow}\n      repo: teamclara/*\n      status: [in_progress, completed]\n      only: ['🚀 CI-Deploy']\n      ignore: [tests]\n      requireActiveThread: true\n---\nInspect the deployment.\n`;
  const initial = readFrontmatter(content);
  const saved = writeFrontmatter(content, { hookConfig: initial.hookConfig });
  expect(readFrontmatter(saved).hookConfig).toEqual(initial.hookConfig);
  const server = parseTriggers([{ checks: { workflow, status: ["in_progress", "completed"] } }], undefined).hookConfig?.checks;
  expect(server && server !== true && server.conclusion).toEqual([]);
  expect(saved).toContain("Inspect the deployment.");
});
