import { Menu } from "lucide-react";
import { FolderOpen, Home, MessageSquare, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { useHash } from "../hooks/useHash";
import { useMediaQuery } from "../hooks/useMediaQuery";
import styles from "./AppShell.module.css";
import { Drawer } from "./Drawer";
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

interface NavListProps {
  section: Section;
  setHash: (id: Section) => void;
  onSelect?: () => void;
}

function NavList({ section, setHash, onSelect }: NavListProps) {
  return (
    <>
      {NAV_ITEMS.map((item) => {
        const active = section === item.id;
        return (
          <button
            key={item.id}
            type="button"
            className={`${styles.navBtn} ${active ? styles.navBtnActive : ""}`.trim()}
            aria-label={item.label}
            aria-current={active ? "page" : undefined}
            onClick={() => {
              setHash(item.id);
              onSelect?.();
            }}
          >
            <span className={styles.navBtnIcon}>
              <item.Icon size={20} strokeWidth={1.5} />
            </span>
            <span className={styles.navBtnLabel}>{item.label}</span>
          </button>
        );
      })}
    </>
  );
}

/**
 * AppShell — owns the global layout. Desktop: 72px left rail with brand →
 * nav buttons → GitFooter (`margin-top:auto`). Mobile (≤760px): rail hidden,
 * burger top-LEFT (fixed) opens a left side-sheet Drawer with the same nav +
 * GitFooter inside.
 *
 * Darwin's Sidebar component was tried and abandoned — it renders right-side,
 * always shows a Logout footer, and exposes no brand/footer slot.  Composing
 * our own rail out of Lucide icons + Darwin tokens keeps every primitive
 * inside Darwin's design language while letting us control layout.
 */
export function AppShell({ children }: Props) {
  const { section, setHash } = useHash();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isMobile = useMediaQuery("(max-width: 760px)");
  const brandRef = useRef<HTMLButtonElement>(null);

  const wiggle = () => {
    const el = brandRef.current;
    if (!el) return;
    const cls = styles.brandWiggle;
    if (!cls) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  };

  return (
    <div className={styles.shell}>
      {/* Desktop rail */}
      <nav className={styles.rail} aria-label="Main navigation">
        <button
          ref={brandRef}
          type="button"
          className={styles.brand}
          onClick={wiggle}
          aria-label="ClaudeClaw"
        >
          🦞
        </button>
        <NavList section={section} setHash={setHash} />
        <GitFooter />
      </nav>

      {/* Mobile burger — top-LEFT, conditional render so it never leaks onto desktop */}
      {isMobile && (
        <button
          type="button"
          className={styles.burger}
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <Menu size={22} />
        </button>
      )}

      {/* Mobile drawer — left side-sheet via the custom positioning in Drawer.tsx */}
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Navigation"
      >
        <div className={styles.drawerInner}>
          <div className={styles.drawerBrand} aria-hidden="true">
            🦞
          </div>
          <NavList
            section={section}
            setHash={setHash}
            onSelect={() => setDrawerOpen(false)}
          />
          <GitFooter />
        </div>
      </Drawer>

      <main className={styles.sectionHost}>{children}</main>
    </div>
  );
}
