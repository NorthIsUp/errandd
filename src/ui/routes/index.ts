import * as chat from "./chat";
import * as hooks from "./hooks";
import * as jobs from "./jobs";
import * as mcp from "./mcp";
import * as plugins from "./plugins";
import * as prs from "./prs";
import * as runtime from "./runtime";
import * as sessions from "./sessions";
import * as settings from "./settings";
import type { Route, RouteCtx } from "./types";
import * as v3 from "./v3";

/**
 * The route table. Entries are tried by the dispatcher in array order; the
 * sequence mirrors the original `fetch()` if-ladder exactly so fall-through
 * precedence (e.g. a self-matching DELETE on `/api/jobs/*` winning over the
 * exact `/api/jobs` row, or the v3 thread regexes resolving before the
 * generic `/api/sessions/*` ones) is preserved.
 *
 * `method: "*"` means the original branch checked only the pathname (any
 * verb matched) — kept verbatim so a non-GET to e.g. `/api/state` behaves
 * as before.
 */
export const ROUTES: readonly Route[] = [
  { method: "*", path: "/api/state", handler: runtime.getState },
  { method: "GET", path: "/api/runtime/update-check", handler: runtime.updateCheck },
  { method: "POST", path: "/api/runtime/update", handler: runtime.applyUpdateRoute },
  { method: "GET", path: "/api/jobs/events", handler: jobs.jobsEvents },
  { method: "GET", path: "/api/settings", handler: settings.settingsGet },
  { method: "PUT", path: "/api/settings", handler: settings.settingsPut },
  { method: "POST", path: "/api/settings/heartbeat", handler: settings.heartbeatPost },
  { method: "GET", path: "/api/settings/heartbeat", handler: settings.heartbeatGet },
  { method: "*", path: "/api/technical-info", handler: settings.technicalInfo },
  { method: "POST", path: "/api/jobs/quick", handler: jobs.jobsQuick },
  // self: DELETE /api/jobs/<name> (excludes /api/jobs/file). Must precede the
  // exact /api/jobs and the file routes — original ordering.
  {
    match: "self",
    handler: jobs.jobsDelete,
    owns: (u) => u.pathname.startsWith("/api/jobs/") && u.pathname !== "/api/jobs/file",
    methods: ["DELETE"],
  },
  { method: "*", path: "/api/jobs", handler: jobs.jobsList },
  { method: "GET", path: "/api/jobs/files", handler: jobs.jobsFilesList },
  { method: "GET", path: "/api/jobs/file", handler: jobs.jobsFileGet },
  { method: "PUT", path: "/api/jobs/file", handler: jobs.jobsFilePut },
  { method: "POST", path: "/api/jobs/file", handler: jobs.jobsFilePost },
  { method: "DELETE", path: "/api/jobs/file", handler: jobs.jobsFileDelete },
  { method: "POST", path: "/api/jobs/file/auto-name", handler: jobs.jobsFileAutoName },
  { method: "GET", path: "/api/jobs/repos", handler: jobs.jobsReposList },
  {
    match: "self",
    handler: jobs.jobsReposAction,
    owns: (u) => /^\/api\/jobs\/repos\/([^/]+)\/(pull|sync)$/.test(u.pathname),
    methods: ["POST"],
  },
  { method: "GET", path: "/api/claude-plugins", handler: plugins.pluginsList },
  { method: "GET", path: "/api/claude-plugins/marketplaces", handler: plugins.marketplacesList },
  { method: "POST", path: "/api/claude-plugins/marketplaces", handler: plugins.marketplacesAdd },
  {
    method: "POST",
    path: "/api/claude-plugins/marketplaces/update-all",
    handler: plugins.marketplacesUpdateAll,
  },
  {
    match: "self",
    handler: plugins.marketplaceAction,
    owns: (u) => /^\/api\/claude-plugins\/marketplaces\/([^/]+)(\/update)?$/.test(u.pathname),
    methods: ["DELETE", "POST"],
  },
  { method: "POST", path: "/api/claude-plugins/install", handler: plugins.pluginInstall },
  { method: "POST", path: "/api/claude-plugins/update-all", handler: plugins.pluginsUpdateAll },
  {
    match: "self",
    handler: plugins.pluginAction,
    owns: (u) => {
      const m = /^\/api\/claude-plugins\/([^/]+)(\/update|\/enable|\/disable)?$/.exec(u.pathname);
      return !!m && m[1] !== "marketplaces" && m[1] !== "install" && m[1] !== "update-all";
    },
    methods: ["DELETE", "POST"],
  },
  { method: "GET", path: "/api/jobs/repo/status", handler: jobs.jobsRepoStatus },
  { method: "POST", path: "/api/jobs/repo/sync", handler: jobs.jobsRepoSync },
  { method: "POST", path: "/api/jobs/repo/pull", handler: jobs.jobsRepoPull },
  { method: "*", path: "/api/logs", handler: runtime.getLogs },
  { method: "GET", path: "/api/sessions", handler: sessions.sessionsList },
  { method: "GET", path: "/api/hooks/deliveries", handler: hooks.deliveriesList },
  {
    match: "self",
    handler: hooks.deliveryPayload,
    owns: (u) => /^\/api\/hooks\/deliveries\/([^/]+)\/payload$/.test(u.pathname),
    methods: ["GET"],
  },
  { method: "GET", path: "/api/hooks/events", handler: hooks.hooksEvents },
  { method: "GET", path: "/api/hooks/queue", handler: hooks.queueList },
  { method: "POST", path: "/api/hooks/queue/retrigger", handler: hooks.queueRetrigger },
  { method: "GET", path: "/api/hooks/queue/events", handler: hooks.queueEvents },
  {
    match: "self",
    handler: v3.threadMessages,
    owns: (u) => /^\/api\/v3\/threads\/([^/]+)\/messages$/.test(u.pathname),
    methods: ["GET"],
  },
  {
    match: "self",
    handler: v3.threadStream,
    owns: (u) => /^\/api\/v3\/threads\/([^/]+)\/stream$/.test(u.pathname),
    methods: ["GET"],
  },
  {
    match: "self",
    handler: v3.threadMessage,
    owns: (u) => /^\/api\/v3\/threads\/([^/]+)\/message$/.test(u.pathname),
    methods: ["POST"],
  },
  { method: "GET", path: "/api/hooks/triggers", handler: hooks.triggers },
  { method: "GET", path: "/api/hooks/receiver", handler: hooks.receiver },
  { method: "GET", path: "/api/prs/open", handler: prs.openPRsList },
  { method: "GET", path: "/api/usage", handler: settings.usage },
  { method: "GET", path: "/api/usage-timeline", handler: settings.usageTimeline },
  { method: "GET", path: "/api/schedule-density", handler: jobs.scheduleDensity },
  { method: "GET", path: "/api/agents", handler: sessions.agents },
  {
    match: "self",
    handler: sessions.sessionMessages,
    owns: (u) => u.pathname.startsWith("/api/sessions/") && u.pathname.endsWith("/messages"),
    methods: ["GET"],
  },
  {
    match: "self",
    handler: sessions.sessionHookPayloadOrReprocess,
    owns: (u) =>
      /^\/api\/sessions\/([0-9a-f-]+)\/hook-payload$/i.test(u.pathname) ||
      /^\/api\/sessions\/([0-9a-f-]+)\/reprocess$/i.test(u.pathname),
    methods: ["GET", "POST"],
  },
  {
    match: "self",
    handler: sessions.sessionMeta,
    owns: (u) =>
      /^\/api\/sessions\/([0-9a-f-]+)\/title$/i.test(u.pathname) ||
      /^\/api\/sessions\/([0-9a-f-]+)\/(close|reopen)$/i.test(u.pathname) ||
      /^\/api\/sessions\/([^/]+)\/([a-z]+)$/i.test(u.pathname),
    methods: ["GET", "PUT", "POST"],
  },
  { method: "GET", path: "/api/home", handler: runtime.getHome },
  { method: "POST", path: "/api/inject", handler: chat.inject },
  { method: "POST", path: "/api/chat/reset", handler: chat.chatReset },
  { method: "POST", path: "/api/chat", handler: chat.chat },
  { method: "GET", path: "/api/slash", handler: chat.slash },
  { method: "GET", path: "/api/mcp", handler: mcp.mcpList },
  { method: "POST", path: "/api/mcp", handler: mcp.mcpAdd },
  { method: "DELETE", path: "/api/mcp", handler: mcp.mcpDelete },
];

