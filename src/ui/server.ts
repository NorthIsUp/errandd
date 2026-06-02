import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateJobName, isDateFilename } from "../haiku";
import {
  deliveryForWire,
  getDeliveryPayload,
  recentDeliveries,
  subscribeDeliveries,
} from "../hooks/deliveries";
import { getWebhookSecret, handleWebhook } from "../hooks/receiver";
import { loadJobs } from "../jobs";
import {
  findRepoBySlug,
  getAllRepoStatuses,
  getJobsRepoStatus,
  pullJobsRepo,
  pullRepo,
  syncJobsRepo,
  syncRepo,
} from "../jobsRepo";
import { addMcpServer, listMcpServers, removeMcpServer } from "../mcp";
import { runUserMessage } from "../runner";
import { resetSession } from "../sessions";
import {
  attachAuthCookie,
  authenticate,
  checkToken,
  getTailnetIdentity,
  type TailnetIdentity,
} from "./auth";
import { clampInt, json, withJson } from "./http";
import {
  createJobFile,
  createQuickJob,
  deleteJob,
  deleteJobFile,
  listJobFiles,
  readJobFile,
  renameJobFile,
  writeJobFile,
} from "./services/jobs";
import { readLogs } from "./services/logs";
import {
  getSessionEffort,
  getSessionGoal,
  getSessionModel,
  normalizeTitle,
  setSessionClosed,
  setSessionEffort,
  setSessionGoal,
  setSessionModel,
  setSessionTitle,
} from "./services/session-meta";
import { listAgents, listSessions, readSessionMessages } from "./services/sessions";
import { readHeartbeatSettings, updateHeartbeatSettings } from "./services/settings";
import { buildState, buildTechnicalInfo, sanitizeSettings } from "./services/state";
import { getSessionUsage } from "./services/usage";
import type { StartWebUiOptions, WebServerHandle } from "./types";

