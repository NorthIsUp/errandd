import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "clawd.theme";

function readStored(): ThemeMode {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  const isDark =
    mode === "dark" ||
    (mode === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
}

/**
 * Returns the current theme mode and a setter that persists to localStorage.
 * `system` follows the OS preference and re-applies whenever the OS flips.
 */
export function useTheme(): {
  mode: ThemeMode;
  isDark: boolean;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
} {
  const [mode, setModeState] = useState<ThemeMode>(() => readStored());
  const [isDark, setIsDark] = useState<boolean>(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    applyTheme(mode);
    setIsDark(document.documentElement.classList.contains("dark"));
  }, [mode]);

  useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      applyTheme("system");
      setIsDark(document.documentElement.classList.contains("dark"));
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    localStorage.setItem(STORAGE_KEY, next);
    setModeState(next);
  }, []);

  const toggle = useCallback(() => {
    // Click cycle: light → dark → system → light …
    setMode(mode === "light" ? "dark" : mode === "dark" ? "system" : "light");
  }, [mode, setMode]);

  return { mode, isDark, setMode, toggle };
}

/**
 * Back-compat: existing imports of `useSystemTheme` still work. Initialises
 * the theme on mount; the toggle button (Shell) drives changes from there.
 */
export function useSystemTheme(): void {
  useEffect(() => {
    applyTheme(readStored());
  }, []);
}
