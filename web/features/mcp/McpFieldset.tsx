import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CircularProgress,
} from "@pikoloo/darwin-ui";
import { useCallback, useEffect, useState } from "react";
import type { McpListResponse } from "../../api/mcp";
import { listMcpServers } from "../../api/mcp";
import { McpAddForm } from "./McpAddForm";
import styles from "./McpFieldset.module.css";
import { McpRow } from "./McpRow";

export function McpFieldset() {
  const [data, setData] = useState<McpListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [status, setStatus] = useState<{
    msg: string;
    kind: "ok" | "err";
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await listMcpServers();
      setData(result);
    } catch (err) {
      setStatus({
        msg: `Failed to load MCP servers: ${err instanceof Error ? err.message : String(err)}`,
        kind: "err",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function handleRemoved() {
    void load();
  }

  function handleAdded(name: string) {
    setStatus({ msg: `Added ${name}.`, kind: "ok" });
    setShowAdd(false);
    void load();
  }

  function handleError(msg: string) {
    setStatus({ msg, kind: "err" });
  }

  function handleClearError() {
    setStatus(null);
  }

  const userServers = data?.user ?? [];
  const projectServers = data?.project ?? [];
  const hasAny = userServers.length > 0 || projectServers.length > 0;

  return (
    <Card glass>
      <CardHeader>
        <CardTitle>MCP Servers</CardTitle>
      </CardHeader>
      <CardContent>
        {status !== null && (
          <p
            className={
              status.kind === "err" ? styles.statusErr : styles.statusOk
            }
          >
            {status.msg}
          </p>
        )}

        {loading ? (
          <CircularProgress indeterminate size={14} strokeWidth={2} />
        ) : !hasAny ? (
          <p style={{ color: "var(--muted)", fontSize: "13px" }}>
            No MCP servers configured.
          </p>
        ) : (
          <div className={styles.list}>
            {userServers.length > 0 ? (
              <>
                <p className={styles.scopeLabel}>user</p>
                {userServers.map((s) => (
                  <McpRow
                    key={`user-${s.name}`}
                    server={s}
                    onRemoved={handleRemoved}
                    onError={handleError}
                  />
                ))}
              </>
            ) : null}
            {projectServers.length > 0 ? (
              <>
                <p className={styles.scopeLabel}>project</p>
                {projectServers.map((s) => (
                  <McpRow
                    key={`project-${s.name}`}
                    server={s}
                    onRemoved={handleRemoved}
                    onError={handleError}
                  />
                ))}
              </>
            ) : null}
          </div>
        )}

        {showAdd ? (
          <McpAddForm
            onAdded={handleAdded}
            onCancel={() => {
              setShowAdd(false);
            }}
            onError={handleError}
            onClearError={handleClearError}
          />
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setStatus(null);
              setShowAdd(true);
            }}
          >
            + Add
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
