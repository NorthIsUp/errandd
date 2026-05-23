import { Badge, Button } from "@pikoloo/darwin-ui";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import type { McpServer } from "../../api/mcp";
import { removeMcpServer } from "../../api/mcp";
import styles from "./McpRow.module.css";

interface Props {
  server: McpServer;
  onRemoved: () => void;
  onError: (msg: string) => void;
}

function transportVariant(
  transport: McpServer["transport"],
): "info" | "warning" | "secondary" {
  if (transport === "stdio") return "info";
  if (transport === "http") return "warning";
  return "secondary";
}

export function McpRow({ server, onRemoved, onError }: Props) {
  const [removing, setRemoving] = useState(false);

  const targetShort =
    server.target.length > 60
      ? `${server.target.slice(0, 58)}…`
      : server.target;

  async function handleRemove() {
    if (!confirm(`Remove MCP server "${server.name}" (${server.scope} scope)?`))
      return;
    setRemoving(true);
    try {
      await removeMcpServer(server.name, server.scope);
      onRemoved();
    } catch (err) {
      onError(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className={styles.row}>
      <span className={styles.name}>{server.name}</span>
      <Badge variant={transportVariant(server.transport)}>
        {server.transport}
      </Badge>
      <span className={styles.target} title={server.target}>
        {targetShort}
      </span>
      <Button
        variant="destructive"
        size="icon"
        className={styles.removeBtn ?? ""}
        onClick={() => {
          void handleRemove();
        }}
        disabled={removing}
        aria-label={`Remove ${server.name}`}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}
