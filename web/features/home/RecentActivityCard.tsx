import { Card, CardContent, CardHeader, CardTitle } from "@pikoloo/darwin-ui";
import type { LogRun } from "../../api/home";
import styles from "./HomeCards.module.css";
import { formatSessionTime } from "./utils";

interface Props {
  runs: LogRun[];
}

/** Derive a friendly run name from the log filename. */
function runName(file: string): string {
  return (
    file
      .replace(/\.log$/, "")
      .replace(/-\d{4}-\d{2}-\d{2}T[\dZ:\-.]+$/, "")
      .replace(/-\d{4}-\d{2}-\d{2}$/, "") || "run"
  );
}

/** Find the last meaningful line from the log lines. */
function lastSnippet(lines: string[]): string {
  const SKIP = ["#", "Date:", "Session:", "Model", "Prompt:", "Exit code:"];
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = (lines[i] ?? "").trim();
    if (!ln) continue;
    if (SKIP.some((prefix) => ln.startsWith(prefix))) continue;
    return ln.length > 60 ? `${ln.slice(0, 57)}…` : ln;
  }
  return "";
}

export function RecentActivityCard({ runs }: Props) {
  const displayed = runs.slice(0, 8);

  return (
    <Card glass>
      <CardHeader>
        <CardTitle>Recent Activity</CardTitle>
      </CardHeader>
      <CardContent>
        {displayed.length === 0 ? (
          <p style={{ color: "var(--muted)", fontSize: "13px" }}>
            No recent activity.
          </p>
        ) : (
          displayed.map((run) => {
            const name = runName(run.file);
            const timeStr = run.mtime
              ? formatSessionTime(new Date(run.mtime).toISOString())
              : "";
            const snippet = lastSnippet(
              Array.isArray(run.lines) ? run.lines : [],
            );
            return (
              <div key={run.file} className={styles.listItem}>
                <span className={styles.listName}>{name}</span>
                {timeStr && <span className={styles.listMeta}>{timeStr}</span>}
                {snippet && <span className={styles.listSub}>{snippet}</span>}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
