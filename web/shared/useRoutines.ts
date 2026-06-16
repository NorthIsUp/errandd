import { useCallback, useEffect, useState } from "react";
import { getHome, type HomeResponse, type LogRun } from "../api/home";
import { listJobFiles, type JobFileEntry } from "../api/jobs";
import { listRepos, type RepoStatus } from "../api/repos";

export interface UseRoutinesResult {
  repos: RepoStatus[];
  localFiles: JobFileEntry[];
  /** Per-repo job files keyed by repo slug. */
  repoFiles: Record<string, JobFileEntry[]>;
  home: HomeResponse | null;
  loading: boolean;
  reload: () => Promise<void>;
  /** Return all home log runs whose file name includes the given job base name. */
  runsForJob: (jobBaseName: string) => LogRun[];
}

/**
 * Headless data hook for RoutinesSection: load repos, local job files, and
 * per-repo job files, plus the daemon's home log runs.
 */
export function useRoutines(): UseRoutinesResult {
  const [repos, setRepos] = useState<RepoStatus[]>([]);
  const [localFiles, setLocalFiles] = useState<JobFileEntry[]>([]);
  const [repoFiles, setRepoFiles] = useState<Record<string, JobFileEntry[]>>({});
  const [home, setHome] = useState<HomeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const [r, lf, h] = await Promise.all([
        listRepos().catch(() => [] as RepoStatus[]),
        listJobFiles(null).catch(() => [] as JobFileEntry[]),
        getHome().catch(() => null),
      ]);
      setRepos(r);
      setLocalFiles(lf);
      setHome(h);
      const per: Record<string, JobFileEntry[]> = {};
      await Promise.all(
        r.map(async (repo) => {
          if (!repo.cloned) return;
          try {
            per[repo.slug] = await listJobFiles(repo.slug);
          } catch {
            per[repo.slug] = [];
          }
        }),
      );
      setRepoFiles(per);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runsForJob = useCallback(
    (jobBaseName: string): LogRun[] => {
      const all = home?.logs?.runs ?? [];
      return all.filter((r) => r.file.includes(jobBaseName));
    },
    [home],
  );

  return { repos, localFiles, repoFiles, home, loading, reload, runsForJob };
}
