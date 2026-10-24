import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearJobSchedule, snapshotJobFrontmatter } from "../jobs";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function sourceDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jobs-origin-"));
  dirs.push(dir);
  return dir;
}

test("one-shot completion edits the originating repo and preserves event triggers", async () => {
  const first = await sourceDir();
  const second = await sourceDir();
  const content = '---\non:\n  - schedule: "0 9 * * *"\n  - pr: true\n---\nrun me\n';
  await Promise.all([first, second].map((dir) => writeFile(join(dir, "job.md"), content)));
  await clearJobSchedule("job", second);
  expect(await readFile(join(first, "job.md"), "utf-8")).toBe(content);
  const updated = await readFile(join(second, "job.md"), "utf-8");
  expect(updated).not.toContain("schedule:");
  expect(updated).toContain("pr: true");
  expect(updated).toContain("run me");
});

test("frontmatter restore targets the source directory for agent-scoped names", async () => {
  const dir = await sourceDir();
  const path = join(dir, "daily.md");
  const content = '---\non:\n  - schedule: "0 9 * * *"\n---\noriginal\n';
  await writeFile(path, content);
  const restore = await snapshotJobFrontmatter("agent/daily", dir);
  await writeFile(path, "---\nchanged: true\n---\nupdated prompt\n");
  expect(await restore()).toBe(true);
  const restored = await readFile(path, "utf-8");
  expect(restored).toContain('schedule: "0 9 * * *"');
  expect(restored).toContain("updated prompt");
  expect(restored).not.toContain("changed:");
});
