import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from "react";
import { readHashWindows, writeHashWindows } from "./hash";
import { type Wallpaper, apply as applyWallpaper, read as readWallpaper, write as writeWallpaper } from "./wallpaper";

// ---------- Types ----------

/** Spec for a user-editable setting shown in the Settings app. */
export type SettingSpec =
  | { key: string; label: string; type: "string"; default: string }
  | { key: string; label: string; type: "boolean"; default: boolean }
  | { key: string; label: string; type: "number"; default: number }
  | { key: string; label: string; type: "select"; default: string; options: { value: string; label: string }[] };

export interface WindowState {
  id: string;          // unique instance id
  appId: string;       // which app
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  minimized: boolean;
}

export interface MenuItemConfig {
  label: string;
  /** Either opens an app, or runs a built-in action. */
  appId?: string;
  action?: "about" | "switchToDarwin" | "switchToOs9";
  separator?: boolean;
}

export interface MenuConfig {
  label: string;
  items: MenuItemConfig[];
}

interface PersistedState {
  settings: Record<string, string | number | boolean>;
  menus: MenuConfig[];
}

interface RuntimeState {
  windows: WindowState[];
  nextZ: number;
  wallpaper: Wallpaper;
}

type State = PersistedState & RuntimeState;

type Action =
  | { type: "set-setting"; key: string; value: string | number | boolean }
  | { type: "set-menus"; menus: MenuConfig[] }
  | {
      type: "open";
      appId: string;
      title: string;
      width: number;
      height: number;
      /** Optional initial geometry override (used for snap-to-fullscreen on narrow viewports). */
      initial?: { x: number; y: number; width: number; height: number };
    }
  | { type: "close"; id: string }
  | { type: "focus"; id: string }
  | { type: "move"; id: string; x: number; y: number }
  | { type: "geometry"; id: string; x: number; y: number; width: number; height: number }
  | { type: "snap-all"; x: number; y: number; width: number; height: number }
  | { type: "set-wallpaper"; wallpaper: Wallpaper };

// ---------- Defaults ----------

const PERSIST_KEY = "osish.state.v1";

const DEFAULT_MENUS: MenuConfig[] = [
  {
    label: "🖥️",
    items: [
      { label: "About osish…", action: "about" },
      { label: "—", separator: true },
      { label: "Switch to Darwin UI", action: "switchToDarwin" },
      { label: "Switch to Classic", action: "switchToOs9" },
    ],
  },
];

function defaultsFromSpecs(specs: SettingSpec[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const s of specs) out[s.key] = s.default;
  return out;
}

function loadPersisted(specs: SettingSpec[]): PersistedState {
  const defaults: PersistedState = {
    settings: defaultsFromSpecs(specs),
    menus: DEFAULT_MENUS,
  };
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      settings: { ...defaults.settings, ...(parsed.settings ?? {}) },
      menus: parsed.menus ?? defaults.menus,
    };
  } catch {
    return defaults;
  }
}

function savePersisted(s: PersistedState): void {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

// ---------- Reducer ----------

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "set-setting":
      return { ...state, settings: { ...state.settings, [action.key]: action.value } };
    case "set-menus":
      return { ...state, menus: action.menus };
    case "open": {
      const z = state.nextZ + 1;
      const existing = state.windows.find((w) => w.appId === action.appId);
      if (existing) {
        // Singleton — refocus + un-minimize. If an initial override is given
        // (e.g. snap-to-fullscreen on narrow) also resize/reposition.
        return {
          ...state,
          nextZ: z,
          windows: state.windows.map((w) =>
            w.id === existing.id
              ? {
                  ...w,
                  z,
                  minimized: false,
                  ...(action.initial ?? {}),
                }
              : w,
          ),
        };
      }
      const offset = (state.windows.length % 8) * 24;
      const geom = action.initial ?? {
        x: 60 + offset,
        y: 60 + offset,
        width: action.width,
        height: action.height,
      };
      return {
        ...state,
        nextZ: z,
        windows: [
          ...state.windows,
          {
            id: `${action.appId}-${Date.now()}`,
            appId: action.appId,
            title: action.title,
            x: geom.x,
            y: geom.y,
            width: geom.width,
            height: geom.height,
            z,
            minimized: false,
          },
        ],
      };
    }
    case "close":
      return { ...state, windows: state.windows.filter((w) => w.id !== action.id) };
    case "focus": {
      const z = state.nextZ + 1;
      return {
        ...state,
        nextZ: z,
        windows: state.windows.map((w) => (w.id === action.id ? { ...w, z } : w)),
      };
    }
    case "move":
      return {
        ...state,
        windows: state.windows.map((w) =>
          w.id === action.id ? { ...w, x: action.x, y: action.y } : w,
        ),
      };
    case "geometry":
      return {
        ...state,
        windows: state.windows.map((w) =>
          w.id === action.id
            ? { ...w, x: action.x, y: action.y, width: action.width, height: action.height }
            : w,
        ),
      };
    case "snap-all": {
      // Bail out if every window already matches the target geometry —
      // otherwise this fires in a loop (viewport effect → dispatch → new state
      // → new context value → new snapAll ref → effect re-runs).
      const changed = state.windows.some(
        (w) =>
          w.x !== action.x ||
          w.y !== action.y ||
          w.width !== action.width ||
          w.height !== action.height,
      );
      if (!changed) return state;
      return {
        ...state,
        windows: state.windows.map((w) => ({
          ...w,
          x: action.x,
          y: action.y,
          width: action.width,
          height: action.height,
        })),
      };
    }
    case "set-wallpaper":
      return { ...state, wallpaper: action.wallpaper };
    default:
      return state;
  }
}

