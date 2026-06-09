import { Menu } from "lucide-react";
import {
  type ComponentType,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ChatPane } from "./components/ChatPane";
import { Sidebar } from "./components/Sidebar";
import { cn } from "./components/ui/utils";
import type { V3View } from "./router";
import { selectedThreadId, useRoute } from "./router";
import { AboutView } from "./sections/AboutView";
import { DeliveriesView } from "./sections/DeliveriesView";
import { RoutinesView } from "./sections/RoutinesView";
import { SettingsView } from "./sections/SettingsView";

/**
 * v3 two-zone shell.
 *
 *   ┌──────────┬───────────────────────────────┐
 *   │ Sidebar  │            MainPane            │
 *   │ (hook    │  chat | deliveries | routines │
 *   │  tree +  │  | settings | about           │
 *   │  bottom  │                               │
 *   │  nav)    │                               │
 *   └──────────┴───────────────────────────────┘
 *
 * ──────────────────────────────────────────────────────────────────────────
 * EXTENSION POINTS for the parallel frontend agents (spec §11). App.tsx is
 * owned by Foundation; agents register their views WITHOUT editing each
 * other by replacing the placeholders below with their real modules:
 *
 *  (a) Sidebar agent  — replace `<SidebarPlaceholder/>` with
 *        `import { Sidebar } from "./components/Sidebar"`.
 *      Sidebar must call `selectThread(threadId)` (from useRoute) to select a
 *      thread and `goto(view)` to switch the main pane. It reads the selected
 *      thread via `selectedThreadId(route)`.
 *
 *  (b) Chat-pane agent — replace the `chat` branch of MAIN_VIEWS with
 *        `import { ChatPane } from "./components/ChatPane"` and render
 *        `<ChatPane threadId={threadId} />`. `threadId` is passed in props.
 *
 *  (c) Bottom-nav agent — replace the `deliveries` / `routines` / `settings`
 *        / `about` placeholders in MAIN_VIEWS with the real section views
 *        from `./sections/*`. Each is a zero-prop component.
 *
 * The contract between zones is the hash router (`router.ts`): selecting a
 * thread is `selectThread(id)` → `#/chat/<id>`; switching a bottom-nav view is
 * `goto(view)`. No cross-imports between agent modules are required.
 * ──────────────────────────────────────────────────────────────────────────
 */

/** Props every main-pane view receives. `threadId` is only set for `chat`. */
export type MainPaneProps = {
  threadId: string | null;
};

/**
 * Registry of main-pane views keyed by route. Frontend agents swap each
 * placeholder for their real component (same `ComponentType<MainPaneProps>`
 * signature) during integration — no other file needs to change.
 */
const MAIN_VIEWS: Record<V3View, ComponentType<MainPaneProps>> = {
  chat: ChatPane,
  deliveries: DeliveriesView,
  routines: RoutinesView,
  settings: SettingsView,
  about: AboutView,
};

const SIDEBAR_W_KEY = "clawdcode:v3:sidebarW";
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 560;

function loadSidebarWidth(): number {
  try {
    const v = Number(localStorage.getItem(SIDEBAR_W_KEY));
    if (v >= SIDEBAR_MIN && v <= SIDEBAR_MAX) {
      return v;
    }
  } catch {
    // ignore
  }
  return 288;
}

export default function App() {
  const { route, goto, selectThread } = useRoute();
  const threadId = selectedThreadId(route);
  const MainView = MAIN_VIEWS[route.view];

  // On narrow screens the sidebar becomes an off-canvas drawer (hamburger +
  // backdrop); on md+ it's the static, resizeable left column.
  const [mobileOpen, setMobileOpen] = useState(false);
  const selectThreadMobile = useCallback(
    (id: string) => {
      selectThread(id);
      setMobileOpen(false);
    },
    [selectThread],
  );
  const gotoMobile = useCallback(
    (v: V3View) => {
      goto(v);
      setMobileOpen(false);
    },
    [goto],
  );

  const [sidebarW, setSidebarW] = useState(loadSidebarWidth);
  // Active drag's AbortController — scopes the document mousemove/mouseup
  // listeners so a mid-drag unmount can't leak them (cleaned up below).
  const dragAbort = useRef<AbortController | null>(null);
  useEffect(() => () => dragAbort.current?.abort(), []);

  // Drag-to-resize the sidebar (the divider between the two zones). Width is
  // clamped and persisted so it survives reloads.
  const onResizeStart = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    dragAbort.current?.abort();
    const ac = new AbortController();
    dragAbort.current = ac;
    const { signal } = ac;
    const onUp = () => {
      ac.abort();
      dragAbort.current = null;
      document.body.style.userSelect = "";
      setSidebarW((w) => {
        try {
          localStorage.setItem(SIDEBAR_W_KEY, String(w));
        } catch {
          // ignore
        }
        return w;
      });
    };
    document.body.style.userSelect = "none";
    document.addEventListener(
      "mousemove",
      (ev: MouseEvent) => {
        setSidebarW(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX)));
      },
      { signal },
    );
    document.addEventListener("mouseup", onUp, { signal });
  }, []);

  return (
    <div className="v3-shell h-screen flex overflow-hidden text-base-content">
      {/* Mobile: open-sidebar button (hidden on md+). */}
      <button
        type="button"
        aria-label="Open sidebar"
        onClick={() => setMobileOpen(true)}
        className="fixed left-3 top-3 z-30 grid size-9 place-items-center rounded-lg border border-base-300 bg-base-100/90 shadow-sm backdrop-blur md:hidden"
      >
        <Menu className="size-5" />
      </button>

      {/* Mobile: backdrop behind the drawer. */}
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close sidebar"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-30 cursor-default border-0 bg-black/40 md:hidden"
        />
      )}

      {/* Zone 1: sidebar — off-canvas drawer on mobile, static column on md+. */}
      <aside
        style={{ width: sidebarW }}
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex max-w-[85vw] flex-col overflow-hidden border-r border-base-300 bg-base-100/95 shadow-2xl backdrop-blur-sm transition-transform",
          "md:static md:z-auto md:shrink-0 md:translate-x-0 md:bg-base-100/85 md:shadow-none",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <Sidebar
          activeView={route.view}
          activeThreadId={threadId}
          onSelectThread={selectThreadMobile}
          onSelectView={gotoMobile}
        />
      </aside>

      {/* Drag handle between the zones (desktop only). */}
      <button
        type="button"
        aria-label="Resize sidebar"
        onMouseDown={onResizeStart}
        className="hidden w-1 shrink-0 cursor-col-resize border-0 bg-base-300/30 p-0 transition-colors hover:bg-primary/50 md:block"
      />

      {/* Zone 2: main pane. */}
      <main className="v3-main flex-1 min-w-0 flex flex-col overflow-hidden">
        <MainView threadId={threadId} />
      </main>
    </div>
  );
}
