import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@pikoloo/darwin-ui";
import type { StateResponse } from "../../api/state";
import styles from "./HomeCards.module.css";
import { cap, fmtDur } from "./utils";

interface Props {
  server: StateResponse;
}

export function ServerCard({ server }: Props) {
  const daemon = server.daemon;
  const isRunning = Boolean(daemon?.pid);
  const uptime = daemon?.uptimeMs != null ? fmtDur(daemon.uptimeMs) : "—";
  const model = server.model || "—";
  const secLevel = server.security?.level ?? "—";
  const isUnrestricted = secLevel === "unrestricted";

  return (
    <Card glass>
      <CardHeader>
        <CardTitle>Server</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={styles.row}>
          <span className={styles.label}>Status</span>
          <Badge variant={isRunning ? "success" : "destructive"}>
            {isRunning ? "Running" : "Offline"}
          </Badge>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>Uptime</span>
          <span className={styles.value}>{uptime}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>Model</span>
          <span className={styles.value}>{model}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>Security</span>
          <Badge variant={isUnrestricted ? "warning" : "success"}>
            {cap(secLevel)}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
