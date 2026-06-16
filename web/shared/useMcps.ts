import { useCallback, useEffect, useState } from "react";
import {
  addMcpServer,
  listMcpServers,
  removeMcpServer,
  type McpListResponse,
  type McpServer,
} from "../api/mcp";

export interface McpDraft {
  name: string;
  transport: McpServer["transport"];
  target: string;
}

export interface UseMcpsResult {
  list: McpListResponse | null;
  all: (McpServer & { scope: McpServer["scope"] })[];
  loading: boolean;
  adding: boolean;
  draft: McpDraft;
  setDraft: (d: McpDraft) => void;
  reload: () => Promise<void>;
  add: () => Promise<{ ok: true } | { error: Error } | null>;
  remove: (
    name: string,
    scope: McpServer["scope"],
  ) => Promise<{ ok: true } | { error: Error }>;
}

const EMPTY_DRAFT: McpDraft = { name: "", transport: "stdio", target: "" };

/** Headless hook for the MCP servers settings panel. */
export function useMcps(): UseMcpsResult {
  const [list, setList] = useState<McpListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<McpDraft>(EMPTY_DRAFT);

  const reload = useCallback(async () => {
    try {
      setList(await listMcpServers());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = useCallback(async () => {
    if (!draft.name.trim() || !draft.target.trim()) return null;
    setAdding(true);
    try {
      await addMcpServer({
        name: draft.name.trim(),
        transport: draft.transport,
        target: draft.target.trim(),
        scope: "user",
      });
      setDraft(EMPTY_DRAFT);
      await reload();
      return { ok: true as const };
    } catch (err) {
      return {
        error: err instanceof Error ? err : new Error(String(err)),
      };
    } finally {
      setAdding(false);
    }
  }, [draft, reload]);

  const remove = useCallback(
    async (name: string, scope: McpServer["scope"]) => {
      try {
        await removeMcpServer(name, scope);
        await reload();
        return { ok: true as const };
      } catch (err) {
        return {
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
    [reload],
  );

  const all = list
    ? [
        ...list.user.map((s) => ({ ...s, scope: "user" as const })),
        ...list.project.map((s) => ({ ...s, scope: "project" as const })),
      ]
    : [];

  return { list, all, loading, adding, draft, setDraft, reload, add, remove };
}
