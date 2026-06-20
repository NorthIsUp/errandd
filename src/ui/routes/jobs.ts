import { generateJobName, isDateFilename } from "../../haiku";
import { loadJobs } from "../../jobs";
import {
  findRepoBySlug,
  getAllRepoStatuses,
  getJobsRepoStatus,
  pullJobsRepo,
  pullRepo,
  syncJobsRepo,
  syncRepo,
} from "../../jobsRepo";
import { json } from "../http";
import {
  createJobFile,
  createQuickJob,
  deleteJob,
  deleteJobFile,
  listJobFiles,
  readJobFile,
  renameJobFile,
  writeJobFile,
} from "../services/jobs";
import type { RouteHandler } from "./types";

// --- Job file editor routes ---
// Resolve the target dir: ?repo=<slug> picks that repo's clone dir;
// no param = the local (non-repo) jobs dir. Important: when repos are
// configured, getJobsDirs() returns `[...repoDirs, DEFAULT_JOBS_DIR]`,
// so the local dir is the LAST entry, not the first. Returning [0]
// here caused the first repo's files to show up under "Local" too,
// which is why routines appeared duplicated across local/plugin.
async function resolveJobsDir(repoSlug?: string | null): Promise<string> {
  const { getJobsDirs, getJobsRepoDirForRepo } = await import("../../config");
  if (repoSlug) {
    const repo = findRepoBySlug(repoSlug);
    if (repo) {
      return getJobsRepoDirForRepo(repo);
    }
  }
  const dirs = getJobsDirs();
  return dirs[dirs.length - 1] ?? dirs[0];
}

/** GET /api/jobs/events — live job status SSE stream. */
export const jobsEvents: RouteHandler = ({ req, opts, sseResponse }) =>
  sseResponse(req, (send) => {
    if (opts.subscribeJobStatus) {
      return opts.subscribeJobStatus((snap) => send({ type: "status", ...snap }));
    }
    // No status source — emit one empty snapshot so the client doesn't
    // hang on an open-but-silent stream.
    send({ type: "status", active: [], results: {} });
    return () => {};
  });

/** POST /api/jobs/quick — create an ad-hoc one-shot job. */
export const jobsQuick: RouteHandler = async ({ req, opts }) => {
  try {
    const body = await req.json() as { time?: unknown; prompt?: unknown };
    const result = await createQuickJob(body);
    if (opts.onJobsChanged) {
      await opts.onJobsChanged();
    }
    return json({ ok: true, ...result });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
};

/** DELETE /api/jobs/:name — delete a job by name (not /api/jobs/file). */
export const jobsDelete: RouteHandler = async ({ req, url, opts }) => {
  if (
    !(
      url.pathname.startsWith("/api/jobs/") &&
      req.method === "DELETE" &&
      url.pathname !== "/api/jobs/file"
    )
  ) {
    return null;
  }
  try {
    const encodedName = url.pathname.slice("/api/jobs/".length);
    const name = decodeURIComponent(encodedName);
    await deleteJob(name);
    if (opts.onJobsChanged) {
      await opts.onJobsChanged();
    }
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
};

/** GET /api/jobs — list of jobs with prompt previews. */
export const jobsList: RouteHandler = ({ opts }) => {
  const jobs = opts.getSnapshot().jobs.map((j) => ({
    name: j.name,
    schedules: j.schedules,
    schedule: j.schedules[0] ?? "",
    promptPreview: j.prompt.slice(0, 160),
  }));
  return json({ jobs });
};

/** GET /api/jobs/files — list job files in a dir (?repo=slug). */
export const jobsFilesList: RouteHandler = async ({ url }) => {
  const repoSlug = url.searchParams.get("repo");
  const dir = await resolveJobsDir(repoSlug);
  return json(await listJobFiles(dir));
};

/** GET /api/jobs/file — read one job file. */
export const jobsFileGet: RouteHandler = async ({ url }) => {
  const p = url.searchParams.get("path") ?? "";
  const repoSlug = url.searchParams.get("repo");
  const dir = await resolveJobsDir(repoSlug);
  try {
    return json({ path: p, content: await readJobFile(p, dir) });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 400);
  }
};

/** PUT /api/jobs/file — write a job file. */
export const jobsFilePut: RouteHandler = async ({ req, url }) => {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const repoSlug = url.searchParams.get("repo") ?? (typeof body.repo === "string" ? body.repo : "");
  const dir = await resolveJobsDir(repoSlug || null);
  try {
    await writeJobFile(typeof body.path === "string" ? body.path : "", typeof body.content === "string" ? body.content : "", dir);
    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 400);
  }
};

