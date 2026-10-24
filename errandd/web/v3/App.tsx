import { Menu, Search } from "lucide-react";
import {
  type ComponentType,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ChatPane } from "./components/ChatPane";
import { RateLimitBanner } from "./components/RateLimitBanner";
import { Sidebar } from "./components/Sidebar";
import { ThreadSwitcher } from "./components/ThreadSwitcher";
import type { ThreadEntry } from "./lib/threadCatalog";
import { UpdateBanner } from "./components/UpdateBanner";
import { cn } from "./components/ui/utils";
import type { V3View } from "./router";
import { selectedThreadId, useRoute } from "./router";
import { AboutView } from "./sections/AboutView";
import { DeliveriesView } from "./sections/DeliveriesView";
import { RoutinesView } from "./sections/RoutinesView";
import { SettingsView } from "./sections/SettingsView";
import "./streamlined.css";

/** Source navigation and a focused main pane, with one shared thread index. */

/** Props every main-pane view receives. `threadId` is only set for `chat`. */
export interface MainPaneProps {
  threadId: string | null;
  threadInfo?: ThreadEntry;
  onOpenSwitcher?: () => void;
}

/** Views share the selected thread heading and global thread switcher. */
const MAIN_VIEWS: Record<V3View, ComponentType<MainPaneProps>> = {
  chat: ChatPane,
  deliveries: DeliveriesView,
  routines: RoutinesView,
  settings: SettingsView,
  about: AboutView,
};

const SIDEBAR_W_KEY = "errandd:v3:sidebarW:streamlined";
const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 480;

function loadSidebarWidth(): number {
  try {
    const v = Number(localStorage.getItem(SIDEBAR_W_KEY));
    if (v >= SIDEBAR_MIN && v <= SIDEBAR_MAX) {
      return v;
    }
  } catch {
    // ignore
  }
  return 272;
}

export default function App() {
  const { route, goto, selectThread } = useRoute();
  const threadId = selectedThreadId(route);
  const MainView = MAIN_VIEWS[route.view];
  const [catalog, setCatalog] = useState<{ threads: ThreadEntry[]; loading: boolean }>({ threads: [], loading: true });
  const threadInfo = catalog.threads.find(entry => entry.threadId === threadId);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const updateCatalog = useCallback((threads: ThreadEntry[], loading: boolean) => setCatalog({ threads, loading }), []);
  const openSwitcher = useCallback(() => setSwitcherOpen(true), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSwitcherOpen(open => !open);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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
  const dragAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => dragAbortRef.current?.abort(), []);

  // Drag-to-resize the sidebar (the divider between the two zones). Width is
  // clamped and persisted so it survives reloads.
  const onResizeStart = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    dragAbortRef.current?.abort();
    const ac = new AbortController();
    dragAbortRef.current = ac;
    const { signal } = ac;
    const onUp = () => {
      ac.abort();
      dragAbortRef.current = null;
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
          onThreadsChange={updateCatalog}
          onOpenSwitcher={openSwitcher}
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

      {/* Zone 2: main pane. The rate-limit banner sits above the active view so
          the "N message(s) queued, resuming HH:MM UTC" notice is visible no
          matter which view is open (it renders nothing when not limited). */}
      <main className="v3-main flex-1 min-w-0 flex flex-col overflow-hidden">
        <UpdateBanner />
        <RateLimitBanner />
        <MainView key={route.view === "chat" ? threadId ?? "empty" : route.view} threadId={threadId}
          {...(threadInfo ? { threadInfo } : {})}
          onOpenSwitcher={openSwitcher} />
      </main>
      <button type="button" className="v3-mobile-search" aria-label="Jump to a thread" onClick={openSwitcher}><Search size={18} /></button>
      {switcherOpen && <ThreadSwitcher threads={catalog.threads} loading={catalog.loading} activeThreadId={threadId}
        onSelect={selectThreadMobile} onClose={() => setSwitcherOpen(false)} />}
    </div>
  );
}
