import { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";

export interface LightThemeOption {
  id: string;
  label: string;
}
export interface DarkThemeOption {
  id: string;
  label: string;
}

/** Helper for the theme arrays — `label` defaults to a capitalized id. */
function t(id: string, label?: string): LightThemeOption {
  return { id, label: label ?? id.charAt(0).toUpperCase() + id.slice(1) };
}

export const LIGHT_THEMES: LightThemeOption[] = [
  t("lobster", "Lobster (default)"),
  t("light"),
  t("cupcake"),
  t("bumblebee"),
  t("emerald"),
  t("corporate"),
  t("retro"),
  t("valentine"),
  t("garden"),
  t("aqua"),
  t("lofi"),
  t("pastel"),
  t("fantasy"),
  t("wireframe"),
  t("cmyk"),
  t("autumn"),
  t("acid"),
  t("lemonade"),
  t("winter"),
  t("nord"),
  t("caramellatte", "Caramel Latte"),
  t("silk"),
];

export const DARK_THEMES: DarkThemeOption[] = [
  t("lobsterdark", "Lobster Dark (default)"),
  t("dark"),
  t("synthwave"),
  t("cyberpunk"),
  t("halloween"),
  t("forest"),
  t("black"),
  t("luxury"),
  t("dracula"),
  t("business"),
  t("night"),
  t("coffee"),
  t("dim"),
  t("sunset"),
  t("abyss"),
];

const MODE_KEY = "clawdcode:theme";
const LIGHT_KEY = "clawdcode:theme-light";
const DARK_KEY = "clawdcode:theme-dark";
const DEFAULT_LIGHT = "lobster";
const DEFAULT_DARK = "lobsterdark";

type Listener = () => void;
const listeners = new Set<Listener>();
function emit(): void {
  for (const l of listeners) {
    l();
  }
}

export function getMode(): ThemeMode {
  if (typeof localStorage === "undefined") {
    return "system";
  }
  const v = localStorage.getItem(MODE_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function getLightTheme(): string {
  return localStorage?.getItem(LIGHT_KEY) || DEFAULT_LIGHT;
}

export function getDarkTheme(): string {
  return localStorage?.getItem(DARK_KEY) || DEFAULT_DARK;
}

function prefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function effectiveTheme(): string {
  const mode = getMode();
  if (mode === "light") {
    return getLightTheme();
  }
  if (mode === "dark") {
    return getDarkTheme();
  }
  return prefersDark() ? getDarkTheme() : getLightTheme();
}

export function applyTheme(): void {
  document.documentElement.setAttribute("data-theme", effectiveTheme());
}

export function setMode(mode: ThemeMode): void {
  if (mode === "system") {
    localStorage.removeItem(MODE_KEY);
  } else {
    localStorage.setItem(MODE_KEY, mode);
  }
  applyTheme();
  emit();
}

export function setLightTheme(id: string): void {
  localStorage.setItem(LIGHT_KEY, id);
  applyTheme();
  emit();
}

export function setDarkTheme(id: string): void {
  localStorage.setItem(DARK_KEY, id);
  applyTheme();
  emit();
}

let systemListenerInstalled = false;
function installSystemListener(): void {
  if (systemListenerInstalled || typeof window === "undefined") {
    return;
  }
  systemListenerInstalled = true;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", () => {
    if (getMode() === "system") {
      applyTheme();
      emit();
    }
  });
}

export function useThemeState(): {
  mode: ThemeMode;
  lightTheme: string;
  darkTheme: string;
} {
  const [, force] = useState(0);
  useEffect(() => {
    installSystemListener();
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return {
    mode: getMode(),
    lightTheme: getLightTheme(),
    darkTheme: getDarkTheme(),
  };
}
