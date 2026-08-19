import { useCallback, useState } from "react";
import { DEFAULT_PR_FILTER, PR_STATE_ORDER, type PrStateFilter } from "../lib/prFilter";
import type { PrGitState } from "../lib/tree";

/**
 * Show/hide-by-git-state filter for the Pull Requests section, persisted to
 * localStorage like the other sidebar controls (`useSectionView`).
 */

const STORAGE_KEY = "errandd:v3:prfilter";

function loadFilter(): PrStateFilter {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PrStateFilter> | null;
      const saved = parsed?.visible;
      if (saved != null && typeof saved === "object") {
        // Rebuild from the known states so a stale or hand-edited blob can't
        // introduce unknown keys or drop one and hide every PR of that state.
        const visible = { ...DEFAULT_PR_FILTER.visible };
        for (const state of PR_STATE_ORDER) {
          const v = (saved as Record<string, unknown>)[state];
          if (typeof v === "boolean") {
            visible[state] = v;
          }
        }
        return {
          visible,
          recentTerminalOnly:
            typeof parsed?.recentTerminalOnly === "boolean"
              ? parsed.recentTerminalOnly
              : DEFAULT_PR_FILTER.recentTerminalOnly,
        };
      }
    }
  } catch {
    // ignore corrupt/unavailable storage
  }
  return DEFAULT_PR_FILTER;
}

function saveFilter(filter: PrStateFilter): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filter));
  } catch {
    // ignore unavailable storage
  }
}

export interface PrStateFilterControls {
  filter: PrStateFilter;
  toggleState: (state: PrGitState) => void;
  toggleRecentOnly: () => void;
  reset: () => void;
}

export function usePrStateFilter(): PrStateFilterControls {
  // eslint-disable-next-line @eslint-react/use-state -- raw setter; the wrappers below are the public API and also persist
  const [filter, setFilterRaw] = useState<PrStateFilter>(loadFilter);

  const update = useCallback((next: PrStateFilter) => {
    setFilterRaw(next);
    saveFilter(next);
  }, []);

  const toggleState = useCallback(
    (state: PrGitState) => {
      setFilterRaw((prev) => {
        const next: PrStateFilter = {
          ...prev,
          visible: { ...prev.visible, [state]: !prev.visible[state] },
        };
        saveFilter(next);
        return next;
      });
    },
    [],
  );

  const toggleRecentOnly = useCallback(() => {
    setFilterRaw((prev) => {
      const next: PrStateFilter = { ...prev, recentTerminalOnly: !prev.recentTerminalOnly };
      saveFilter(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => update(DEFAULT_PR_FILTER), [update]);

  return { filter, toggleState, toggleRecentOnly, reset };
}
