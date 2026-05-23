import { apiJSON } from "./client";

// ---------------------------------------------------------------------------
// Types — mirrors src/mcp.ts McpServer
// ---------------------------------------------------------------------------

export interface McpServer {
  name: string;
  scope: "user" | "project" | "local";
  transport: "stdio" | "http" | "sse";
  /** For stdio: the command + args string. For http/sse: the URL. */
  target: string;
  /** Optional raw "Name: Value" header strings (http/sse only). */
  headers?: string[];
}

export interface McpListResponse {
  user: McpServer[];
  project: McpServer[];
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

export function listMcpServers(): Promise<McpListResponse> {
  return apiJSON<McpListResponse>("/api/mcp");
}

export function addMcpServer(
  server: Omit<McpServer, "scope"> & { scope?: McpServer["scope"] },
): Promise<{ ok: true }> {
  return apiJSON<{ ok: true }>("/api/mcp", {
    method: "POST",
    body: JSON.stringify(server),
  });
}

export function removeMcpServer(
  name: string,
  scope?: McpServer["scope"],
): Promise<{ ok: true }> {
  const qs = new URLSearchParams({ name });
  if (scope) qs.set("scope", scope);
  return apiJSON<{ ok: true }>(`/api/mcp?${qs.toString()}`, {
    method: "DELETE",
  });
}
