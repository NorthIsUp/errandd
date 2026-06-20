import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { scanSkillsDir, scanCommandsDir } from "../slashRegistry";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "slash-reg-"));
}

async function mkSkill(
  baseDir: string,
  name: string,
  content = `# ${name}\nDoes things.`,
): Promise<void> {
  const dir = join(baseDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content);
}

async function mkCommand(
  baseDir: string,
  name: string,
  content = `# ${name}\nRuns a command.`,
): Promise<void> {
  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, `${name}.md`), content);
}

// ── scanSkillsDir ─────────────────────────────────────────────────────────────

let tmpDirs: string[] = [];

beforeEach(() => { tmpDirs = []; });
afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  tmpDirs = [];
});

async function mktmp(): Promise<string> {
  const d = await tmp();
  tmpDirs.push(d);
  return d;
}

test("scanSkillsDir: returns empty array when dir does not exist", async () => {
  const entries = await scanSkillsDir("/nonexistent/path/skills", "personal");
  expect(entries).toEqual([]);
});

test("scanSkillsDir: finds skill with dir name as default name", async () => {
  const base = await mktmp();
  await mkSkill(base, "my-skill");
  const entries = await scanSkillsDir(base, "personal");
  expect(entries).toHaveLength(1);
  expect(entries[0].name).toBe("my-skill");
  expect(entries[0].source).toBe("personal");
  expect(entries[0].kind).toBe("skill");
});

test("scanSkillsDir: extracts description from first content line", async () => {
  const base = await mktmp();
  await mkSkill(base, "tool", "# Tool\nDoes something useful.\nMore text.");
  const entries = await scanSkillsDir(base, "personal");
  expect(entries[0].description).toBe("Does something useful.");
});

test("scanSkillsDir: reads name and description from YAML frontmatter", async () => {
  const base = await mktmp();
  const content = `---
name: custom-name
description: A great skill
---
# Heading
Body text here.`;
  await mkSkill(base, "raw-dir-name", content);
  const entries = await scanSkillsDir(base, "project");
  expect(entries[0].name).toBe("custom-name");
  expect(entries[0].description).toBe("A great skill");
  expect(entries[0].source).toBe("project");
});

test("scanSkillsDir: skips dirs without SKILL.md", async () => {
  const base = await mktmp();
  await mkdir(join(base, "no-skill-file"), { recursive: true });
  await mkSkill(base, "valid-skill");
  const entries = await scanSkillsDir(base, "personal");
  expect(entries).toHaveLength(1);
  expect(entries[0].name).toBe("valid-skill");
});

test("scanSkillsDir: truncates long descriptions to ~80 chars", async () => {
  const base = await mktmp();
  const longLine = "A".repeat(100);
  await mkSkill(base, "longdesc", `# Title\n${longLine}`);
  const entries = await scanSkillsDir(base, "personal");
  expect(entries[0].description!.length).toBeLessThanOrEqual(81);
  expect(entries[0].description!.endsWith("…")).toBe(true);
});

// ── scanCommandsDir ───────────────────────────────────────────────────────────

test("scanCommandsDir: returns empty array when dir does not exist", async () => {
  const entries = await scanCommandsDir("/nonexistent/path/commands", "personal");
  expect(entries).toEqual([]);
});

test("scanCommandsDir: finds command with basename as name", async () => {
  const base = await mktmp();
  await mkCommand(base, "my-command");
  const entries = await scanCommandsDir(base, "personal");
  expect(entries).toHaveLength(1);
  expect(entries[0].name).toBe("my-command");
  expect(entries[0].source).toBe("personal");
  expect(entries[0].kind).toBe("command");
});

test("scanCommandsDir: extracts description from first non-heading line", async () => {
  const base = await mktmp();
  await mkCommand(base, "deploy", "# Deploy\nDeploys the app to production.");
  const entries = await scanCommandsDir(base, "personal");
  expect(entries[0].description).toBe("Deploys the app to production.");
});

