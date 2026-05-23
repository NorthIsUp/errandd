import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@pikoloo/darwin-ui";
import type { RepoStatus } from "../../api/repos";
import styles from "./HomeCards.module.css";
import { fmtRelative } from "./utils";

interface Props {
  repos: RepoStatus[];
  onOpenJobs: () => void;
}

function RepoRow({ repo }: { repo: RepoStatus }) {
  const label = repo.slug || repo.url || "repo";
  const pluginCount = Array.isArray(repo.plugins) ? repo.plugins.length : 0;
  const pluginLabel = pluginCount > 0 ? ` 🧩${pluginCount}` : "";

  if (!repo.configured) {
    return (
      <div className={styles.row}>
        <span className={styles.label}>
          {label}
          {pluginLabel}
        </span>
        <Badge variant="warning">not configured</Badge>
      </div>
    );
  }

  if (!repo.cloned) {
    return (
      <div className={styles.row}>
        <span className={styles.label}>
          {label}
          {pluginLabel}
        </span>
        <Badge variant="warning">not cloned</Badge>
      </div>
    );
  }

  const parts: string[] = [repo.dirty ? "● dirty" : "✓ clean"];
  if (repo.lastPullAt) parts.push(`pulled ${fmtRelative(repo.lastPullAt)}`);

  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>
          {label}
          {pluginLabel}
        </span>
        <Badge variant={repo.dirty ? "warning" : "success"}>
          {parts.join(" · ")}
        </Badge>
      </div>
      {repo.lastError != null && (
        <div className={styles.row}>
          <span className={styles.label}>Error</span>
          <span
            className={[styles.value, styles.bad].filter(Boolean).join(" ")}
          >
            {repo.lastError}
          </span>
        </div>
      )}
    </>
  );
}

export function GitSyncCard({ repos, onOpenJobs }: Props) {
  return (
    <Card glass>
      <CardHeader>
        <CardTitle>Git Sync</CardTitle>
      </CardHeader>
      <CardContent>
        {repos.length === 0 ? (
          <p style={{ color: "var(--muted)", fontSize: "13px" }}>
            No git repo configured.
          </p>
        ) : (
          repos.map((repo) => (
            <RepoRow key={repo.slug || repo.url} repo={repo} />
          ))
        )}
        <button type="button" className={styles.linkBtn} onClick={onOpenJobs}>
          Open Jobs →
        </button>
      </CardContent>
    </Card>
  );
}
