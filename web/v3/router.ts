import { useCallback, useEffect, useState } from "react";

/**
 * Hash routing for the v3 shell. Format: `#/<view>[/segment[/segment...]]`.
 *
 * The default view is `chat`, whose first segment is the selected thread id
 * (`#/chat/<threadId>`). The bottom-nav views (`deliveries`, `routines`,
 * `settings`, `about`) take over the main pane while the sidebar stays
 * visible. Pattern mirrors web/ui/router.ts (individually-encoded segments so
 * thread ids containing `/` or `:` survive a round-trip).
 */
export const V3_VIEWS = ["chat", "deliveries", "routines", "settings", "about"] as const;
export type V3View = (typeof V3_VIEWS)[number];

export type V3Route = {
  view: V3View;
  /** For `chat`, segments[0] is the selected threadId (if any). */
  segments: string[];
};

function parse(hash: string): V3Route {
  const raw = hash.replace(/^#\/?/, "");
  if (!raw) {
    return { view: "chat", segments: [] };
  }
  const parts = raw.split("/").map((s) => decodeURIComponent(s));
  const first = parts[0] as V3View;
  const view = (V3_VIEWS as readonly string[]).includes(first) ? first : "chat";
  return { view, segments: parts.slice(1).filter(Boolean) };
}

export function formatRoute(view: V3View, segments: string[] = []): string {
  const path = [view, ...segments].map(encodeURIComponent).join("/");
  return `#/${path}`;
}

/** Convenience: the threadId currently selected (only meaningful in `chat`). */
export function selectedThreadId(route: V3Route): string | null {
  return route.view === "chat" ? (route.segments[0] ?? null) : null;
}

export function useRoute(): {
  route: V3Route;
  goto: (view: V3View, segments?: string[]) => void;
  /** Select a thread and switch the main pane to the chat view. */
  selectThread: (threadId: string) => void;
} {
  const [route, setRoute] = useState<V3Route>(() => parse(location.hash));

  useEffect(() => {
    const handler = () => setRoute(parse(location.hash));
    window.addEventListener("hashchange", handler);
    if (!location.hash) {
      location.hash = formatRoute("chat");
    }
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const goto = useCallback((view: V3View, segments: string[] = []) => {
    location.hash = formatRoute(view, segments);
  }, []);

  const selectThread = useCallback((threadId: string) => {
    location.hash = formatRoute("chat", [threadId]);
  }, []);

  return { route, goto, selectThread };
}
