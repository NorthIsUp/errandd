import { expect, test } from "bun:test";
import { LegacyLabelMigrator, migrateLegacyLabels } from "../github/legacyLabels";

const repo = "org/repo";
function fixture(labels: { name: string; color: string; description?: string }[], pages: unknown[][] = [[]]) {
  const calls: string[][] = [];
  const read = async (args: string[]) => {
    calls.push(args);
    if (args.some(arg => arg.endsWith("/labels?per_page=100"))) return JSON.stringify(labels);
    if (args.some(arg => arg.includes("/issues?"))) return pages.map(page => JSON.stringify(page)).join("\n");
    return "{}";
  };
  return { calls, read };
}
test("a legacy-only label is renamed in place and made yellow without relabeling issues", async () => {
  const f = fixture([{ name: "claw:hold", color: "000000" }]);
  expect(await migrateLegacyLabels(repo, f.read)).toEqual({ renamed: 1, assignments: 0, recolored: 0 });
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1]).toEqual(["api", "--method", "PATCH", "repos/org/repo/labels/claw%3Ahold", "-f", "new_name=errandd:hold", "-f", "color=FBCA04"]);
});
test("duplicate labels preserve holds by adding the canonical label before removing each paginated legacy assignment", async () => {
  const f = fixture([{ name: "claw:hold", color: "FBCA04" }, { name: "errandd:hold", color: "FBCA04" }],
    [[{ number: 1, labels: [{ name: "claw:hold" }] }], [{ number: 2, labels: ["claw:hold", "errandd:hold"] }]]);
  expect((await migrateLegacyLabels(repo, f.read)).assignments).toBe(2);
  const writes = f.calls.filter(args => args.includes("POST") || args.includes("DELETE"));
  expect(writes.map(args => args[2])).toEqual(["POST", "DELETE", "DELETE"]);
  expect(writes[0]).toContain("labels[]=errandd:hold");
  expect(writes[1][3]).toBe("repos/org/repo/issues/1/labels/claw%3Ahold");
  expect(writes[2][3]).toBe("repos/org/repo/issues/2/labels/claw%3Ahold");
  expect(f.calls.filter(args => args.includes("DELETE")).every(args => args[3].includes("/issues/"))).toBe(true);
});
test("a failed canonical write must never clear the legacy human hold", async () => {
  const f = fixture([{ name: "claw:hold", color: "FBCA04" }, { name: "errandd:hold", color: "FBCA04" }], [[{ number: 1, labels: [] }]]);
  await expect(migrateLegacyLabels(repo, async args => {
    if (args.includes("POST")) throw new Error("permission denied");
    return f.read(args);
  })).rejects.toThrow("permission denied");
  expect(f.calls.some(args => args.includes("DELETE"))).toBe(false);
});
test("canonical labels are recolored, unrelated labels stay untouched, and already-yellow labels cause no writes", async () => {
  const f = fixture([{ name: "errandd:ready", color: "000000" }, { name: "bug", color: "000000" }, { name: "errandd:ignore", color: "fbca04" }]);
  expect((await migrateLegacyLabels(repo, f.read)).recolored).toBe(1);
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1][3]).toBe("repos/org/repo/labels/errandd%3Aready");
});
test("disabled migration performs no GitHub calls, including sweep and webhook requests", async () => {
  const f = fixture([]);
  const worker = new LegacyLabelMigrator(() => false, f.read);
  worker.sweep([repo]);
  await worker.enqueue(repo);
  expect(f.calls).toEqual([]);
});
test("disabling during consolidation preserves the legacy hold and prevents further writes", async () => {
  let enabled = true;
  const f = fixture([{ name: "claw:hold", color: "FBCA04" }, { name: "errandd:hold", color: "FBCA04" }], [[{ number: 1, labels: [] }]]);
  const worker = new LegacyLabelMigrator(() => enabled, async args => {
    const value = await f.read(args);
    if (args.includes("POST")) enabled = false;
    return value;
  });
  await worker.enqueue(repo);
  expect(f.calls.some(args => args.includes("POST"))).toBe(true);
  expect(f.calls.some(args => args.includes("DELETE"))).toBe(false);
});
test("duplicate events share one queued migration and errors are reported without blocking later repositories", async () => {
  const calls: string[][] = [], logs: string[] = [];
  const worker = new LegacyLabelMigrator(() => true, async args => {
    calls.push(args);
    if (args.some(arg => arg.includes("org/repo/"))) throw new Error("GitHub unavailable");
    return "[]";
  }, message => logs.push(message));
  const first = worker.enqueue(repo);
  expect(worker.enqueue(repo)).toBe(first);
  await Promise.all([first, worker.enqueue("org/other")]);
  expect(calls).toHaveLength(2);
  expect(logs[0]).toContain("will retry");
  expect(logs[0]).toContain("no LLM interaction");
});
test("malformed repository names cannot reach the GitHub CLI", async () => {
  const f = fixture([]);
  await expect(migrateLegacyLabels("../--evil", f.read)).rejects.toThrow("Invalid");
  const worker = new LegacyLabelMigrator(() => true, f.read);
  await worker.enqueue("--repo");
  expect(f.calls).toEqual([]);
});


test("bounded sweeps advance past the first batch rather than starving later repositories", async () => {
  const f = fixture([]);
  const worker = new LegacyLabelMigrator(() => true, f.read);
  const repos = Array.from({ length: 65 }, (_, i) => `org/repo-${i}`);
  worker.sweep(repos);
  await worker.enqueue(repos[63]);
  expect(f.calls).toHaveLength(64);
  worker.sweep(repos);
  await worker.enqueue(repos[64]);
  expect(f.calls.some(args => args.includes("repos/org/repo-64/labels?per_page=100"))).toBe(true);
});
