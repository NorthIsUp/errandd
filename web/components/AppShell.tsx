import { Sidebar, useToast } from "@pikoloo/darwin-ui";
import { FolderOpen, Home, MessageSquare, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { useRef } from "react";
import { useHash } from "../hooks/useHash";
import styles from "./AppShell.module.css";
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

/**
 * AppShell — Darwin Sidebar for nav + a minimal hand-rolled topbar for brand/footer.
 *
 * We intentionally do NOT use Darwin's Topbar here.  Darwin's Topbar always
 * renders its own mobile hamburger button regardless of items=[].  Darwin's
 * Sidebar also renders its own mobile hamburger (upper-right, md:hidden).
 * Using both components together produces two hamburgers on mobile.
 *
 * Solution: replace the Topbar with a simple <header> element that carries
 * only the brand 🦞 and the git footer — no mobile hamburger of its own.
 * Darwin Sidebar remains the single source of mobile nav.
 *
 * On mobile (≤767px) the Sidebar's burger is `fixed right-2 top-2 z-50`.
 * We override it to sit in the upper-left instead via the .sidebarBurgerLeft
 * CSS rule in AppShell.module.css.
 */
export function AppShell({ children }: Props) {
  const { section, setHash } = useHash();
  const { showToast } = useToast();
  const brandRef = useRef<HTMLButtonElement>(null);

  const wiggle = () => {
    const el = brandRef.current;
    if (!el) return;
    const cls = styles.brandWiggle;
    if (!cls) return;
    el.classList.remove(cls);
    void el.offsetWidth; // restart on rapid clicks
    el.classList.add(cls);
  };

  const sidebarItems = NAV_ITEMS.map((item) => ({
    label: item.label,
    onClick: () => setHash(item.id),
    icon: item.Icon,
  }));

  const activeLabel =
    NAV_ITEMS.find((item) => item.id === section)?.label ?? "Home";

  return (
    <div className={styles.shell}>
      {/* Simple brand bar — no Darwin Topbar so no second mobile burger */}
      <header className={styles.topbar}>
        <button
          ref={brandRef}
          type="button"
          className={styles.brand}
          onClick={wiggle}
          aria-label="ClaudeClaw"
        >
          🦞
        </button>
        <div className={styles.topbarActions}>
          <GitFooter />
        </div>
      </header>

      <div className={styles.bodyRow}>
        {/* Sidebar — Darwin's nav rail. Its mobile burger is the ONLY burger.
            CSS in this module moves it from right-2 to left-2. */}
        <div className={styles.sidebarWrap}>
          <Sidebar
            items={sidebarItems}
            activeItem={activeLabel}
            onLogout={() => {
              showToast("Daemon-managed session — no logout flow.", {
                type: "info",
                title: "FYI",
                duration: 2500,
              });
            }}
            collapsible
            glass
          />
        </div>

        <main className={styles.sectionHost}>{children}</main>
      </div>
    </div>
  );
}
