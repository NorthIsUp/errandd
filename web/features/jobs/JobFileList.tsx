import { Badge, CircularProgress } from "@pikoloo/darwin-ui";
import { useCallback, useEffect, useState } from "react";
import type { JobFileEntry } from "../../api/jobs";
import { listJobFiles } from "../../api/jobs";
import type { RepoStatus } from "../../api/repos";
import { listRepos } from "../../api/repos";
import styles from "./JobFileList.module.css";

export interface FileKey {
  path: string;
  repo: string | null; // null = first/default local dir
}

interface Props {
  activeFile: FileKey | null;
  onSelect: (key: FileKey) => void;
  /** Incremented externally to trigger a refresh. */
  refreshTick: number;
}

interface GroupEntry {
  label: string;
  slug: string | null; // null = local / no-repo
  files: JobFileEntry[];
  plugins: number;
}

export function JobFileList({ activeFile, onSelect, refreshTick }: Props) {
  const [groups, setGroups] = useState<GroupEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      let repos: RepoStatus[] = [];
      try {
        repos = await listRepos();
        if (!Array.isArray(repos)) repos = [];
      } catch {
        repos = [];
      }

      if (repos.length === 0) {
        // No repos — flat list from default local dir
        const files = await listJobFiles();
        setGroups([
          {
            label: "Local",
            slug: null,
            files: Array.isArray(files) ? files : [],
            plugins: 0,
          },
        ]);
      } else {
        // Grouped by repo + local
        const result: GroupEntry[] = [];
        for (const repo of repos) {
          let files: JobFileEntry[] = [];
          try {
            files = await listJobFiles(repo.slug);
            if (!Array.isArray(files)) files = [];
          } catch {
            files = [];
          }
          result.push({
            label: repo.slug || repo.url || "repo",
            slug: repo.slug,
            files,
            plugins: Array.isArray(repo.plugins) ? repo.plugins.length : 0,
          });
        }
        // Local files
        let localFiles: JobFileEntry[] = [];
        try {
          localFiles = await listJobFiles("__local__");
          if (!Array.isArray(localFiles)) localFiles = [];
        } catch {
          localFiles = [];
        }
        result.push({
          label: "Local",
          slug: "__local__",
          files: localFiles,
          plugins: 0,
        });
        setGroups(result);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load files.");
    } finally {
      setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshTick is the intentional refresh trigger
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refreshTick]);

  const totalFiles = groups.reduce((n, g) => n + g.files.length, 0);
  const showGroupHeaders = groups.length > 1;

  return (
    <div className={styles.list}>
      {loading ? (
        <div className={styles.loading}>
          <CircularProgress indeterminate size={14} strokeWidth={2} />
        </div>
      ) : error ? (
        <div className={styles.empty}>{error}</div>
      ) : totalFiles === 0 && groups.every((g) => g.files.length === 0) ? (
        <div className={styles.empty}>
          No job files yet. Click + New to create one.
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.slug ?? "local"}>
            {showGroupHeaders && (
              <div className={styles.groupHeader}>
                {group.plugins > 0 && (
                  <span
                    className={styles.pluginIcon}
                    title={`provides ${group.plugins} plugin(s)`}
                  >
                    🧩
                  </span>
                )}
                <p className={styles.groupLabel}>{group.label}</p>
              </div>
            )}
            {group.files.length === 0 ? (
              <div className={styles.groupEmpty}>No files</div>
            ) : (
              group.files.map((f) => {
                const isActive =
                  activeFile !== null &&
                  f.path === activeFile.path &&
                  (group.slug ?? null) === activeFile.repo;
                return (
                  // biome-ignore lint/a11y/useSemanticElements: contains no child buttons, purely a list item
                  <div
                    key={f.path}
                    role="button"
                    tabIndex={0}
                    className={[
                      styles.fileItem,
                      isActive ? styles.active : undefined,
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() =>
                      onSelect({ path: f.path, repo: group.slug ?? null })
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect({ path: f.path, repo: group.slug ?? null });
                      }
                    }}
                  >
                    {f.isJob && (
                      <Badge
                        variant="success"
                        className="text-[9px] px-[5px] py-[1px] font-mono uppercase tracking-widest border border-current"
                      >
                        job
                      </Badge>
                    )}
                    {f.path}
                  </div>
                );
              })
            )}
          </div>
        ))
      )}
    </div>
  );
}
