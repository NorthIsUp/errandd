import { useEffect, useState } from "react";
import type { RuntimeGit } from "../api/state";

/** Read token from URL once, stash in module-level var for the session. */
let cachedToken: string | null = null;
function getToken(): string {
  if (cachedToken !== null) return cachedToken;
  const fromUrl = new URLSearchParams(window.location.search).get("token");
  if (fromUrl) {
    cachedToken = fromUrl;
    try {
      sessionStorage.setItem("cc_token", fromUrl);
    } catch {
      // ignore
    }
    return cachedToken;
  }
  try {
    cachedToken = sessionStorage.getItem("cc_token") ?? "";
  } catch {
    cachedToken = "";
  }
  return cachedToken;
}

export interface GitInfo extends RuntimeGit {
  sha8: string;
  dirty: boolean;
}

/**
 * Fetches git runtime info from /api/state and returns it.
 * Returns null while loading or if git info is unavailable.
 */
export function useGitInfo(): GitInfo | null {
  const [git, setGit] = useState<GitInfo | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    const token = getToken();
    const url = token
      ? `/api/state?token=${encodeURIComponent(token)}`
      : "/api/state";
    fetch(url, { signal: ac.signal })
      .then(
        (r) =>
          r.json() as Promise<{
            runtime?: {
              git?: RuntimeGit;
            };
          }>,
      )
      .then((data) => {
        const g = data?.runtime?.git;
        if (g?.sha8) {
          const info: GitInfo = {
            sha8: g.sha8,
            dirty: g.dirty ?? false,
            tag: g.tag ?? null,
            describe: g.describe ?? null,
          };
          if (g.commitUrl !== undefined) info.commitUrl = g.commitUrl;
          if (g.sha !== undefined) info.sha = g.sha;
          if (g.branch !== undefined) info.branch = g.branch;
          setGit(info);
        }
      })
      .catch(() => {
        // aborted on unmount, or no git info — stay null
      });
    return () => ac.abort();
  }, []);

  return git;
}
