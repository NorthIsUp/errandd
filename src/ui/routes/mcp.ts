import { addMcpServer, listMcpServers, removeMcpServer } from "../../mcp";
import { json } from "../http";
import type { RouteHandler } from "./types";

/** GET /api/mcp — user + project MCP servers. */
export const mcpList: RouteHandler = async () => {
  try {
    const [userServers, projectServers] = await Promise.all([
      listMcpServers("user"),
      listMcpServers("project"),
    ]);
    return json({ user: userServers, project: projectServers });
  } catch (err) {
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 500);
  }
};

/** POST /api/mcp — add an MCP server. */
export const mcpAdd: RouteHandler = async ({ req }) => {
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
};

/** DELETE /api/mcp?name=&scope= — remove an MCP server. */
export const mcpDelete: RouteHandler = async ({ url }) => {
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
};
