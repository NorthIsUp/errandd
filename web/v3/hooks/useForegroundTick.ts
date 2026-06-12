import { useEffect, useState } from "react";

/**
 * A counter that bumps each time the tab returns to the foreground
 * (`visibilitychange` → visible, or window `focus`), debounced so the two
 * events don't double-fire.
 *
 * Include the returned value in a data-fetch / EventSource effect's dependency
 * array to force a re-run when the user comes back to the tab — so the view is
 * fully up to date. This matters because a backgrounded tab's SSE connection
 * can silently drop (browser throttling, network sleep, or the daemon
 * restarting — e.g. a pod recycle) and not recover until something pushes;
 * reconnecting on foreground guarantees a fresh snapshot immediately.
 */
export function useForegroundTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let last = 0;
    const bump = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      const now = Date.now();
      if (now - last < 1000) {
        return; // debounce the focus + visibilitychange double-fire
      }
      last = now;
      setTick((t) => t + 1);
    };
    document.addEventListener("visibilitychange", bump);
    window.addEventListener("focus", bump);
    return () => {
      document.removeEventListener("visibilitychange", bump);
      window.removeEventListener("focus", bump);
    };
  }, []);
  return tick;
}
