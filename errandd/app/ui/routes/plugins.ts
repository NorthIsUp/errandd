import { json } from "../http";
import type { RouteHandler } from "./types";

// --- Claude plugin manager routes ---
// These wrap the `claude plugin` CLI so the Settings UI can do full
// marketplace + plugin lifecycle management without the user dropping
// to the terminal.

/** GET /api/claude-plugins — installed plugins. */
export const pluginsList: RouteHandler = async () => {
  const m = await import("../services/claudePlugins");
  return json(await m.listPlugins());
};

/** GET /api/claude-plugins/marketplaces — configured marketplaces. */
export const marketplacesList: RouteHandler = async () => {
  const m = await import("../services/claudePlugins");
  return json(await m.listMarketplaces());
};

/** POST /api/claude-plugins/marketplaces — add a marketplace by ref. */
export const marketplacesAdd: RouteHandler = async ({ req }) => {
  const body = (await req.json().catch(() => ({}))) as { ref?: unknown };
  const ref = typeof body.ref === "string" ? body.ref.trim() : "";
  if (!ref) {
    return json({ ok: false, error: "ref required" }, 400);
  }
  const m = await import("../services/claudePlugins");
  return json(await m.addMarketplace(ref));
};

/** POST /api/claude-plugins/marketplaces/update-all — update all marketplaces. */
export const marketplacesUpdateAll: RouteHandler = async () => {
  const m = await import("../services/claudePlugins");
  return json(await m.updateMarketplace());
};

/** DELETE/POST /api/claude-plugins/marketplaces/:name(/update). Null on no match. */
export const marketplaceAction: RouteHandler = async ({ req, url }) => {
  const mpMatch = /^\/api\/claude-plugins\/marketplaces\/([^/]+)(\/update)?$/.exec(url.pathname);
  if (mpMatch) {
    const name = decodeURIComponent(mpMatch[1] ?? "");
    const isUpdate = !!mpMatch[2];
    const m = await import("../services/claudePlugins");
    if (req.method === "DELETE" && !isUpdate) {
      return json(await m.removeMarketplace(name));
    }
    if (req.method === "POST" && isUpdate) {
      return json(await m.updateMarketplace(name));
    }
  }
  return null;
};

/** POST /api/claude-plugins/install — install a plugin by id. */
export const pluginInstall: RouteHandler = async ({ req }) => {
  const body = (await req.json().catch(() => ({}))) as { id?: unknown };
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    return json({ ok: false, error: "id required" }, 400);
  }
  const m = await import("../services/claudePlugins");
  return json(await m.installPlugin(id));
};

/** POST /api/claude-plugins/update-all — update all plugins. */
export const pluginsUpdateAll: RouteHandler = async () => {
  const m = await import("../services/claudePlugins");
  return json(await m.updateAllPlugins());
};

/** DELETE/POST /api/claude-plugins/:id(/update|/enable|/disable). Null on no match. */
export const pluginAction: RouteHandler = async ({ req, url }) => {
  const pluginMatch = /^\/api\/claude-plugins\/([^/]+)(\/update|\/enable|\/disable)?$/.exec(url.pathname);
  if (
    pluginMatch &&
    pluginMatch[1] !== "marketplaces" &&
    pluginMatch[1] !== "install" &&
    pluginMatch[1] !== "update-all"
  ) {
    const id = decodeURIComponent(pluginMatch[1] ?? "");
    const action = pluginMatch[2];
    const m = await import("../services/claudePlugins");
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
  return null;
};
