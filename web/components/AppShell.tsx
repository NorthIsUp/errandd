import { Tabs, TabsList, TabsTrigger, useToast } from "@pikoloo/darwin-ui";
import { FolderOpen, Home, MessageSquare, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { useRef } from "react";
import { useHash } from "../hooks/useHash";
import styles from "./AppShell.module.css";
import { AppShellProvider, useAppShellSlot } from "./AppShellContext";
import { GitFooter } from "./GitFooter";

type Section = "home" | "chats" | "jobs" | "settings";

const NAV_ITEMS = [
  { id: "home" as Section, label: "Home", Icon: Home },
  { id: "chats" as Section, label: "Chats", Icon: MessageSquare },
  { id: "jobs" as Section, label: "Jobs", Icon: FolderOpen },
  { id: "settings" as Section, label: "Settings", Icon: Settings },
] as const;

interface Props {
  children: ReactNode;
}

function AppShellInner({ children }: Props) {
  const { section, setHash } = useHash();
  const { showToast } = useToast();
  const brandRef = useRef<HTMLButtonElement>(null);
  const slot = useAppShellSlot();

  const wiggle = () => {
    const el = brandRef.current;
    if (!el) return;
    const cls = styles.brandWiggle;
    if (!cls) return;
    el.classList.remove(cls);
    void el.offsetWidth; // restart on rapid clicks
    el.classList.add(cls);
  };

  // showToast is referenced to keep it available if needed in future, suppress lint
  void showToast;

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        {/* Brand */}
        <button
          ref={brandRef}
          type="button"
          className={styles.brand}
          onClick={wiggle}
          aria-label="ClaudeClaw"
        >
          🦞
        </button>

        {/* Top-level nav tabs */}
        <Tabs
          value={section}
          onValueChange={(v) => setHash(v as Section)}
          {...(styles.navTabs ? { className: styles.navTabs } : {})}
        >
          <TabsList>
            {NAV_ITEMS.map(({ id, label, Icon }) => (
              <TabsTrigger key={id} value={id}>
                <Icon size={16} />
                <span className={styles.tabLabel}>{label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {/* Right-side: section actions + git sha */}
        <div className={styles.topbarRight}>
          {slot?.actions != null && (
            <div className={styles.sectionActions}>{slot.actions}</div>
          )}
          <GitFooter />
        </div>
      </header>

      <main className={styles.sectionHost}>{children}</main>
    </div>
  );
}

export function AppShell({ children }: Props) {
  return (
    <AppShellProvider>
      <AppShellInner>{children}</AppShellInner>
    </AppShellProvider>
  );
}
