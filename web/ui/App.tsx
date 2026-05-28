import { CircleHelp, Cog, Home, ListChecks, Workflow } from "lucide-react";
import { TabBar, type TabSpec } from "./components/TabBar";
import { usePageHeaderValue } from "./pageHeader";
import { type TabId, useRoute } from "./router";
import { AboutSection } from "./sections/AboutSection";
import { ChatSection } from "./sections/ChatSection";
import { HomeSection } from "./sections/HomeSection";
import { HooksSection } from "./sections/HooksSection";
import { JobsSection } from "./sections/JobsSection";
import { RunsSection } from "./sections/RunsSection";
import { ScheduleSection } from "./sections/ScheduleSection";
import { SettingsSection } from "./sections/SettingsSection";

// Flat nav. `runs` is the unified table of every execution (replaces
// the old schedule + hooks live-status surfaces). `routines` is the
// renamed `jobs` tab — same component, new label/path. Receiver
// setup moved into Settings, so there's no separate Hooks tab. Chat
// is still reachable via direct link from runs/routine pages.
const TABS: TabSpec[] = [
  { id: "home", label: "Home", Icon: Home },
  { id: "runs", label: "Runs", Icon: ListChecks },
  { id: "routines", label: "Routines", Icon: Workflow },
  { id: "settings", label: "Settings", Icon: Cog },
  { id: "about", label: "About", Icon: CircleHelp },
];

export default function App() {
  const { route, goto } = useRoute();
  const { actions } = usePageHeaderValue();

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <header className="shrink-0 bg-base-100/85 backdrop-blur border-b border-base-300">
        <div className="mx-auto w-full max-w-5xl px-3 sm:px-6 py-2 flex items-center gap-2 sm:gap-3">
          <span className="text-xl sm:text-2xl select-none shrink-0" aria-hidden title="clawdcode">
            🦞
          </span>
          <span className="font-semibold tracking-tight shrink-0 hidden sm:inline">ClawdCode</span>
          <div className="flex-1" />
          {actions && <div className="flex items-center gap-1 shrink-0">{actions}</div>}
          <div className="hidden md:block shrink-0">
            <TabBar
              tabs={TABS}
              active={route.tab}
              onSelect={(id: TabId) => goto(id)}
              variant="top"
            />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-1.5 sm:px-6 py-3 sm:py-4 space-y-3 sm:space-y-4">
          {route.tab === "home" && <HomeSection />}
          {route.tab === "runs" && <RunsSection />}
          {(route.tab === "routines" || route.tab === "jobs") && <JobsSection />}
          {route.tab === "settings" && <SettingsSection />}
          {route.tab === "about" && <AboutSection />}
          {/* Legacy tabs — no longer in nav, but old links still resolve. */}
          {route.tab === "schedule" && <ScheduleSection />}
          {route.tab === "hooks" && <HooksSection />}
          {route.tab === "chat" && <ChatSection />}
        </div>
      </main>

      <div className="md:hidden shrink-0 w-full">
        <TabBar tabs={TABS} active={route.tab} onSelect={(id: TabId) => goto(id)} variant="dock" />
      </div>
    </div>
  );
}
