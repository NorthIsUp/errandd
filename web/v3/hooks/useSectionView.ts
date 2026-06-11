import { useCallback, useState } from "react";
import { COUNT_STOPS, DAYS_STOPS, type ViewMode } from "../lib/paging";

/**
 * Per-section view state: mode toggle, slider value, and pagination.
 * Persisted to localStorage so the user's chosen filter survives reloads.
 * Page is NOT persisted — always starts at 0 (the most recent page).
 */

export interface SectionView {
  mode: ViewMode;
  /** Active slider stop — count (10/25/50/100) or days (1/3/7/14/30). */
  value: number;
  page: number;
  setMode: (m: ViewMode) => void;
  setValue: (v: number) => void;
  nextPage: () => void;
  prevPage: () => void;
}

interface PersistedView {
  mode: ViewMode;
  value: number;
}

function storageKey(source: string): string {
  return `clawdcode:v3:view:${source}`;
}

const DEFAULT_MODE: ViewMode = "count";
const DEFAULT_VALUE = 25;

function loadView(source: string): PersistedView {
  try {
    const raw = localStorage.getItem(storageKey(source));
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed != null &&
        typeof parsed === "object" &&
        "mode" in parsed &&
        "value" in parsed &&
        (parsed.mode === "count" || parsed.mode === "days") &&
        typeof parsed.value === "number"
      ) {
        // Validate that the saved value is a valid stop for the saved mode.
        const stops = parsed.mode === "count" ? COUNT_STOPS : DAYS_STOPS;
        if ((stops as readonly number[]).includes(parsed.value)) {
          return { mode: parsed.mode, value: parsed.value };
        }
      }
    }
  } catch {
    // ignore corrupt/unavailable storage
  }
  return { mode: DEFAULT_MODE, value: DEFAULT_VALUE };
}

function saveView(source: string, view: PersistedView): void {
  try {
    localStorage.setItem(storageKey(source), JSON.stringify(view));
  } catch {
    // ignore unavailable storage
  }
}

/** Hook managing count/days filter + pagination for one sidebar section. */
export function useSectionView(source: string): SectionView {
  const [mode, setModeRaw] = useState<ViewMode>(() => loadView(source).mode);
  const [value, setValueRaw] = useState<number>(() => loadView(source).value);
  const [page, setPage] = useState(0);

  const setMode = useCallback(
    (m: ViewMode) => {
      // When mode changes, snap value to the default stop for that mode and
      // reset the page so we don't land on a nonsensical page index.
      const newValue = m === "count" ? DEFAULT_VALUE : 7;
      setModeRaw(m);
      setValueRaw(newValue);
      setPage(0);
      saveView(source, { mode: m, value: newValue });
    },
    [source],
  );

  const setValue = useCallback(
    (v: number) => {
      setValueRaw(v);
      setPage(0);
      saveView(source, { mode, value: v });
    },
    [source, mode],
  );

  const nextPage = useCallback(() => setPage((p) => p + 1), []);
  const prevPage = useCallback(() => setPage((p) => Math.max(0, p - 1)), []);

  return { mode, value, page, setMode, setValue, nextPage, prevPage };
}
