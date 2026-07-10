import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { isSafeJobPath, listJobFiles, readJobFile, writeJobFile, createJobFile, deleteJobFile } from "../ui/services/jobs";

// ─── isSafeJobPath ────────────────────────────────────────────────────────────

test("accepts simple job file names", () => {
  expect(isSafeJobPath("daily.md")).toBe(true);
  expect(isSafeJobPath("sub/weekly.md")).toBe(true);
});

test("rejects path traversal", () => {
  expect(isSafeJobPath("../secret")).toBe(false);
  expect(isSafeJobPath("a/../../b")).toBe(false);
  expect(isSafeJobPath("/etc/passwd")).toBe(false);
});

test("rejects illegal characters", () => {
  expect(isSafeJobPath("a b.md")).toBe(false);
  expect(isSafeJobPath("a$.md")).toBe(false);
  expect(isSafeJobPath("")).toBe(false);
});

test("rejects trailing slash (directory path)", () => {
  expect(isSafeJobPath("sub/")).toBe(false);
});

test("enforces the 200-character length cap", () => {
  expect(isSafeJobPath("a".repeat(200))).toBe(true);
  expect(isSafeJobPath("a".repeat(201))).toBe(false);
});

// ─── Real-fs fixtures ─────────────────────────────────────────────────────────