test("scanCommandsDir: ignores non-.md files", async () => {
  const base = await mktmp();
  await mkdir(base, { recursive: true });
  await writeFile(join(base, "not-a-command.txt"), "text");
  await writeFile(join(base, "also-not.json"), "{}");
  await mkCommand(base, "real-command");
  const entries = await scanCommandsDir(base, "personal");
  expect(entries).toHaveLength(1);
  expect(entries[0].name).toBe("real-command");
});

// ── listAllSlashEntries (integration-ish, no plugin mock needed) ───────────────

test("listAllSlashEntries: returns empty list when no skills or commands exist", async () => {
  const { listAllSlashEntries } = await import("../slashRegistry");
  const home = await mktmp();
  const cwd = await mktmp();
  const entries = await listAllSlashEntries({ home, cwd });
  expect(entries).toEqual([]);
});

test("listAllSlashEntries: surfaces personal skills", async () => {
  const { listAllSlashEntries } = await import("../slashRegistry");
  const home = await mktmp();
  const cwd = await mktmp();
  await mkSkill(join(home, ".claude", "skills"), "personal-tool");
  const entries = await listAllSlashEntries({ home, cwd });
  expect(entries.some(e => e.name === "personal-tool" && e.source === "personal")).toBe(true);
});

test("listAllSlashEntries: surfaces project skills", async () => {
  const { listAllSlashEntries } = await import("../slashRegistry");
  const home = await mktmp();
  const cwd = await mktmp();
  await mkSkill(join(cwd, ".claude", "skills"), "project-tool");
  const entries = await listAllSlashEntries({ home, cwd });
  expect(entries.some(e => e.name === "project-tool" && e.source === "project")).toBe(true);
});

test("listAllSlashEntries: surfaces personal commands", async () => {
  const { listAllSlashEntries } = await import("../slashRegistry");
  const home = await mktmp();
  const cwd = await mktmp();
  await mkCommand(join(home, ".claude", "commands"), "my-cmd");
  const entries = await listAllSlashEntries({ home, cwd });
  expect(entries.some(e => e.name === "my-cmd" && e.source === "personal" && e.kind === "command")).toBe(true);
});

test("listAllSlashEntries: surfaces project commands", async () => {
  const { listAllSlashEntries } = await import("../slashRegistry");
  const home = await mktmp();
  const cwd = await mktmp();
  await mkCommand(join(cwd, ".claude", "commands"), "proj-cmd");
  const entries = await listAllSlashEntries({ home, cwd });
  expect(entries.some(e => e.name === "proj-cmd" && e.source === "project" && e.kind === "command")).toBe(true);
});

test("listAllSlashEntries: deduplicates by name — project wins over personal", async () => {
  const { listAllSlashEntries } = await import("../slashRegistry");
  const home = await mktmp();
  const cwd = await mktmp();
  await mkSkill(join(home, ".claude", "skills"), "shared-name", "# shared-name\nPersonal version.");
  await mkSkill(join(cwd, ".claude", "skills"), "shared-name", "# shared-name\nProject version.");
  const entries = await listAllSlashEntries({ home, cwd });
  const shared = entries.filter(e => e.name === "shared-name");
  expect(shared).toHaveLength(1);
  expect(shared[0].source).toBe("project");
  expect(shared[0].description).toBe("Project version.");
});

test("listAllSlashEntries: result is sorted alphabetically by name", async () => {
  const { listAllSlashEntries } = await import("../slashRegistry");
  const home = await mktmp();
  const cwd = await mktmp();
  await mkSkill(join(cwd, ".claude", "skills"), "zebra");
  await mkSkill(join(cwd, ".claude", "skills"), "alpha");
  await mkSkill(join(cwd, ".claude", "skills"), "middle");
  const entries = await listAllSlashEntries({ home, cwd });
  const names = entries.map(e => e.name);
  expect(names).toEqual([...names].sort());
});

test("listAllSlashEntries: gracefully handles missing .claude dirs", async () => {
  const { listAllSlashEntries } = await import("../slashRegistry");
  const home = await mktmp();
  const cwd = await mktmp();
  // Intentionally empty — no .claude dirs
  const entries = await listAllSlashEntries({ home, cwd });
  expect(Array.isArray(entries)).toBe(true);
  expect(entries).toHaveLength(0);
});
