import { useCallback, useEffect, useState } from "react";

/**
 * Hash-based route. Format: `#/<tab>[/segment[/segment...]]`.
 * Segments are URL-decoded individually so paths with `/` survive (we encode
 * each segment before joining).
 */
export type Route = {
  tab: TabId;
  segments: string[];
};

// Legacy ids (schedule, jobs, hooks, chat) remain in the union so old
// bookmarks and SSE clients still resolve — we just don't surface
// them in the desktop nav anymore. `jobs` is the previous name for
// `routines`; both work as paths.
export const TABS = [
  "home",
  "runs",
  "routines",
  "settings",
  "about",
  // legacy:
  "schedule",
  "jobs",
  "hooks",
  "chat",
] as const;
export type TabId = (typeof TABS)[number];

function parse(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  if (!raw) {
    return { tab: "home", segments: [] };
  }
  const parts = raw.split("/").map((s) => decodeURIComponent(s));
  const first = parts[0] as TabId;
  const tab = (TABS as readonly string[]).includes(first) ? first : "home";
  return { tab, segments: parts.slice(1).filter(Boolean) };
}

export function formatRoute(tab: TabId, segments: string[] = []): string {
  const path = [tab, ...segments].map(encodeURIComponent).join("/");
  return `#/${path}`;
}

export function useRoute(): {
  route: Route;
  goto: (tab: TabId, segments?: string[]) => void;
  push: (segment: string) => void;
  popTo: (depth: number) => void;
} {
  const [route, setRoute] = useState<Route>(() => parse(location.hash));

  useEffect(() => {
    const handler = () => setRoute(parse(location.hash));
    window.addEventListener("hashchange", handler);
    if (!location.hash) {
      location.hash = formatRoute("home");
    }
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const goto = useCallback((tab: TabId, segments: string[] = []) => {
    location.hash = formatRoute(tab, segments);
  }, []);

  const push = useCallback((segment: string) => {
    const r = parse(location.hash);
    location.hash = formatRoute(r.tab, [...r.segments, segment]);
  }, []);

  const popTo = useCallback((depth: number) => {
    const r = parse(location.hash);
    location.hash = formatRoute(r.tab, r.segments.slice(0, depth));
  }, []);

  return { route, goto, push, popTo };
}