/**
 * Walk the route table in order and return the first handler's Response.
 *
 *  - Exact rows match on `pathname` + `method` (`"*"` = any verb). They
 *    always produce a Response when matched.
 *  - Self rows call their handler unconditionally and accept a non-null
 *    Response; a `null` means "not mine" and we continue.
 *
 * If nothing handled the request we return the original `404 "Not found"`.
 * The pre-refactor if-ladder had no 405 branch — every unmatched request
 * (unknown path OR known path with the wrong method) fell through to the
 * single trailing 404. We reproduce that exactly to stay behavior-identical;
 * the `owns`/`methods` metadata on self rows is retained for documentation
 * but is not used to synthesize a 405.
 */
export async function dispatch(ctx: RouteCtx): Promise<Response> {
  const { req, url } = ctx;
  for (const route of ROUTES) {
    if ("match" in route) {
      const res = await route.handler(ctx);
      if (res) {
        return res;
      }
      continue;
    }
    if (url.pathname === route.path && (route.method === "*" || route.method === req.method)) {
      const res = await route.handler(ctx);
      if (res) {
        return res;
      }
    }
  }

  // Nothing matched — same trailing fallthrough as the original if-ladder.
  return new Response("Not found", { status: 404 });
}

export type { Route, RouteCtx, RouteHandler } from "./types";
