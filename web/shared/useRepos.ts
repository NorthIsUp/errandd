import { useCallback, useEffect, useState } from "react";
import { listRepos, syncRepo, type RepoStatus } from "../api/repos";

export interface UseReposResult {
  repos: RepoStatus[];
  loading: boolean;
  syncing: string | null;
  reload: () => Promise<void>;
  sync: (slug: string) => Promise<void>;
}

/** Headless hook for the Repos settings panel. */
export function useRepos(): UseReposResult {
  const [repos, setRepos] = useState<RepoStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRepos(await listRepos());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const sync = useCallback(
    async (slug: string) => {
      setSyncing(slug);
      try {
        await syncRepo(slug);
        await reload();
      } finally {
        setSyncing(null);
      }
    },
    [reload],
  );

  return { repos, loading, syncing, reload, sync };
}