/** POST /api/jobs/file — create a new job file. */
export const jobsFilePost: RouteHandler = async ({ req, url }) => {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const repoSlug = url.searchParams.get("repo") ?? (typeof body.repo === "string" ? body.repo : "");
  const dir = await resolveJobsDir(repoSlug || null);
  try {
    await createJobFile(typeof body.path === "string" ? body.path : "", dir);
    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 400);
  }
};

/** DELETE /api/jobs/file — delete a job file. */
export const jobsFileDelete: RouteHandler = async ({ url }) => {
  const p = url.searchParams.get("path") ?? "";
  const repoSlug = url.searchParams.get("repo");
  const dir = await resolveJobsDir(repoSlug);
  try {
    await deleteJobFile(p, dir);
    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 400);
  }
};

// --- Auto-name route: POST /api/jobs/file/auto-name ---
// Reads a date-pattern file, asks Haiku for a pithy kebab-case name,
// renames the file, and returns the new relative path.
export const jobsFileAutoName: RouteHandler = async ({ req, url }) => {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const path = typeof body.path === "string" ? body.path : "";
    const repoSlug = url.searchParams.get("repo") ?? (typeof body.repo === "string" ? body.repo : "");
    const dir = await resolveJobsDir(repoSlug || null);
    // Only operates on date-stamp filenames (no subdirectory prefix expected here,
    // but support the basename check in case path has a folder prefix).
    const basename = path.split("/").pop() ?? "";
    if (!isDateFilename(basename)) {
      return json({ error: "path does not match date-stamp pattern" }, 400);
    }
    const content = await readJobFile(path, dir);
    const name = await generateJobName(content);

    // Collision avoidance: find a free filename.
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    let candidate = `${name}.md`;
    let suffix = 2;
    while (existsSync(join(dir, candidate)) && suffix <= 20) {
      candidate = `${name}-${suffix}.md`;
      suffix++;
    }
    if (suffix > 20) {
      return json({ error: "could not find a free filename after 20 attempts" }, 400);
    }

    await renameJobFile(path, candidate, dir);
    return json({ ok: true, newPath: candidate });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 400);
  }
};

// --- Jobs repos routes (new multi-repo API) ---
/** GET /api/jobs/repos — all repo statuses. */
export const jobsReposList: RouteHandler = async () => json(await getAllRepoStatuses());

/** POST /api/jobs/repos/:slug/(pull|sync). Returns null on no path/method match. */
export const jobsReposAction: RouteHandler = async ({ req, url }) => {
  const repoActionMatch = /^\/api\/jobs\/repos\/([^/]+)\/(pull|sync)$/.exec(url.pathname);
  if (repoActionMatch && req.method === "POST") {
    const slug = decodeURIComponent(repoActionMatch[1]);
    const action = repoActionMatch[2];
    const repo = findRepoBySlug(slug);
    if (!repo) {
      return json({ ok: false, error: "repo not found" }, 404);
    }
    if (action === "pull") {
      return json(await pullRepo(repo));
    }
    if (action === "sync") {
      return json(await syncRepo(repo));
    }
  }
  return null;
};

// --- Legacy Jobs repo routes (back-compat aliases) ---
/** GET /api/jobs/repo/status. */
export const jobsRepoStatus: RouteHandler = async () => json(await getJobsRepoStatus());
/** POST /api/jobs/repo/sync. */
export const jobsRepoSync: RouteHandler = async () => json(await syncJobsRepo());
/** POST /api/jobs/repo/pull. */
export const jobsRepoPull: RouteHandler = async () => json(await pullJobsRepo());

/** GET /api/schedule-density — next-fire counts per hour of day. */
export const scheduleDensity: RouteHandler = async () => {
  try {
    const jobs = await loadJobs();
    const { nextCronMatch } = await import("../../cron");
    const now = new Date();
    // Count how many next-fire times fall in each hour of day 0-23
    const density = new Array<number>(24).fill(0);
    for (const job of jobs) {
      // Each schedule contributes a tick — a multi-schedule routine
      // shows up in every hour it fires.
      for (const cron of job.schedules) {
        try {
          const next = nextCronMatch(cron, now);
          density[next.getHours()]++;
        } catch {
          // skip unparseable
        }
      }
    }
    const data = density.map((count, hour) => ({ hour, count }));
    return json({ data });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
};