// ---------- Context ----------

interface Ctx {
  state: State;
  openApp: (appId: string, initial?: { x: number; y: number; width: number; height: number }) => void;
  closeWindow: (id: string) => void;
  focusWindow: (id: string) => void;
  moveWindow: (id: string, x: number, y: number) => void;
  snapAll: (x: number, y: number, width: number, height: number) => void;
  setSetting: (key: string, value: string | number | boolean) => void;
  setMenus: (menus: MenuConfig[]) => void;
  setWallpaper: (w: Wallpaper) => void;
  apps: AppDef[];
  appById: (id: string) => AppDef | undefined;
  settingSpecs: SettingSpec[];
}

export interface AppDef {
  id: string;
  title: string;
  defaultWidth: number;
  defaultHeight: number;
  render: () => ReactNode;
}

const OsContext = createContext<Ctx | null>(null);

export function useOs(): Ctx {
  const ctx = useContext(OsContext);
  if (!ctx) throw new Error("useOs outside provider");
  return ctx;
}

export function OsProvider({
  apps,
  settingSpecs,
  children,
}: {
  apps: AppDef[];
  settingSpecs: SettingSpec[];
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(reducer, undefined as unknown as State, () => {
    const persisted = loadPersisted(settingSpecs);
    // Seed open windows from #w=… so deep links restore layout.
    const hashWins = readHashWindows();
    let z = 0;
    const windows: WindowState[] = [];
    for (const hw of hashWins) {
      const app = apps.find((a) => a.id === hw.appId);
      if (!app) continue;
      z += 1;
      windows.push({
        id: `${hw.appId}-${z}`,
        appId: hw.appId,
        title: app.title,
        x: hw.x,
        y: hw.y,
        width: hw.width,
        height: hw.height,
        z,
        minimized: false,
      });
    }
    return {
      ...persisted,
      windows,
      nextZ: z,
      wallpaper: readWallpaper(),
    };
  });

  // Persist user-editable state on change.
  useEffect(() => {
    savePersisted({ settings: state.settings, menus: state.menus });
  }, [state.settings, state.menus]);

  // Apply wallpaper to <body> when it changes.
  useEffect(() => {
    applyWallpaper(state.wallpaper);
    writeWallpaper(state.wallpaper);
  }, [state.wallpaper]);

  // Mirror open windows into the URL hash so deep links restore layout.
  useEffect(() => {
    writeHashWindows(state.windows);
  }, [state.windows]);

  const openApp = useCallback(
    (appId: string, initial?: { x: number; y: number; width: number; height: number }) => {
      const app = apps.find((a) => a.id === appId);
      if (!app) return;
      // Responsive default: on narrow viewports, snap new windows to fill the
      // desktop layer (the area under the menu bar). Caller can still pass an
      // explicit `initial` to override.
      const NARROW = 640;
      const desktop = document.querySelector(".osish-desktop");
      const dRect = desktop?.getBoundingClientRect();
      const effective =
        initial ??
        (window.innerWidth < NARROW && dRect
          ? { x: 0, y: 0, width: dRect.width, height: dRect.height }
          : undefined);
      const action: Action = {
        type: "open",
        appId,
        title: app.title,
        width: app.defaultWidth,
        height: app.defaultHeight,
      };
      if (effective) action.initial = effective;
      dispatch(action);
    },
    [apps],
  );

  // Stable callbacks — `dispatch` from useReducer never changes identity, so
  // these refs are stable across renders. Consumers can safely depend on them
  // in useEffect without causing loops.
  const closeWindow = useCallback((id: string) => dispatch({ type: "close", id }), []);
  const focusWindow = useCallback((id: string) => dispatch({ type: "focus", id }), []);
  const moveWindow = useCallback(
    (id: string, x: number, y: number) => dispatch({ type: "move", id, x, y }),
    [],
  );
  const snapAll = useCallback(
    (x: number, y: number, width: number, height: number) =>
      dispatch({ type: "snap-all", x, y, width, height }),
    [],
  );
  const setSetting = useCallback(
    (key: string, value: string | number | boolean) =>
      dispatch({ type: "set-setting", key, value }),
    [],
  );
  const setMenus = useCallback((menus: MenuConfig[]) => dispatch({ type: "set-menus", menus }), []);
  const setWallpaper = useCallback(
    (wallpaper: Wallpaper) => dispatch({ type: "set-wallpaper", wallpaper }),
    [],
  );

  const value = useMemo<Ctx>(
    () => ({
      state,
      openApp,
      closeWindow,
      focusWindow,
      moveWindow,
      snapAll,
      setSetting,
      setMenus,
      setWallpaper,
      apps,
      appById: (id) => apps.find((a) => a.id === id),
      settingSpecs,
    }),
    [
      state,
      openApp,
      closeWindow,
      focusWindow,
      moveWindow,
      snapAll,
      setSetting,
      setMenus,
      setWallpaper,
      apps,
      settingSpecs,
    ],
  );

  return <OsContext.Provider value={value}>{children}</OsContext.Provider>;
}
