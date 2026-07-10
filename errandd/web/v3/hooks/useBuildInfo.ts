import { useEffect, useRef, useState } from "react";
import { apiJSON } from "../../api/client";

/**
 * The running daemon's build identity, surfaced in the sidebar header so it can
 * be read off at a glance (e.g. to tell someone which version is live without
 * curling `/api/state`).
 *
 *   version   – `runtime.version` (the plugin/build version, e.g. "1.0.244")
 *   sha       – `runtime.git.sha8` (null for image builds, which carry no git)
 *   startedAt – `daemon.startedAt` epoch ms ≈ when this build was last deployed
 *               (the daemon process start; a redeploy restarts the process)
 */
export interface BuildInfo {
  version: string;
  sha: string | null;
  startedAt: number;
}

const EMPTY: BuildInfo = { version: "", sha: null, startedAt: 0 };

interface StateBuildSlice {
  runtime?: { version?: string; git?: { sha8?: string | null } };
  daemon?: { startedAt?: number };
}

const POLL_MS = 30_000;

/** Poll `/api/state` for the build slice. 30s is plenty — the version only
 *  changes on a redeploy, and the header just needs to catch up shortly after. */
export function useBuildInfo(): BuildInfo {
  const [info, setInfo] = useState<BuildInfo>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        const res = await apiJSON<StateBuildSlice>("/api/state");
        if (cancelled) return;
        setInfo({
          version: res.runtime?.version ?? "",
          sha: res.runtime?.git?.sha8 ?? null,
          startedAt: typeof res.daemon?.startedAt === "number" ? res.daemon.startedAt : 0,
        });
      } catch {
        // transient — keep the last value; next poll recovers
      } finally {
        if (!cancelled) timer = setTimeout(() => void load(), POLL_MS);
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return info;
}

/**
 * Detects when the daemon ships a build newer than the one THIS tab loadedRef.
 * Captures the first non-empty version seen as the tab's baseline; if a later
 * poll reports a different version, a redeploy happened and the loadedRef JS bundle
 * is stale — surface `{ stale: true, version }` so the UI can offer a refresh.
 */
export function useStaleBundle(): { stale: boolean; version: string } {
  const { version } = useBuildInfo();
  const loadedRef = useRef<string>("");
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!version) return;
    if (!loadedRef.current) {
      loadedRef.current = version; // baseline = the version this tab booted on
      return;
    }
    if (version !== loadedRef.current) setStale(true);
  }, [version]);

  return { stale, version };
}

/** Compact "Ns / Nm / Nh / Nd" since an epoch-ms timestamp (for "deployed … ago"). */
export function agoShort(epochMs: number, now: number = Date.now()): string {
  if (!epochMs) return "";
  const s = Math.max(0, Math.floor((now - epochMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