let tmpDir: string;
let outsideDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "jobs-test-"));
  outsideDir = await mkdtemp(join(tmpdir(), "jobs-outside-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

// ─── listJobFiles ─────────────────────────────────────────────────────────────

test("listJobFiles returns empty array for an empty jobs dir", async () => {
  const files = await listJobFiles(tmpDir);
  expect(files).toEqual([]);
});

test("listJobFiles lists a single file with correct fields", async () => {
  await writeFile(join(tmpDir, "job.md"), "---\nschedule: \"0 9 * * *\"\nrecurring: true\n---\nhello\n", "utf-8");
  const files = await listJobFiles(tmpDir);
  expect(files).toHaveLength(1);
  const f = files[0];
  expect(f.path).toBe("job.md");
  expect(f.name).toBe("job.md");
  expect(typeof f.size).toBe("number");
  expect(f.size).toBeGreaterThan(0);
  expect(typeof f.mtime).toBe("string");
  expect(f.isJob).toBe(true);
});

test("listJobFiles marks isJob only for .md frontmatter with a schedule: field", async () => {
  // valid job: frontmatter has schedule:
  await writeFile(join(tmpDir, "valid-job.md"), "---\nschedule: \"0 9 * * *\"\n---\nsome prompt\n", "utf-8");
  // plain .md: no frontmatter
  await writeFile(join(tmpDir, "readme.md"), "# Just a readme\n", "utf-8");
  // SKILL-style .md: has frontmatter (name/description) but NO schedule — not a job
  await writeFile(join(tmpDir, "SKILL.md"), "---\nname: system-check\ndescription: a skill\n---\n# Skill\n", "utf-8");
  // non-.md file: never a job
  await writeFile(join(tmpDir, "data.txt"), "data\n", "utf-8");

  const files = await listJobFiles(tmpDir);
  const byName = Object.fromEntries(files.map((f) => [f.name, f]));

  expect(byName["valid-job.md"].isJob).toBe(true);
  expect(byName["readme.md"].isJob).toBe(false);
  expect(byName["SKILL.md"].isJob).toBe(false);
  expect(byName["data.txt"].isJob).toBe(false);
});

test("listJobFiles recurses into subdirectories", async () => {
  await mkdir(join(tmpDir, "sub"), { recursive: true });
  await writeFile(join(tmpDir, "top.md"), "---\nschedule: \"0 9 * * *\"\n---\ntop\n", "utf-8");
  await writeFile(join(tmpDir, "sub", "nested.md"), "---\nschedule: \"0 9 * * *\"\n---\nnested\n", "utf-8");

  const files = await listJobFiles(tmpDir);
  const paths = files.map((f) => f.path);
  expect(paths).toContain("top.md");
  expect(paths).toContain("sub/nested.md");
  expect(files).toHaveLength(2);
});

test("listJobFiles skips dotfiles", async () => {
  await writeFile(join(tmpDir, ".hidden"), "secret\n", "utf-8");
  await writeFile(join(tmpDir, ".hidden.md"), "---\nschedule: \"0 9 * * *\"\n---\nhidden\n", "utf-8");
  await writeFile(join(tmpDir, "visible.md"), "---\nschedule: \"0 9 * * *\"\n---\nvisible\n", "utf-8");

  const files = await listJobFiles(tmpDir);
  expect(files).toHaveLength(1);
  expect(files[0].name).toBe("visible.md");
});

test("listJobFiles returns files sorted by path", async () => {
  await mkdir(join(tmpDir, "aaa"), { recursive: true });
  await mkdir(join(tmpDir, "zzz"), { recursive: true });
  await writeFile(join(tmpDir, "zzz", "z.md"), "content\n", "utf-8");
  await writeFile(join(tmpDir, "aaa", "a.md"), "content\n", "utf-8");
  await writeFile(join(tmpDir, "mid.md"), "content\n", "utf-8");

  const files = await listJobFiles(tmpDir);
  const paths = files.map((f) => f.path);
  expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
});

test("listJobFiles returns empty array when jobs dir does not exist", async () => {
  const nonExistent = join(tmpDir, "no-such-dir");
  const files = await listJobFiles(nonExistent);
  expect(files).toEqual([]);
});

// ─── readJobFile ──────────────────────────────────────────────────────────────

test("readJobFile returns file content", async () => {
  const content = "---\nschedule: \"0 9 * * *\"\n---\nhello world\n";
  await writeFile(join(tmpDir, "job.md"), content, "utf-8");
  expect(await readJobFile("job.md", tmpDir)).toBe(content);
});

test("readJobFile rejects path traversal", async () => {
  await expect(readJobFile("../escape.md", tmpDir)).rejects.toThrow("Invalid job path.");
});

test("readJobFile rejects absolute path", async () => {
  await expect(readJobFile("/etc/passwd", tmpDir)).rejects.toThrow("Invalid job path.");
});

test("readJobFile rejects path with illegal characters", async () => {
  await expect(readJobFile("a b.md", tmpDir)).rejects.toThrow("Invalid job path.");
});

test("readJobFile throws for non-existent file (ENOENT)", async () => {
  await expect(readJobFile("missing.md", tmpDir)).rejects.toThrow();
});

test("readJobFile rejects a symlink inside jobs dir that points outside", async () => {
  // Create a real file outside the jobs dir
  await writeFile(join(outsideDir, "secret.md"), "secret content\n", "utf-8");
  // Create a symlink inside the jobs dir pointing to the outside file
  await symlink(join(outsideDir, "secret.md"), join(tmpDir, "escape.md"));

  await expect(readJobFile("escape.md", tmpDir)).rejects.toThrow("Invalid job path.");
});

// ─── writeJobFile ─────────────────────────────────────────────────────────────

test("writeJobFile creates file with given content", async () => {
  const content = "---\nschedule: \"0 9 * * *\"\n---\nmy job\n";
  await writeJobFile("new.md", content, tmpDir);
  expect(await readFile(join(tmpDir, "new.md"), "utf-8")).toBe(content);
});

test("writeJobFile overwrites existing file", async () => {
  await writeFile(join(tmpDir, "existing.md"), "old content\n", "utf-8");
  await writeJobFile("existing.md", "new content\n", tmpDir);
  expect(await readFile(join(tmpDir, "existing.md"), "utf-8")).toBe("new content\n");
});

test("writeJobFile creates parent directories", async () => {
  await writeJobFile("sub/dir/job.md", "content\n", tmpDir);
  expect(await readFile(join(tmpDir, "sub/dir/job.md"), "utf-8")).toBe("content\n");
});

test("writeJobFile enforces 100KB size cap", async () => {
  const tooBig = "x".repeat(100_001);
  await expect(writeJobFile("big.md", tooBig, tmpDir)).rejects.toThrow("File too large.");
});

test("writeJobFile allows content at exactly the 100KB limit", async () => {
  const exactly100k = "x".repeat(100_000);
  await writeJobFile("big.md", exactly100k, tmpDir);
  const written = await readFile(join(tmpDir, "big.md"), "utf-8");
  expect(written.length).toBe(100_000);
});

test("writeJobFile rejects path traversal", async () => {
  await expect(writeJobFile("../outside.md", "content\n", tmpDir)).rejects.toThrow("Invalid job path.");
});

test("writeJobFile rejects a symlink escape (symlink inside dir pointing outside)", async () => {
  // Create symlink inside jobs dir pointing to an outside directory
  await symlink(outsideDir, join(tmpDir, "linked-dir"));
  // Try to write through the symlink to a path outside
  await expect(writeJobFile("linked-dir/evil.md", "pwned\n", tmpDir)).rejects.toThrow("Invalid job path.");
});

test("writeJobFile rejects a file-symlink escape (symlink file pointing outside)", async () => {
  // Create a real file outside the jobs dir
  await writeFile(join(outsideDir, "secret.md"), "secret content\n", "utf-8");
  // Symlink it into the jobs dir as a file
  await symlink(join(outsideDir, "secret.md"), join(tmpDir, "escape.md"));
  // Writing through the symlink would otherwise overwrite the outside file
  await expect(writeJobFile("escape.md", "pwned\n", tmpDir)).rejects.toThrow("Invalid job path.");
  // And the outside file must be untouched
  expect(await readFile(join(outsideDir, "secret.md"), "utf-8")).toBe("secret content\n");
});

// ─── createJobFile ────────────────────────────────────────────────────────────

test("createJobFile creates a new file with frontmatter seed", async () => {
  await createJobFile("newjob.md", tmpDir);
  const content = await readFile(join(tmpDir, "newjob.md"), "utf-8");
  expect(content).toContain("---");
  expect(content).toContain("schedule:");
  expect(content).toContain("recurring:");
});

test("createJobFile fails if file already exists", async () => {
  await writeFile(join(tmpDir, "existing.md"), "already here\n", "utf-8");
  await expect(createJobFile("existing.md", tmpDir)).rejects.toThrow("File already exists.");
});

test("createJobFile creates parent directories", async () => {
  await createJobFile("deep/nested/job.md", tmpDir);
  const content = await readFile(join(tmpDir, "deep/nested/job.md"), "utf-8");
  expect(content).toContain("---");
});

test("createJobFile rejects path traversal", async () => {
  await expect(createJobFile("../escape.md", tmpDir)).rejects.toThrow("Invalid job path.");
});

test("createJobFile rejects a symlink escape (symlinked dir pointing outside)", async () => {
  // Symlink a directory inside the jobs dir to an outside directory
  await symlink(outsideDir, join(tmpDir, "linked-dir"));
  // Creating a new file through the symlink would land outside the jobs dir
  await expect(createJobFile("linked-dir/new.md", tmpDir)).rejects.toThrow("Invalid job path.");
});

// ─── deleteJobFile ────────────────────────────────────────────────────────────

test("deleteJobFile removes the file from disk", async () => {
  await writeFile(join(tmpDir, "todelete.md"), "bye\n", "utf-8");
  await deleteJobFile("todelete.md", tmpDir);
  // File should no longer exist — reading it should throw
  await expect(readFile(join(tmpDir, "todelete.md"), "utf-8")).rejects.toThrow();
});

test("deleteJobFile throws for non-existent file", async () => {
  await expect(deleteJobFile("ghost.md", tmpDir)).rejects.toThrow();
});

test("deleteJobFile rejects path traversal", async () => {
  await expect(deleteJobFile("../../etc/passwd", tmpDir)).rejects.toThrow("Invalid job path.");
});

test("deleteJobFile rejects a symlink escape (file symlink pointing outside)", async () => {
  // Create a real file outside the jobs dir and symlink it in
  await writeFile(join(outsideDir, "secret.md"), "secret content\n", "utf-8");
  await symlink(join(outsideDir, "secret.md"), join(tmpDir, "escape.md"));
  // Deleting through the symlink would otherwise unlink the outside file
  await expect(deleteJobFile("escape.md", tmpDir)).rejects.toThrow("Invalid job path.");
  // And the outside file must still exist
  expect(await readFile(join(outsideDir, "secret.md"), "utf-8")).toBe("secret content\n");
});

// ─── resolveSafe: symlink escape via directory symlink ────────────────────────

test("readJobFile rejects a directory symlink inside jobs dir pointing outside", async () => {
  // Link the entire outsideDir into the jobs dir
  await symlink(outsideDir, join(tmpDir, "linked"));
  // Create a file in the outside dir
  await writeFile(join(outsideDir, "target.md"), "outside content\n", "utf-8");

  // Accessing via the symlinked directory should be rejected by realpath check
  await expect(readJobFile("linked/target.md", tmpDir)).rejects.toThrow("Invalid job path.");
});
