import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
} from "@pikoloo/darwin-ui";
import { Plus, Trash2 } from "lucide-react";
import { useId } from "react";
import type { RepoStatus } from "../../api/repos";
import type { JobsRepoConfig } from "../../api/state";
import { Field } from "../../components/Field";
import styles from "./JobsReposFieldset.module.css";

export interface RepoRow extends JobsRepoConfig {
  /** plugin count from the live repo status, if available */
  pluginCount?: number;
  /** stable identity key for React rendering */
  rowKey?: number;
}

let _rowKeySeq = 0;
function nextRowKey() {
  return ++_rowKeySeq;
}

interface Props {
  repos: RepoRow[];
  onChange: (repos: RepoRow[]) => void;
}

function RepoRowCard({
  repo,
  index,
  onRemove,
  onUpdate,
}: {
  repo: RepoRow;
  index: number;
  onRemove: () => void;
  onUpdate: (patch: Partial<RepoRow>) => void;
}) {
  const baseId = useId();
  const urlId = `${baseId}-url`;
  const branchId = `${baseId}-branch`;
  const intervalId = `${baseId}-interval`;

  return (
    <div className={styles.repoCard}>
      <div className={styles.repoCardHeader}>
        <span className={styles.repoLabel}>
          Repo {index + 1}
          {(repo.pluginCount ?? 0) > 0 && (
            <span
              className={styles.pluginBadge}
              title={`Provides ${repo.pluginCount ?? 0} plugin(s)`}
            >
              🧩
            </span>
          )}
        </span>
        <Button
          variant="destructive"
          size="icon"
          onClick={onRemove}
          aria-label={`Remove repo ${index + 1}`}
          className={styles.removeBtn ?? ""}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <Field label="Git URL" htmlFor={urlId}>
        <Input
          id={urlId}
          type="text"
          value={repo.url}
          onChange={(e) => {
            onUpdate({ url: e.target.value });
          }}
          placeholder="git@github.com:org/jobs.git"
        />
      </Field>

      <Field label="Branch" htmlFor={branchId}>
        <Input
          id={branchId}
          type="text"
          className="max-w-[160px]"
          value={repo.branch}
          onChange={(e) => {
            onUpdate({ branch: e.target.value });
          }}
          placeholder="main"
        />
      </Field>

      <Field label="Pull Interval (seconds)" htmlFor={intervalId}>
        <Input
          id={intervalId}
          type="number"
          className="max-w-[160px]"
          min={0}
          step={1}
          value={repo.intervalSeconds}
          onChange={(e) => {
            onUpdate({ intervalSeconds: Number(e.target.value) || 300 });
          }}
        />
      </Field>
    </div>
  );
}

export function JobsReposFieldset({ repos, onChange }: Props) {
  // Assign stable row keys to any incoming rows that don't have one yet
  const reposWithKeys: RepoRow[] = repos.map((r) =>
    r.rowKey !== undefined ? r : { ...r, rowKey: nextRowKey() },
  );

  function handleAdd() {
    onChange([
      ...repos,
      {
        url: "",
        branch: "main",
        intervalSeconds: 300,
        pluginCount: 0,
        rowKey: nextRowKey(),
      },
    ]);
  }

  function handleRemove(index: number) {
    onChange(repos.filter((_, i) => i !== index));
  }

  function handleUpdate(index: number, patch: Partial<RepoRow>) {
    onChange(repos.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  return (
    <Card glass>
      <CardHeader>
        <CardTitle>Jobs Plugin Repos</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={styles.list}>
          {reposWithKeys.map((repo, i) => (
            <RepoRowCard
              key={repo.rowKey}
              repo={repo}
              index={i}
              onRemove={() => {
                handleRemove(i);
              }}
              onUpdate={(patch) => {
                handleUpdate(i, patch);
              }}
            />
          ))}
        </div>
        <Button variant="primary" size="sm" onClick={handleAdd}>
          <Plus className="h-4 w-4" />
          Add Repo
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * Collect the repos array, dropping rows with empty URLs.
 */
export function collectJobsRepos(repos: RepoRow[]): JobsRepoConfig[] {
  return repos
    .filter((r) => r.url.trim().length > 0)
    .map((r) => ({
      url: r.url.trim(),
      branch: r.branch.trim() || "main",
      intervalSeconds: r.intervalSeconds || 300,
    }));
}

/**
 * Merge live repo status (plugin counts) into the form rows.
 */
export function mergeRepoStatus(
  configs: JobsRepoConfig[],
  statuses: RepoStatus[],
): RepoRow[] {
  return configs.map((c) => {
    const status = statuses.find((s) => s.url === c.url);
    return {
      ...c,
      pluginCount: status?.plugins.length ?? 0,
    };
  });
}
