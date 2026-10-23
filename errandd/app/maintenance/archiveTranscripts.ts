/**
 * 7z stale claude-code transcripts out of `~/.claude/projects`.
 *
 * The daemon opens thousands of short sessions a day and claude-code keeps every
 * transcript for `cleanupPeriodDays` (30 by default). On the deployed pod that
 * reached 12GiB across 167,960 `.jsonl` files and filled the 20Gi state volume,
 * crashlooping the daemon on SQLITE_FULL — the same failure mode the plugin
 * cache caused before `prunePluginCache` (see pluginCache.ts).
 *
 * Deleting them would lose the history, so archive instead: LZMA2 measures 6.4x
 * on real transcripts (27MiB of them compressed to 4.2MiB), which turns that
 * 12GiB into roughly 1.9GiB. Archives are grouped by project and by the
 * transcript's own date, so recovering one session means extracting one day
 * rather than one 12GiB blob:
 *
 *   ~/.claude/errandd/archive/transcripts/<project-slug>/<YYYY-MM-DD>.7z
 *
 * `7z a -sdel` removes each source file only after it is safely in the archive,
 * so an interrupted run leaves the un-archived transcripts alone and the next
 * tick picks them up. Appending to an existing day archive is likewise
 * idempotent — a re-run with nothing stale is a no-op.
 */
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Transcripts idle this long get archived. Override: ERRANDD_AUTO_ARCHIVE_DAYS. */
export const DEFAULT_AUTO_ARCHIVE_DAYS = 14;

/**
 * Transcripts archived per tick. The first run on a neglected volume faces six
 * figures of files and `-mx=9` is slow; a cap keeps one hourly tick bounded and
 * lets the backlog drain over the following ones.
 */
const MAX_FILES_PER_RUN = 5_000;

/**
 * The binary's name is not portable: upstream's own build and Homebrew install
 * it as `7zz`, while Debian's `7zip` package (the replacement for the dropped
 * `p7zip-full`) installs `/usr/bin/7z`. Probe both rather than pinning either.
 */
const SEVENZIP_BINARIES = ["7zz", "7z"] as const;

let cachedBinary: string | null | undefined;

async function sevenZipBinary(): Promise<string | null> {
  if (cachedBinary !== undefined) {
    return cachedBinary;
  }
  for (const candidate of SEVENZIP_BINARIES) {
    if (Bun.which(candidate)) {
      cachedBinary = candidate;
      return cachedBinary;
    }
  }
  cachedBinary = null;
  return cachedBinary;
}

/** Resolved per call, not at import, so tests can point elsewhere. */
function defaultProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

function defaultArchiveDir(): string {
  return join(process.cwd(), ".claude", "errandd", "archive", "transcripts");
}

/** `0` or a negative value disables archiving entirely. */
export function archiveDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.ERRANDD_AUTO_ARCHIVE_DAYS ?? "").trim();
  if (!raw) {
    return DEFAULT_AUTO_ARCHIVE_DAYS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_AUTO_ARCHIVE_DAYS;
}

export interface TranscriptFile {
  /** Absolute path to the `.jsonl`. */
  path: string;
  /** Directory name under `projects/` — one archive tree per project. */
  project: string;
  mtimeMs: number;
}

export interface ArchiveGroup {
  /** `<project>/<YYYY-MM-DD>` — the archive's path minus the root and suffix. */
  key: string;
  files: string[];
}

/** UTC date stamp, so the grouping doesn't shift under the daemon's timezone. */
function dateStamp(mtimeMs: number): string {
  return new Date(mtimeMs).toISOString().slice(0, 10);
}

/**
 * Group the stale files into per-project, per-day archives, oldest first and
 * capped. Pure — the shell-out lives in `archiveTranscripts`.
 */
export function planArchive(files: TranscriptFile[], cutoffMs: number, cap = MAX_FILES_PER_RUN): ArchiveGroup[] {
  const stale = files.filter((f) => f.mtimeMs < cutoffMs).sort((a, b) => a.mtimeMs - b.mtimeMs).slice(0, cap);

  const groups = new Map<string, string[]>();
  for (const file of stale) {
    const key = `${file.project}/${dateStamp(file.mtimeMs)}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(file.path);
    } else {
      groups.set(key, [file.path]);
    }
  }
  return [...groups].map(([key, groupFiles]) => ({ key, files: groupFiles }));
}

/** Every `*.jsonl` under `projects/<project>/`, with the mtime the cutoff reads. */
async function collect(projectsDir: string): Promise<TranscriptFile[]> {
  let projects;
  try {
    projects = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return []; // no projects dir — nothing to do
  }

  const out: TranscriptFile[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) {
      continue;
    }
    const dir = join(projectsDir, project.name);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const full = join(dir, entry.name);
      try {
        out.push({ path: full, project: project.name, mtimeMs: (await stat(full)).mtimeMs });
      } catch {
        // vanished mid-walk — the daemon is still writing transcripts
      }
    }
  }
  return out;
}

/**
 * Add one group to its archive. 7z reads the file list from `@listfile` rather
 * than argv — a day's backlog is thousands of paths, well past ARG_MAX.
 */
async function compress(group: ArchiveGroup, archiveDir: string, binary: string): Promise<number> {
  const archive = join(archiveDir, `${group.key}.7z`);
  await mkdir(join(archive, ".."), { recursive: true });

  const listFile = `${archive}.filelist`;
  await writeFile(listFile, `${group.files.join("\n")}\n`);
  try {
    // -sdel: unlink each source only once it is in the archive, so a killed run
    // loses nothing. -mx=9: LZMA2 max, worth the CPU at the 6.4x it measures here.
    const proc = Bun.spawn([binary, "a", "-t7z", "-mx=9", "-sdel", "-bso0", "-bsp0", archive, `@${listFile}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`7z exited ${exitCode}: ${(await new Response(proc.stderr).text()).trim().slice(0, 400)}`);
    }
  } finally {
    await unlink(listFile).catch(() => {});
  }
  return group.files.length;
}

/**
 * Archive transcripts idle longer than `ERRANDD_AUTO_ARCHIVE_DAYS`. Idempotent;
 * returns a one-line summary (empty when nothing was stale) per the
 * maintenance-harness contract.
 */
export async function archiveTranscripts(
  projectsDir = defaultProjectsDir(),
  archiveDir = defaultArchiveDir(),
): Promise<string> {
  const days = archiveDays();
  if (days <= 0) {
    return ""; // explicitly disabled
  }

  const groups = planArchive(await collect(projectsDir), Date.now() - days * DAY_MS);
  if (groups.length === 0) {
    return "";
  }

  // Throw rather than no-op: a missing binary means transcripts pile up until
  // the volume fills again, and the harness logs a failed cleanup where a
  // silent "" would go unnoticed.
  const binary = await sevenZipBinary();
  if (!binary) {
    throw new Error(`no 7z binary on PATH (looked for ${SEVENZIP_BINARIES.join(", ")}) — ${groups.length} archive(s) pending`);
  }

  let archived = 0;
  for (const group of groups) {
    archived += await compress(group, archiveDir, binary);
  }
  return `archived ${archived} transcript(s) older than ${days}d into ${groups.length} 7z archive(s)`;
}
