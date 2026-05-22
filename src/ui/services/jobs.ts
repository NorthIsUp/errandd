import { mkdir, writeFile, readdir, readFile, stat, unlink } from "fs/promises";
import { join, resolve, relative } from "path";
import { getJobsDir } from "../../config";

export interface QuickJobInput {
  time?: unknown;
  prompt?: unknown;
  recurring?: unknown;
  daily?: unknown;
}

export async function createQuickJob(input: QuickJobInput): Promise<{ name: string; schedule: string; recurring: boolean }> {
  const time = typeof input.time === "string" ? input.time.trim() : "";
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const recurring = input.recurring == null
    ? (input.daily == null ? true : Boolean(input.daily))
    : Boolean(input.recurring);

  if (!/^\d{2}:\d{2}$/.test(time)) {
    throw new Error("Invalid time. Use HH:MM.");
  }
  if (!prompt) {
    throw new Error("Prompt is required.");
  }
  if (prompt.length > 10_000) {
    throw new Error("Prompt too long.");
  }

  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(3, 5));
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("Time out of range.");
  }

  const schedule = `${minute} ${hour} * * *`;
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const name = `quick-${stamp}-${hour.toString().padStart(2, "0")}${minute.toString().padStart(2, "0")}`;
  const path = join(getJobsDir(), `${name}.md`);
  const content = `---\nschedule: "${schedule}"\nrecurring: ${recurring ? "true" : "false"}\n---\n${prompt}\n`;

  await mkdir(getJobsDir(), { recursive: true });
  await writeFile(path, content, "utf-8");
  return { name, schedule, recurring };
}

export async function deleteJob(name: string): Promise<void> {
  const jobName = String(name || "").trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(jobName)) {
    throw new Error("Invalid job name.");
  }
  const path = join(getJobsDir(), `${jobName}.md`);
  await Bun.file(path).delete();
}

export interface JobFileEntry {
  path: string;     // relative to jobs dir
  name: string;
  size: number;
  mtime: string;
  isJob: boolean;   // .md with valid frontmatter
}

/** True when `relPath` is a safe relative path inside the jobs dir. */
export function isSafeJobPath(relPath: string): boolean {
  if (!relPath || relPath.length > 200) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(relPath)) return false;
  if (relPath.startsWith("/") || relPath.endsWith("/") || relPath.includes("..")) return false;
  return true;
}

function resolveSafe(relPath: string): string {
  if (!isSafeJobPath(relPath)) throw new Error("Invalid job path.");
  const dir = getJobsDir();
  const full = resolve(dir, relPath);
  const rel = relative(dir, full);
  if (rel.startsWith("..") || resolve(dir, rel) !== full) throw new Error("Invalid job path.");
  return full;
}

/** List all files in the jobs dir (recursive), relative paths. */
export async function listJobFiles(): Promise<JobFileEntry[]> {
  const dir = getJobsDir();
  const out: JobFileEntry[] = [];
  async function walk(sub: string): Promise<void> {
    let entries: import("fs").Dirent[] = [];
    try { entries = await readdir(join(dir, sub), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) { await walk(rel); continue; }
      const s = await stat(join(dir, rel));
      let isJob = false;
      if (e.name.endsWith(".md")) {
        try { isJob = /^---\s*\n[\s\S]*?\n---/.test(await readFile(join(dir, rel), "utf-8")); } catch {}
      }
      out.push({ path: rel, name: e.name, size: s.size, mtime: s.mtime.toISOString(), isJob });
    }
  }
  await walk("");
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export async function readJobFile(relPath: string): Promise<string> {
  return readFile(resolveSafe(relPath), "utf-8");
}

export async function writeJobFile(relPath: string, content: string): Promise<void> {
  if (content.length > 100_000) throw new Error("File too large.");
  const full = resolveSafe(relPath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf-8");
}

export async function createJobFile(relPath: string): Promise<void> {
  const full = resolveSafe(relPath);
  if (await Bun.file(full).exists()) throw new Error("File already exists.");
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, "---\nschedule: \"0 9 * * *\"\nrecurring: true\n---\n", "utf-8");
}

export async function deleteJobFile(relPath: string): Promise<void> {
  await unlink(resolveSafe(relPath));
}
