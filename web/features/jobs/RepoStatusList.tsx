import { useCallback, useEffect, useState } from "react";
import type { RepoStatus } from "../../api/repos";
import { listRepos, syncRepo } from "../../api/repos";
import { Button } from "../../components/Button";
import { Pill } from "../../components/Pill";
import { Spinner } from "../../components/Spinner";
import styles from "./RepoStatusList.module.css";

interface Props {
  onStatus: (msg: string) => void;
}

function fmtRelative(isoStr: string | null): string {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function RepoStatusList({ onStatus }: Props) {
  const [repos, setRepos] = useState<RepoStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await listRepos();
      setRepos(Array.isArray(data) ? data : []);
    } catch {
      setRepos([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const handleSync = useCallback(
    async (slug: string) => {
      setSyncing(slug);
      onStatus(`Syncing ${slug}…`);
      try {
        const res = await syncRepo(slug);
        onStatus(
          res.committed
            ? `${slug}: committed & pushed`
            : `${slug}: nothing to commit`,
        );
      } catch (e) {
        onStatus(`Sync error: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSyncing(null);
        void load();
      }
    },
    [load, onStatus],
  );

  if (loading) return null;
  if (repos.length === 0) return null;

  return (
    <div className={styles.container}>
      {repos.map((repo) => {
        const label = repo.slug || repo.url || "repo";
        const hasPlugins =
          Array.isArray(repo.plugins) && repo.plugins.length > 0;
        const statusParts: string[] = [];
        if (!repo.configured) {
          statusParts.push("not configured");
        } else if (!repo.cloned) {
          statusParts.push("not cloned");
        } else {
          statusParts.push(`Branch: ${repo.branch || "main"}`);
          statusParts.push(repo.dirty ? "● dirty" : "✓ clean");
          if (repo.ahead) statusParts.push(`${repo.ahead}↑`);
          if (repo.behind) statusParts.push(`${repo.behind}↓`);
          if (repo.lastPullAt)
            statusParts.push(`pulled ${fmtRelative(repo.lastPullAt)}`);
          if (hasPlugins) statusParts.push(`plugins: ${repo.plugins.length}`);
        }

        const tone =
          !repo.configured || !repo.cloned
            ? "warn"
            : repo.dirty
              ? "warn"
              : "good";

        return (
          <div key={repo.slug} className={styles.row}>
            <div className={styles.name}>
              {hasPlugins && (
                <span
                  className={styles.pluginIcon}
                  title={`provides ${repo.plugins.length} plugin(s)`}
                >
                  🧩
                </span>
              )}
              {label}
            </div>
            <div className={styles.bottom}>
              <Pill tone={tone} size="sm">
                {statusParts.join(" · ")}
              </Pill>
              {repo.configured && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={syncing === repo.slug}
                  onClick={() => void handleSync(repo.slug)}
                >
                  {syncing === repo.slug ? (
                    <>
                      <Spinner size="sm" />
                      Syncing…
                    </>
                  ) : (
                    "Sync to Git"
                  )}
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
