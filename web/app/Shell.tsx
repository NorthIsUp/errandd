import { Tabs, TabsList, TabsTrigger } from "@pikoloo/darwin-ui";
import { Home, ListChecks, MessageSquare, Settings } from "lucide-react";
import { useHash, type Section } from "../hooks/useHash";
import { useSystemTheme } from "../hooks/useSystemTheme";
import { ChatsSection } from "./sections/ChatsSection";
import { HomeSection } from "./sections/HomeSection";
import { RoutinesSection } from "./sections/RoutinesSection";
import { SettingsSection } from "./sections/SettingsSection";

const NAV: { id: Section; label: string; Icon: typeof Home }[] = [
  { id: "home", label: "Home", Icon: Home },
  { id: "chats", label: "Chats", Icon: MessageSquare },
  { id: "routines", label: "Routines", Icon: ListChecks },
  { id: "settings", label: "Settings", Icon: Settings },
];

export function Shell() {
  const { section, setSection } = useHash();
  useSystemTheme();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 backdrop-blur-md">
        <div className="mx-auto w-full max-w-5xl px-2 sm:px-4 py-2 flex items-center gap-2 sm:gap-4">
          <span className="text-xl sm:text-2xl select-none" aria-hidden>
            🦞
          </span>
          <Tabs
            value={section}
            onValueChange={(v) => setSection(v as Section)}
          >
            <TabsList>
              {NAV.map(({ id, label, Icon }) => (
                <TabsTrigger key={id} value={id}>
                  <span className="inline-flex items-center gap-1.5">
                    <Icon size={16} />
                    {label}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-0 sm:px-4 py-3 sm:py-6">
        {section === "home" ? <HomeSection /> : null}
        {section === "chats" ? <ChatsSection /> : null}
        {section === "routines" ? <RoutinesSection /> : null}
        {section === "settings" ? <SettingsSection /> : null}
      </main>
    </div>
  );
}