// When clawdcode is installed via `claude plugin install` the source is
// extracted to ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
// without a dist/web/ — `bun run build:web` is a dev-time step that the
// plugin tarball doesn't carry. Without it the /ui/, /darwin/, /os9/,
// /osish/ routes 404 with "UI not built". Detect that on startup and
// build once, blocking until dist/web/ui/index.html exists.
function ensureWebBuilt(): void {
  const pkgRoot = join(import.meta.dir, "..", "..");
  const sentinel = join(pkgRoot, "dist", "web", "ui", "index.html");
  if (existsSync(sentinel)) {
    return;
  }
  console.error("[clawdcode] dist/web missing — running `bun run build:web`...");
  const r = spawnSync("bun", ["run", "build:web"], {
    cwd: pkgRoot,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error("[clawdcode] build:web failed — /ui/ will 404 until you fix it.");
  }
}

export function startWebUi(opts: StartWebUiOptions): WebServerHandle {
  ensureWebBuilt();
  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    idleTimeout: 0,
    fetch: async (req) => {
      const url = new URL(req.url);

      // Task 1.2: Reject DNS rebinding attacks via Host header validation.
      // Wildcard bind addresses (0.0.0.0, ::) mean the user opted into remote access —
      // the browser Host header won't match the bind address, so we skip the check.
      // For specific bind addresses (loopback or LAN IP) we enforce the allowlist.
      const host = req.headers.get("host") ?? "";
      const isWildcardBind = opts.host === "0.0.0.0" || opts.host === "::";
      if (!isWildcardBind) {
        const expectedHosts = new Set([
          `127.0.0.1:${opts.port}`,
          `localhost:${opts.port}`,
          `[::1]:${opts.port}`,
          `${opts.host}:${opts.port}`,
        ]);
        if (!expectedHosts.has(host)) {
          return new Response("Bad Host", { status: 421 });
        }
      }

      // Task 1.3: CSRF defense — reject cross-origin requests for state-changing methods.
      // Accept both http and https origins for validated hosts.
      if (req.method === "POST" || req.method === "PUT" || req.method === "DELETE") {
        const origin = req.headers.get("origin");
        if (origin) {
          const allowedOrigins = new Set([`http://${host}`, `https://${host}`]);
          if (!allowedOrigins.has(origin)) {
            return new Response("Bad Origin", { status: 403 });
          }
        }
      }

      // Serve the React web app from dist/web/<bundle>/ for all non-API routes.
      // Bundles: /ui/ (default, daisyUI build), /darwin/, /os9/, /osish/.
      // The bare root 302s to /ui/.
      {
        const webRoot = join(import.meta.dir, "..", "..", "dist", "web");

        if (url.pathname === "/" || url.pathname === "/index.html") {
          const target = new URL("/ui/", url.origin);
          // If the request handed us a valid ?token=, swap it for a signed
          // cookie and strip the token from the redirected URL. Otherwise we
          // just pass query params through so an invalid attempt still lands
          // at /ui/ for the SPA to react to.
          const authResult = authenticate(req, opts.token, { trustTailnet: opts.trustTailnet });
          if (authResult.valid && authResult.viaQuery) {
            for (const [k, v] of url.searchParams) {
              if (k !== "token") {
                target.searchParams.set(k, v);
              }
            }
            const headers = new Headers({ Location: target.toString() });
            attachAuthCookie(headers, req, opts.token);
            return new Response(null, { status: 302, headers });
          }
          for (const [k, v] of url.searchParams) {
            target.searchParams.set(k, v);
          }
          return Response.redirect(target.toString(), 302);
        }

        const BUNDLES = ["ui", "darwin", "os9", "osish"] as const;
        const match = url.pathname.match(/^\/([^/]+)(\/.*)?$/);
        const bundle = match
          ? (BUNDLES as readonly string[]).includes(match[1] ?? "")
            ? match[1]
            : null
          : null;

        if (bundle) {
          const rest = match?.[2] ?? "";
          // /darwin (no trailing slash) → 301 to /darwin/ so relative HTML
          // paths like ./app.js resolve under the bundle prefix.
          if (rest === "") {
            const target = new URL(`/${bundle}/`, url.origin);
            for (const [k, v] of url.searchParams) {
              target.searchParams.set(k, v);
            }
            return Response.redirect(target.toString(), 301);
          }
          // /darwin/ → serve the bundle's index.html
          if (rest === "/") {
            const indexPath = join(webRoot, bundle, "index.html");
            try {
              const data = await Bun.file(indexPath).arrayBuffer();
              const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
              // If they arrived with ?token=, upgrade to a signed cookie now
              // so the SPA can immediately drop the token from its URL.
              const authResult = authenticate(req, opts.token, { trustTailnet: opts.trustTailnet });
              if (authResult.valid && authResult.viaQuery) {
                attachAuthCookie(headers, req, opts.token);
              }
              return new Response(data, { headers });
            } catch {
              return new Response(`${bundle} UI not built — run \`bun run build:web\``, {
                status: 404,
              });
            }
          }
          // /darwin/app.js, /os9/app.css, etc.
          const assetRel = rest.replace(/^\//, "");
          const assetPath = join(webRoot, bundle, assetRel);
          const assetFile = Bun.file(assetPath);
          if (await assetFile.exists()) {
            const type = assetRel.endsWith(".js")
              ? "application/javascript; charset=utf-8"
              : assetRel.endsWith(".css")
                ? "text/css; charset=utf-8"
                : assetRel.endsWith(".svg")
                  ? "image/svg+xml"
                  : assetRel.endsWith(".json")
                    ? "application/json"
                    : "application/octet-stream";
            return new Response(await assetFile.arrayBuffer(), {
              headers: { "Content-Type": type },
            });
          }
        }
      }

      // Health check is intentionally pre-auth so monitors and load balancers work unauthenticated.
      if (url.pathname === "/api/health") {
        return json({ ok: true, now: Date.now() });
      }

      // GitHub webhook is pre-auth — it carries its own HMAC signature
      // (X-Hub-Signature-256) rather than a bearer token. Verification lives
      // inside handleWebhook; an unsigned/invalid request returns 401 there.
      // Canonical path is /api/webhooks/github; /api/github/webhook is kept as
      // a deprecated alias so an in-flight URL cutover (funnel + GitHub config)
      // never has a window where deliveries 404.
      if (
        (url.pathname === "/api/webhooks/github" || url.pathname === "/api/github/webhook") &&
        req.method === "POST"
      ) {
        const result = await handleWebhook(req, {
          getJobs: () => opts.getSnapshot().jobs,
          ...(opts.onHookFire ? { onHookFire: opts.onHookFire } : {}),
          ...(opts.onHookSkip ? { onHookSkip: opts.onHookSkip } : {}),
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Sentry / Datadog webhooks — pre-auth like the GitHub one, each
      // carries its own verification (HMAC for Sentry, shared token for
      // Datadog) inside the handler.
      if (
        (url.pathname === "/api/webhooks/sentry" || url.pathname === "/api/sentry/webhook") &&
        req.method === "POST"
      ) {
        const { handleSentryWebhook } = await import("../hooks/sentry");
        const result = await handleSentryWebhook(req, {
          getJobs: () => opts.getSnapshot().jobs,
          ...(opts.onHookFire ? { onHookFire: opts.onHookFire } : {}),
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        (url.pathname === "/api/webhooks/datadog" || url.pathname === "/api/datadog/webhook") &&
        req.method === "POST"
      ) {
        const { handleDatadogWebhook } = await import("../hooks/datadog");
        const result = await handleDatadogWebhook(req, {
          getJobs: () => opts.getSnapshot().jobs,
          ...(opts.onHookFire ? { onHookFire: opts.onHookFire } : {}),
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Task 1.1: Require bearer token for all /api/* routes. Accepts the
      // signed cookie (set after the initial /ui/?token= handshake), a Bearer
      // header, or ?token=… as a one-shot. /api/inject also accepts the
      // legacy settings.apiToken so existing automation isn't broken.
      if (url.pathname.startsWith("/api/")) {
        const apiToken = opts.getSnapshot().settings.apiToken;
        const validWebToken = checkToken(req, opts.token, { trustTailnet: opts.trustTailnet });
        const validApiToken =
          url.pathname === "/api/inject" && !!apiToken && checkToken(req, apiToken);
        if (!(validWebToken || validApiToken)) {
          return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      if (url.pathname === "/api/state") {
        // Only surface the tailnet identity when the operator explicitly
        // trusts the upstream header — otherwise an attacker behind a
        // misconfigured proxy could spoof it.
        const tailnetIdentity: TailnetIdentity | null = opts.trustTailnet
          ? getTailnetIdentity(req)
          : null;
        return json(await buildState(opts.getSnapshot(), { tailnet: tailnetIdentity }));
      }

      // Self-update routes: report how far behind origin/<branch> we are
      // and (optionally) apply a fast-forward pull. The daemon does NOT
      // self-restart — the user clicks Restart after.
      if (url.pathname === "/api/runtime/update-check" && req.method === "GET") {
        const { checkForUpdate } = await import("../runtime");
        const force = url.searchParams.get("force") === "1";
        return json(await checkForUpdate(force));
      }
      if (url.pathname === "/api/runtime/update" && req.method === "POST") {
        const { applyUpdate } = await import("../runtime");
        const result = await applyUpdate();
        return new Response(JSON.stringify(result), {
          status: result.ok ? 200 : 409,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Live job status stream — pushes a JobStatusSnapshot every time a job
      // transitions (starts, finishes, retried). The Schedule tab subscribes
      // to this instead of polling /api/state.
      if (url.pathname === "/api/jobs/events" && req.method === "GET") {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            let closed = false;
            const send = (data: unknown) => {
              if (closed) {
                return;
              }
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
              } catch {
                closed = true;
              }
            };
            // Heartbeat every 25s so proxies don't kill the stream and the
            // client can detect a dead connection.
            const heartbeat = setInterval(() => send({ type: "ping" }), 25_000);
            const unsubscribe = opts.subscribeJobStatus
              ? opts.subscribeJobStatus((snap) => send({ type: "status", ...snap }))
              : null;
            // If the daemon doesn't expose subscribeJobStatus, emit one empty
            // snapshot so the client doesn't hang on an open-but-silent stream.
            if (!opts.subscribeJobStatus) {
              send({ type: "status", active: [], results: {} });
            }
            req.signal.addEventListener("abort", () => {
              closed = true;
              clearInterval(heartbeat);
              unsubscribe?.();
              try {
                controller.close();
              } catch {
                // already closed
              }
            });
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }

      if (url.pathname === "/api/settings" && req.method === "GET") {
        return json(sanitizeSettings(opts.getSnapshot().settings));
      }

      if (url.pathname === "/api/settings" && req.method === "PUT") {
        try {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const { readFile, writeFile } = await import("node:fs/promises");
          const { SETTINGS_FILE } = await import("./constants");
          const raw = await readFile(SETTINGS_FILE, "utf-8").catch(() => "{}");
          const data = JSON.parse(raw) as Record<string, unknown>;
          // Allow shallow-merge of these top-level keys
          const allowed = ["model", "fallback", "security", "timezone", "jobsRepo", "git"] as const;
          for (const key of allowed) {
            if (key in body && body[key] !== undefined) {
              if (
                typeof body[key] === "object" &&
                body[key] !== null &&
                !Array.isArray(body[key])
              ) {
                // Deep merge objects one level
                data[key] = Object.assign(
                  {},
                  typeof data[key] === "object" ? data[key] : {},
                  body[key],
                );
              } else if (typeof body[key] === "string") {
                data[key] = body[key];
              }
            }
          }
          // jobsRepos: accept an array directly, drop rows with empty URLs
          if ("jobsRepos" in body && Array.isArray(body.jobsRepos)) {
            data.jobsRepos = (body.jobsRepos as unknown[])
              .filter(
                (r: unknown) =>
                  r &&
                  typeof r === "object" &&
                  typeof (r as Record<string, unknown>).url === "string" &&
                  String((r as Record<string, unknown>).url).trim(),
              )
              .map((r: unknown) => {
                const row = r as Record<string, unknown>;
                return {
                  kind: row.kind === "plugin" ? "plugin" : "git",
                  url: String(row.url).trim(),
                  branch:
                    typeof row.branch === "string" && row.branch.trim()
                      ? row.branch.trim()
                      : "main",
                  intervalSeconds:
                    Number.isFinite(Number(row.intervalSeconds)) && Number(row.intervalSeconds) >= 0
                      ? Number(row.intervalSeconds)
                      : 300,
                };
              });
          }
          await writeFile(SETTINGS_FILE, `${JSON.stringify(data, null, 2)}\n`);
          // Refresh the in-memory settings cache so the next /api/state read is current.
          const { reloadSettings } = await import("../config");
          await reloadSettings();
          return json({ ok: true });
        } catch (err) {
          return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 500);
        }
      }

      if (url.pathname === "/api/settings/heartbeat" && req.method === "POST") {
        try {
          const body = await req.json();
          const payload = body as {
            enabled?: unknown;
            interval?: unknown;
            prompt?: unknown;
            excludeWindows?: unknown;
          };
          const patch: {
            enabled?: boolean;
            interval?: number;
            prompt?: string;
            excludeWindows?: Array<{ days?: number[]; start: string; end: string }>;
          } = {};

          if ("enabled" in payload) {
            patch.enabled = Boolean(payload.enabled);
          }
          if ("interval" in payload) {
            const iv = Number(payload.interval);
            if (!Number.isFinite(iv)) {
              throw new Error("interval must be numeric");
            }
            patch.interval = iv;
          }
          if ("prompt" in payload) {
            patch.prompt = String(payload.prompt ?? "");
          }
          if ("excludeWindows" in payload) {
            if (!Array.isArray(payload.excludeWindows)) {
              throw new Error("excludeWindows must be an array");
            }
            patch.excludeWindows = payload.excludeWindows
              .filter((entry) => entry && typeof entry === "object")
              .map((entry) => {
                const row = entry as Record<string, unknown>;
                const start = String(row.start ?? "").trim();
                const end = String(row.end ?? "").trim();
                const days = Array.isArray(row.days)
                  ? row.days
                      .map((d) => Number(d))
                      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
                  : undefined;
                return {
                  start,
                  end,
                  ...(days && days.length > 0 ? { days } : {}),
                };
              });
          }

          if (
            !(
              "enabled" in patch ||
              "interval" in patch ||
              "prompt" in patch ||
              "excludeWindows" in patch
            )
          ) {
            throw new Error("no heartbeat fields provided");
          }

          const next = await updateHeartbeatSettings(patch);
          if (opts.onHeartbeatEnabledChanged && "enabled" in patch) {
            await opts.onHeartbeatEnabledChanged(Boolean(patch.enabled));
          }
          if (opts.onHeartbeatSettingsChanged) {
            await opts.onHeartbeatSettingsChanged(patch);
          }
          return json({ ok: true, heartbeat: next });
        } catch (err) {
          return json({ ok: false, error: String(err) }, 500);
        }
      }

      if (url.pathname === "/api/settings/heartbeat" && req.method === "GET") {
        try {
          return json({ ok: true, heartbeat: await readHeartbeatSettings() });
        } catch (err) {
          return json({ ok: false, error: String(err) }, 500);
        }
      }

      if (url.pathname === "/api/technical-info") {
        return json(await buildTechnicalInfo(opts.getSnapshot()));
      }

      if (url.pathname === "/api/jobs/quick" && req.method === "POST") {
        try {
          const body = await req.json();
          const result = await createQuickJob(body as { time?: unknown; prompt?: unknown });
          if (opts.onJobsChanged) {
            await opts.onJobsChanged();
          }
          return json({ ok: true, ...result });
        } catch (err) {
          return json({ ok: false, error: String(err) }, 500);
        }
      }

      if (
        url.pathname.startsWith("/api/jobs/") &&
        req.method === "DELETE" &&
        url.pathname !== "/api/jobs/file"
      ) {
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
      }

      if (url.pathname === "/api/jobs") {
        const jobs = opts.getSnapshot().jobs.map((j) => ({
          name: j.name,
          schedules: j.schedules,
          schedule: j.schedules[0] ?? "",
          promptPreview: j.prompt.slice(0, 160),
        }));
        return json({ jobs });
      }

      // --- Job file editor routes ---
      // Resolve the target dir: ?repo=<slug> picks that repo's clone dir;
      // no param = the local (non-repo) jobs dir. Important: when repos are
      // configured, getJobsDirs() returns `[...repoDirs, DEFAULT_JOBS_DIR]`,
      // so the local dir is the LAST entry, not the first. Returning [0]
      // here caused the first repo's files to show up under "Local" too,
      // which is why routines appeared duplicated across local/plugin.
      async function resolveJobsDir(repoSlug?: string | null): Promise<string> {
        const { getJobsDirs, getJobsRepoDirForRepo } = await import("../config");
        if (repoSlug) {
          const repo = findRepoBySlug(repoSlug);
          if (repo) {
            return getJobsRepoDirForRepo(repo);
          }
        }
        const dirs = getJobsDirs();
        return dirs[dirs.length - 1] ?? dirs[0];
      }

      if (url.pathname === "/api/jobs/files" && req.method === "GET") {
        const repoSlug = url.searchParams.get("repo");
        const dir = await resolveJobsDir(repoSlug);
        return json(await listJobFiles(dir));
      }
      if (url.pathname === "/api/jobs/file" && req.method === "GET") {
        const p = url.searchParams.get("path") ?? "";
        const repoSlug = url.searchParams.get("repo");
        const dir = await resolveJobsDir(repoSlug);
        try {
          return json({ path: p, content: await readJobFile(p, dir) });
        } catch (e) {
          return json({ error: String(e instanceof Error ? e.message : e) }, 400);
        }
      }
      if (url.pathname === "/api/jobs/file" && req.method === "PUT") {
        const body = await req.json().catch(() => ({}));
        const repoSlug = url.searchParams.get("repo") ?? String(body.repo ?? "");
        const dir = await resolveJobsDir(repoSlug || null);
        try {
          await writeJobFile(String(body.path ?? ""), String(body.content ?? ""), dir);
          return json({ ok: true });
        } catch (e) {
          return json({ error: String(e instanceof Error ? e.message : e) }, 400);
        }
      }
      if (url.pathname === "/api/jobs/file" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const repoSlug = url.searchParams.get("repo") ?? String(body.repo ?? "");
        const dir = await resolveJobsDir(repoSlug || null);
        try {
          await createJobFile(String(body.path ?? ""), dir);
          return json({ ok: true });
        } catch (e) {
          return json({ error: String(e instanceof Error ? e.message : e) }, 400);
        }
      }
      if (url.pathname === "/api/jobs/file" && req.method === "DELETE") {
        const p = url.searchParams.get("path") ?? "";
        const repoSlug = url.searchParams.get("repo");
        const dir = await resolveJobsDir(repoSlug);
        try {
          await deleteJobFile(p, dir);
          return json({ ok: true });
        } catch (e) {
          return json({ error: String(e instanceof Error ? e.message : e) }, 400);
        }
      }

      // --- Auto-name route: POST /api/jobs/file/auto-name ---
      // Reads a date-pattern file, asks Haiku for a pithy kebab-case name,
      // renames the file, and returns the new relative path.
      if (url.pathname === "/api/jobs/file/auto-name" && req.method === "POST") {
        try {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const path = String(body.path ?? "");
          // Only operates on date-stamp filenames (no subdirectory prefix expected here,
          // but support the basename check in case path has a folder prefix).
          const basename = path.split("/").pop() ?? "";
          if (!isDateFilename(basename)) {
            return json({ error: "path does not match date-stamp pattern" }, 400);
          }
          const content = await readJobFile(path);
          const name = await generateJobName(content);

          // Collision avoidance: find a free filename.
          const jobsDir = (await import("../config")).getJobsDir();
          const { existsSync } = await import("node:fs");
          const { join } = await import("node:path");
          let candidate = `${name}.md`;
          let suffix = 2;
          while (existsSync(join(jobsDir, candidate)) && suffix <= 20) {
            candidate = `${name}-${suffix}.md`;
            suffix++;
          }
          if (suffix > 20) {
            return json({ error: "could not find a free filename after 20 attempts" }, 400);
          }

          await renameJobFile(path, candidate);
          return json({ ok: true, newPath: candidate });
        } catch (e) {
          return json({ error: String(e instanceof Error ? e.message : e) }, 400);
        }
      }

      // --- Jobs repos routes (new multi-repo API) ---
      if (url.pathname === "/api/jobs/repos" && req.method === "GET") {
        return json(await getAllRepoStatuses());
      }
      // POST /api/jobs/repos/<slug>/pull or /sync
      {
        const repoActionMatch = url.pathname.match(/^\/api\/jobs\/repos\/([^/]+)\/(pull|sync)$/);
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
      }

      // --- Claude plugin manager routes ---
      // These wrap the `claude plugin` CLI so the Settings UI can do full
      // marketplace + plugin lifecycle management without the user dropping
      // to the terminal.
      if (url.pathname === "/api/claude-plugins" && req.method === "GET") {
        const m = await import("./services/claudePlugins");
        return json(await m.listPlugins());
      }
      if (url.pathname === "/api/claude-plugins/marketplaces" && req.method === "GET") {
        const m = await import("./services/claudePlugins");
        return json(await m.listMarketplaces());
      }
      if (url.pathname === "/api/claude-plugins/marketplaces" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { ref?: unknown };
        const ref = typeof body.ref === "string" ? body.ref.trim() : "";
        if (!ref) {
          return json({ ok: false, error: "ref required" }, 400);
        }
        const m = await import("./services/claudePlugins");
        return json(await m.addMarketplace(ref));
      }
      if (url.pathname === "/api/claude-plugins/marketplaces/update-all" && req.method === "POST") {
        const m = await import("./services/claudePlugins");
        return json(await m.updateMarketplace());
      }
      {
        const mpMatch = url.pathname.match(
          /^\/api\/claude-plugins\/marketplaces\/([^/]+)(\/update)?$/,
        );
        if (mpMatch) {
          const name = decodeURIComponent(mpMatch[1] ?? "");
          const isUpdate = !!mpMatch[2];
          const m = await import("./services/claudePlugins");
          if (req.method === "DELETE" && !isUpdate) {
            return json(await m.removeMarketplace(name));
          }
          if (req.method === "POST" && isUpdate) {
            return json(await m.updateMarketplace(name));
          }
        }
      }
      if (url.pathname === "/api/claude-plugins/install" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { id?: unknown };
        const id = typeof body.id === "string" ? body.id.trim() : "";
        if (!id) {
          return json({ ok: false, error: "id required" }, 400);
        }
        const m = await import("./services/claudePlugins");
        return json(await m.installPlugin(id));
      }
      if (url.pathname === "/api/claude-plugins/update-all" && req.method === "POST") {
        const m = await import("./services/claudePlugins");
        return json(await m.updateAllPlugins());
      }
      {
        const pluginMatch = url.pathname.match(
          /^\/api\/claude-plugins\/([^/]+)(\/update|\/enable|\/disable)?$/,
        );
        if (
          pluginMatch &&
          pluginMatch[1] !== "marketplaces" &&
          pluginMatch[1] !== "install" &&
          pluginMatch[1] !== "update-all"
        ) {
          const id = decodeURIComponent(pluginMatch[1] ?? "");
          const action = pluginMatch[2];
          const m = await import("./services/claudePlugins");
          if (req.method === "DELETE" && !action) {
            return json(await m.uninstallPlugin(id));
          }
          if (req.method === "POST" && action === "/update") {
            return json(await m.updatePlugin(id));
          }
          if (req.method === "POST" && action === "/enable") {
            return json(await m.enablePlugin(id));
          }
          if (req.method === "POST" && action === "/disable") {
            return json(await m.disablePlugin(id));
          }
        }
      }

      // --- Legacy Jobs repo routes (back-compat aliases) ---
      if (url.pathname === "/api/jobs/repo/status" && req.method === "GET") {
        return json(await getJobsRepoStatus());
      }
      if (url.pathname === "/api/jobs/repo/sync" && req.method === "POST") {
        return json(await syncJobsRepo());
      }
      if (url.pathname === "/api/jobs/repo/pull" && req.method === "POST") {
        return json(await pullJobsRepo());
      }

      if (url.pathname === "/api/logs") {
        const tail = clampInt(url.searchParams.get("tail"), 200, 20, 2000);
        return json(await readLogs(tail));
      }

      if (url.pathname === "/api/sessions" && req.method === "GET") {
        try {
          const includeClosed = url.searchParams.get("includeClosed") === "1";
          return json(await listSessions(includeClosed));
        } catch (err) {
          return json({ ok: false, error: String(err) }, 500);
        }
      }

      if (url.pathname === "/api/hooks/deliveries" && req.method === "GET") {
        return json({ deliveries: recentDeliveries().map(deliveryForWire) });
      }

      // Full parsed payload for one delivery, fetched on demand (the list +
      // SSE responses omit it to stay light). 404 once it ages out of the ring.
      {
        const m = url.pathname.match(/^\/api\/hooks\/deliveries\/([^/]+)\/payload$/);
        if (m && req.method === "GET") {
          const found = getDeliveryPayload(decodeURIComponent(m[1]));
          if (!found) {
            return json({ ok: false, error: "no stored payload" }, 404);
          }
          return json(found);
        }
      }

      // Live delivery stream — pushes each delivery as it's recorded, matched,
      // or skip-annotated, so the Deliveries tab updates in real time. Sends
      // the current ring as an initial snapshot, then deltas keyed by id.
      if (url.pathname === "/api/hooks/events" && req.method === "GET") {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            let closed = false;
            const send = (data: unknown) => {
              if (closed) {
                return;
              }
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
              } catch {
                closed = true;
              }
            };
            send({ type: "snapshot", deliveries: recentDeliveries().map(deliveryForWire) });
            const heartbeat = setInterval(() => send({ type: "ping" }), 25_000);
            const unsubscribe = subscribeDeliveries((d) =>
              send({ type: "delivery", delivery: deliveryForWire(d) }),
            );
            req.signal.addEventListener("abort", () => {
              closed = true;
              clearInterval(heartbeat);
              unsubscribe();
              try {
                controller.close();
              } catch {
                // already closed
              }
            });
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }

      if (url.pathname === "/api/hooks/triggers" && req.method === "GET") {
        // Flatten one row per (job, pr-rule) so the UI can render a table.
        const jobs = opts.getSnapshot().jobs;
        const rows: {
          job: string;
          agent: string | null;
          repo: string | string[];
          user: string[];
          action: string[];
          branch: string[];
          labels: string[];
          draft: boolean | "any";
        }[] = [];
        for (const job of jobs) {
          for (const rule of job.hookConfig?.pr ?? []) {
            rows.push({
              job: job.name,
              agent: job.agent ?? null,
              repo: rule.repo,
              user: rule.user,
              action: rule.action,
              branch: rule.branch,
              labels: rule.labels,
              draft: rule.draft,
            });
          }
        }
        return json({ triggers: rows });
      }

      if (url.pathname === "/api/hooks/receiver" && req.method === "GET") {
        // The UI is gated by the bearer token so callers already have full
        // daemon access — same threat model as the web token itself.
        // Returning the raw secret enables a "click to reveal" affordance.
        const secret = getWebhookSecret();
        const last = recentDeliveries()[0] ?? null;
        const { getSentrySecret } = await import("../hooks/sentry");
        const { getDatadogSecret, RECOMMENDED_DATADOG_PAYLOAD } = await import("../hooks/datadog");
        const sentrySecret = getSentrySecret();
        const datadogSecret = getDatadogSecret();
        return json({
          // Back-compat top-level fields describe the GitHub receiver.
          configured: secret.length > 0,
          secret,
          url: `${url.origin}/api/webhooks/github`,
          lastEventAt: last?.receivedAt ?? null,
          lastEvent: last?.event ?? null,
          // Per-provider receiver status for the multi-provider UI.
          providers: {
            github: {
              configured: secret.length > 0,
              secret,
              url: `${url.origin}/api/webhooks/github`,
              secretEnv: "CLAWDCODE_GITHUB_WEBHOOK_SECRET",
            },
            sentry: {
              configured: sentrySecret.length > 0,
              secret: sentrySecret,
              url: `${url.origin}/api/webhooks/sentry`,
              secretEnv: "CLAWDCODE_SENTRY_CLIENT_SECRET",
            },
            datadog: {
              configured: datadogSecret.length > 0,
              secret: datadogSecret,
              url: `${url.origin}/api/webhooks/datadog`,
              secretEnv: "CLAWDCODE_DATADOG_WEBHOOK_SECRET",
              // Datadog auth rides as ?token= or X-Clawdcode-Token, and the
              // payload is user-defined — surface both the token-in-URL form
              // and the recommended payload template for copy-paste.
              tokenUrl: datadogSecret
                ? `${url.origin}/api/webhooks/datadog?token=${encodeURIComponent(datadogSecret)}`
                : `${url.origin}/api/webhooks/datadog`,
              recommendedPayload: RECOMMENDED_DATADOG_PAYLOAD,
            },
          },
        });
      }

      if (url.pathname === "/api/usage" && req.method === "GET") {
        try {
          const channelNames = opts.getSnapshot().settings.discord?.channelNames;
          return json(await getSessionUsage(channelNames));
        } catch (err) {
          return json({ ok: false, error: String(err) }, 500);
        }
      }

      if (url.pathname === "/api/usage-timeline" && req.method === "GET") {
        try {
          const channelNames = opts.getSnapshot().settings.discord?.channelNames;
          const range = url.searchParams.get("range") ?? "24h";
          const sessions = await getSessionUsage(channelNames);
          const now = Date.now();
          const rangeMs: Record<string, number> = {
            "1h": 3_600_000,
            "24h": 86_400_000,
            "7d": 604_800_000,
            "30d": 2_592_000_000,
          };
          const windowMs = rangeMs[range] ?? rangeMs["24h"]!;
          const bucketCount = range === "1h" ? 12 : range === "24h" ? 24 : range === "7d" ? 7 : 30;
          const bucketMs = windowMs / bucketCount;
          const cutoff = now - windowMs;
          type Bucket = {
            ts: string;
            totalCostUsd: number;
            totalTokens: number;
            byJob: Record<string, number>;
          };
          const buckets: Bucket[] = Array.from({ length: bucketCount }, (_, i) => ({
            ts: new Date(cutoff + i * bucketMs + bucketMs / 2).toISOString(),
            totalCostUsd: 0,
            totalTokens: 0,
            byJob: {},
          }));
          for (const s of sessions) {
            const t = s.lastUsedAt ? new Date(s.lastUsedAt).getTime() : 0;
            if (t < cutoff || t > now) {
              continue;
            }
            const idx = Math.min(bucketCount - 1, Math.floor((t - cutoff) / bucketMs));
            const bucket = buckets[idx];
            if (!bucket) {
              continue;
            }
            bucket.totalCostUsd += s.estimatedCostUsd;
            bucket.totalTokens +=
              s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens;
            if (s.label) {
              bucket.byJob[s.label] = (bucket.byJob[s.label] ?? 0) + s.estimatedCostUsd;
            }
          }
          return json({ buckets });
        } catch (err) {
          return json({ ok: false, error: String(err) }, 500);
        }
      }

      if (url.pathname === "/api/schedule-density" && req.method === "GET") {
        try {
          const jobs = await loadJobs();
          const { nextCronMatch } = await import("../cron");
          const now = new Date();
          // Count how many next-fire times fall in each hour of day 0-23
          const density: number[] = new Array(24).fill(0);
          for (const job of jobs) {
            // Each schedule contributes a tick — a multi-schedule routine
            // shows up in every hour it fires.
            for (const cron of job.schedules) {
              try {
                const next = nextCronMatch(cron, now);
                density[next.getHours()]!++;
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
      }

      if (url.pathname === "/api/agents" && req.method === "GET") {
        try {
          return json(await listAgents());
        } catch (err) {
          return json({ ok: false, error: String(err) }, 500);
        }
      }

      if (
        url.pathname.startsWith("/api/sessions/") &&
        url.pathname.endsWith("/messages") &&
        req.method === "GET"
      ) {
        const sessionId = url.pathname.slice("/api/sessions/".length, -"/messages".length);
        const limit = clampInt(url.searchParams.get("limit"), 10, 1, 2000);
        const rawOffset = url.searchParams.get("offset");
        const offset = rawOffset === "-1" ? -1 : clampInt(rawOffset, 0, 0, 100_000);
        try {
          return json(await readSessionMessages(sessionId, limit, offset));
        } catch (err) {
          return json({ ok: false, error: String(err) }, 500);
        }
      }

      // Full raw webhook payload for a hook session (lazy — payloads are
      // large, so they're not bundled into the session list).
      {
        const m = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]+)\/hook-payload$/i);
        if (m && req.method === "GET") {
          const { getSessionHookPayload } = await import("./services/session-meta");
          const stored = await getSessionHookPayload(m[1] as string);
          if (!stored) {
            return json({ ok: false, error: "no payload" }, 404);
          }
          return json(stored);
        }
        // Replay a stored hook delivery through the matcher with a fresh
        // delivery id, re-running (or re-skipping) it.
        const rp = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]+)\/reprocess$/i);
        if (rp && req.method === "POST") {
          const { getSessionHookPayload } = await import("./services/session-meta");
          const stored = await getSessionHookPayload(rp[1] as string);
          if (!stored) {
            return json({ ok: false, error: "no stored payload to reprocess" }, 404);
          }
          const { dispatchHook } = await import("../hooks/receiver");
          const matched = await dispatchHook(
            stored.event,
            stored.payload,
            `reprocess-${crypto.randomUUID()}`,
            {
              getJobs: () => opts.getSnapshot().jobs,
              ...(opts.onHookFire ? { onHookFire: opts.onHookFire } : {}),
              ...(opts.onHookSkip ? { onHookSkip: opts.onHookSkip } : {}),
            },
          );
          return json({ ok: true, matched });
        }
      }

      // --- Session title / close routes ---
      {
        const titleMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]+)\/title$/i);
        if (titleMatch && req.method === "PUT") {
          const body = await req.json().catch(() => ({}));
          await setSessionTitle(titleMatch[1], normalizeTitle(String(body.title ?? "")));
          return json({ ok: true });
        }
        const closeMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]+)\/(close|reopen)$/i);
        if (closeMatch && req.method === "POST") {
          await setSessionClosed(closeMatch[1], closeMatch[2].toLowerCase() === "close");
          return json({ ok: true });
        }
        // Per-session string fields: goal, model, effort. Each exposes a
        // matching GET/PUT pair. New fields are one-line additions below.
        const SESSION_FIELDS: Record<
          string,
          { get: (id: string) => Promise<string>; set: (id: string, v: string) => Promise<void> }
        > = {
          goal: { get: getSessionGoal, set: setSessionGoal },
          model: { get: getSessionModel, set: setSessionModel },
          effort: { get: getSessionEffort, set: setSessionEffort },
        };
        const fieldMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([a-z]+)$/i);
        const fieldName = (fieldMatch?.[2] ?? "").toLowerCase();
        const fieldImpl = fieldName ? SESSION_FIELDS[fieldName] : undefined;
        if (fieldMatch && fieldImpl) {
          const id = decodeURIComponent(fieldMatch[1] ?? "");
          if (req.method === "GET") {
            return json({ [fieldName]: await fieldImpl.get(id) });
          }
          if (req.method === "PUT") {
            return withJson(async () => {
              const body = await req.json().catch(() => ({}));
              await fieldImpl.set(id, String(body[fieldName] ?? ""));
              return { ok: true };
            }, 400);
          }
        }
      }

      // --- Home aggregator ---
      if (url.pathname === "/api/home" && req.method === "GET") {
        const snapshot = opts.getSnapshot();
        const jobs = await loadJobs();
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
      }

      if (url.pathname === "/api/inject" && req.method === "POST") {
        try {
          const body = await req.json();
          const message = typeof body.message === "string" ? body.message.trim() : "";
          if (!message) {
            return json({ ok: false, error: "message is required" }, 400);
          }
          const result = await runUserMessage("inject", message);
          const text = result.stdout.trim();
          const { telegram } = opts.getSnapshot().settings;
          if (text && telegram.token && telegram.allowedUserIds.length > 0) {
            const chatId = telegram.allowedUserIds[0];
            fetch(`https://api.telegram.org/bot${telegram.token}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text }),
            }).catch(() => {});
          }
          return json({ ok: true, result: result.stdout, exitCode: result.exitCode });
        } catch (err) {
          return json({ ok: false, error: String(err) }, 500);
        }
      }

      if (url.pathname === "/api/chat/reset" && req.method === "POST") {
        try {
          await resetSession("chat");
          return json({ ok: true });
        } catch (err) {
          return json({ ok: false, error: String(err) }, 500);
        }
      }

      if (url.pathname === "/api/chat" && req.method === "POST") {
        if (!opts.onChat) {
          return json({ ok: false, error: "chat not configured" }, 503);
        }
        try {
          const body = await req.json();
          const message = String(body?.message ?? "").trim();

          interface Attachment {
            name: string;
            type: string;
            data: string; // base64
          }

          const rawAttachments = Array.isArray(body?.attachments)
            ? (body.attachments as unknown[])
            : [];

          // Validate attachments
          if (rawAttachments.length > 5) {
            return json({ ok: false, error: "too many attachments (max 5)" }, 400);
          }

          const attachments: Attachment[] = [];
          for (const raw of rawAttachments) {
            if (!raw || typeof raw !== "object") {
              continue;
            }
            const att = raw as Record<string, unknown>;
            const name = String(att.name ?? "");
            const type = String(att.type ?? "");
            const data = String(att.data ?? "");
            // base64 decoded size approximation
            const decodedSize = data.length * 0.75;
            if (decodedSize > 10 * 1024 * 1024) {
              return json({ ok: false, error: `attachment "${name}" exceeds 10 MB limit` }, 400);
            }
            attachments.push({ name, type, data });
          }

          if (!message && attachments.length === 0) {
            return json({ ok: false, error: "message required" }, 400);
          }

          const TEXT_EXTENSIONS = new Set([
            "js",
            "ts",
            "py",
            "json",
            "yaml",
            "yml",
            "md",
            "txt",
            "csv",
            "xml",
            "sh",
            "sql",
            "toml",
            "ini",
            "env",
            "log",
          ]);

          const tempImagePaths: string[] = [];
          const attachmentBlocks: string[] = [];

          for (const att of attachments) {
            const ext = att.name.includes(".") ? att.name.split(".").pop()?.toLowerCase() : "";
            if (att.type.startsWith("text/") || TEXT_EXTENSIONS.has(ext)) {
              const content = Buffer.from(att.data, "base64").toString("utf-8");
              attachmentBlocks.push(
                `[Attached file: ${att.name}]\n\`\`\`${ext}\n${content}\n\`\`\``,
              );
            } else if (att.type.startsWith("image/")) {
              const uploadDir = `${tmpdir()}/clawdcode-uploads`;
              await import("node:fs/promises")
                .then(({ mkdir }) => mkdir(uploadDir, { recursive: true }))
                .catch(() => {});
              const filePath = `${uploadDir}/${randomUUID()}.${ext || "bin"}`;
              const buffer = Buffer.from(att.data, "base64");
              await Bun.write(filePath, buffer);
              tempImagePaths.push(filePath);
              attachmentBlocks.push(
                `[Attached image: ${att.name} — file saved at ${filePath}, you can read it with your Read tool]`,
              );
            } else {
              attachmentBlocks.push(
                `[Attached file: ${att.name} — unsupported type, content not included]`,
              );
            }
          }

          // Prepend session goal if present; also fetch model/effort overrides
          const chatSessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
          let baseMessage =
            attachmentBlocks.length > 0
              ? attachmentBlocks.join("\n\n") + (message ? `\n\n${message}` : "")
              : message;
          let chatModelOverride = "";
          let chatEffortOverride = "";
          if (chatSessionId) {
            const [sessionGoal, sessionModel, sessionEffort] = await Promise.all([
              getSessionGoal(chatSessionId),
              getSessionModel(chatSessionId),
              getSessionEffort(chatSessionId),
            ]);
            if (sessionGoal) {
              baseMessage = `Goal: ${sessionGoal}\n\n${baseMessage}`;
            }
            chatModelOverride = sessionModel;
            chatEffortOverride = sessionEffort;
          }
          const enrichedMessage = baseMessage;

          const encoder = new TextEncoder();
          const onChat = opts.onChat;
          const stream = new ReadableStream({
            async start(controller) {
              const send = (data: object) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
              };
              try {
                await onChat(
                  enrichedMessage,
                  (chunk) => send({ type: "chunk", text: chunk }),
                  () => send({ type: "unblock" }),
                  (ev) =>
                    send({
                      type: ev.type === "spawn" ? "agent_spawn" : "agent_done",
                      id: ev.id,
                      description: ev.description,
                      result: ev.result,
                    }),
                  {
                    modelOverride: chatModelOverride || undefined,
                    effortOverride: chatEffortOverride || undefined,
                  },
                );
                send({ type: "done" });
              } catch (err) {
                send({ type: "error", message: String(err) });
              } finally {
                controller.close();
                // Fire-and-forget cleanup of temp image files
                for (const p of tempImagePaths) {
                  Bun.file(p)
                    .exists()
                    .then((exists) => {
                      if (exists) {
                        import("node:fs").then(({ unlink }) => unlink(p, () => {})).catch(() => {});
                      }
                    })
                    .catch(() => {});
                }
              }
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            },
          });
        } catch (err) {
          return json({ ok: false, error: String(err) }, 500);
        }
      }

      // --- Slash autocomplete registry ---
      if (url.pathname === "/api/slash" && req.method === "GET") {
        try {
          const { listAllSlashEntries } = await import("../slashRegistry");
          return json(await listAllSlashEntries());
        } catch (err) {
          return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 500);
        }
      }

      // --- MCP server management routes ---
      if (url.pathname === "/api/mcp" && req.method === "GET") {
        try {
          const [userServers, projectServers] = await Promise.all([
            listMcpServers("user"),
            listMcpServers("project"),
          ]);
          return json({ user: userServers, project: projectServers });
        } catch (err) {
          return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 500);
        }
      }

      if (url.pathname === "/api/mcp" && req.method === "POST") {
        try {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const name = String(body.name ?? "").trim();
          const scope = (body.scope === "project" ? "project" : "user") as "user" | "project";
          const transport = (
            ["http", "sse"].includes(String(body.transport)) ? body.transport : "stdio"
          ) as "stdio" | "http" | "sse";
          const target = String(body.target ?? "").trim();
          const rawHeaders = Array.isArray(body.headers) ? body.headers.map(String) : [];

          if (!name) {
            return json({ error: "name is required" }, 400);
          }
          if (!target) {
            return json({ error: "target is required" }, 400);
          }

          await addMcpServer({ name, scope, transport, target, headers: rawHeaders });
          return json({ ok: true });
        } catch (err) {
          return json({ error: String(err instanceof Error ? err.message : err) }, 400);
        }
      }

      if (url.pathname === "/api/mcp" && req.method === "DELETE") {
        try {
          const name = url.searchParams.get("name") ?? "";
          const scope = (url.searchParams.get("scope") === "project" ? "project" : "user") as
            | "user"
            | "project";
          if (!name) {
            return json({ error: "name is required" }, 400);
          }
          await removeMcpServer(name, scope);
          return json({ ok: true });
        } catch (err) {
          return json({ error: String(err instanceof Error ? err.message : err) }, 400);
        }
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return {
    stop: () => server.stop(),
    host: opts.host,
    port: server.port,
  };
}
