import { getAllRepoStatuses } from "../../jobsRepo";
import { getRateLimitResetAt, isRateLimited } from "../../rate-limit";
import { getTailnetIdentity, type TailnetIdentity } from "../auth";
import { json } from "../http";
import { readLogs } from "../services/logs";
import { buildState } from "../services/state";
import type { RouteHandler } from "./types";

/** GET /api/state — server state plus optional trusted tailnet identity.
 *
 * Cross-slice contract: the frontend reads `rateLimit: { limited, resetAt }`
 * (resetAt = 0 when not limited) to render a "usage limit — back at HH:MM"
 * banner. We read the limiter singleton here rather than threading it through
 * the shared buildState() so the field stays owned by this slice. */
export const getState: RouteHandler = async ({ req, opts }) => {
  // Only surface the tailnet identity when the operator explicitly
  // trusts the upstream header — otherwise an attacker behind a
  // misconfigured proxy could spoof it.
  const tailnetIdentity: TailnetIdentity | null = opts.trustTailnet
    ? getTailnetIdentity(req)
    : null;
  const state = await buildState(opts.getSnapshot(), { tailnet: tailnetIdentity });
  const limited = isRateLimited();
  return json({
    ...state,
    rateLimit: { limited, resetAt: limited ? getRateLimitResetAt() : 0 },
  });
};

/** GET /api/runtime/update-check — how far behind origin/<branch> we are. */
export const updateCheck: RouteHandler = async ({ url }) => {
  const { checkForUpdate } = await import("../../runtime");
  const force = url.searchParams.get("force") === "1";
  return json(await checkForUpdate(force));
};

/** POST /api/runtime/update — fast-forward pull (no self-restart). */
export const applyUpdateRoute: RouteHandler = async () => {
  const { applyUpdate } = await import("../../runtime");
  const result = await applyUpdate();
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 409,
    headers: { "Content-Type": "application/json" },
  });
};

/** GET /api/logs — tail of the daemon log. */
export const getLogs: RouteHandler = async ({ url }) => {
  const { clampInt } = await import("../http");
  const tail = clampInt(url.searchParams.get("tail"), 200, 20, 2000);
  return json(await readLogs(tail));
};

/** GET /api/home — aggregated server + jobs + repos + logs. */
export const getHome: RouteHandler = async ({ req, opts }) => {
  const snapshot = opts.getSnapshot();
  // Use the in-memory jobs from the snapshot (the live currentJobs) rather than
  // re-reading + re-parsing every job file from disk on each poll — buildState
  // already maps snapshot.jobs, so loadJobs() here was pure redundant I/O that
  // made /api/home one of the slowest endpoints under dashboard polling.
  const jobs = snapshot.jobs;
  const repos = await getAllRepoStatuses();
  const tailnetIdentity: TailnetIdentity | null = opts.trustTailnet
    ? getTailnetIdentity(req)
    : null;
  return json({
    server: await buildState(snapshot, { tailnet: tailnetIdentity }),
    jobs: jobs.map((j) => ({
      name: j.name,
      schedules: j.schedules,
      schedule: j.schedules[0] ?? "",
      recurring: j.recurring,
    })),
    repos, // new multi-repo field
    repo: repos[0] ?? null, // back-compat alias (first repo)
    logs: await readLogs(20),
  });
};
