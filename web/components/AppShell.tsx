import { FolderOpen, Home, Menu, MessageSquare, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { useHash } from "../hooks/useHash";
import { useMediaQuery } from "../hooks/useMediaQuery";
import styles from "./AppShell.module.css";
import { Drawer } from "./Drawer";
import { GitFooter } from "./GitFooter";
import { IconButton } from "./IconButton";

interface NavItem {
  id: "home" | "chats" | "jobs" | "settings";
  label: string;
  Icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
}

const NAV_ITEMS: NavItem[] = [
  { id: "home", label: "Home", Icon: Home },
  { id: "chats", label: "Chats", Icon: MessageSquare },
  { id: "jobs", label: "Jobs", Icon: FolderOpen },
  { id: "settings", label: "Settings", Icon: Settings },
];

interface Props {
  children: ReactNode;
}

function NavItems({
  section,
  setHash,
  onSelect,
}: {
  section: string;
  setHash: (id: "home" | "chats" | "jobs" | "settings") => void;
  onSelect?: () => void;
}) {
  return (
    <>
      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={[
            styles.navBtn,
            section === item.id ? styles.navBtnActive : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-label={item.label}
          aria-current={section === item.id ? "page" : undefined}
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
      ))}
    </>
  );
}

/**
 * AppShell is the SOLE owner of:
 * - The left rail (desktop >760px): brand, nav buttons, GitFooter.
 * - The burger button (mobile ≤760px): fixed top-left, opens the drawer.
 * - The slide-out Drawer (mobile): contains same nav + GitFooter.
 *
 * The shell never adds top-padding to children for the burger — that is
 * SectionFrame's responsibility.
 */
export function AppShell({ children }: Props) {
  const { section, setHash } = useHash();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Conditionally render the burger ONLY on mobile so it can never appear next
  // to the desktop rail (display:none alone leaked due to IconButton specificity).
  const isMobile = useMediaQuery("(max-width: 760px)");
  const brandRef = useRef<HTMLButtonElement>(null);
  const wiggle = () => {
    const el = brandRef.current;
    if (!el) return;
    const wiggleCls = styles.brandWiggle ?? "brand-wiggle";
    el.classList.remove(wiggleCls);
    // force reflow so the animation restarts even on rapid re-clicks
    void el.offsetWidth;
    el.classList.add(wiggleCls);
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
        <NavItems section={section} setHash={setHash} />
        <GitFooter />
      </nav>

      {/* Mobile burger — shell owns it, SectionFrame handles the safe-area */}
      {isMobile && (
        <IconButton
          label="Open navigation"
          size="lg"
          variant="ghost"
          className={styles.burger}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <Menu size={22} />
        </IconButton>
      )}

      {/* Mobile drawer */}
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Navigation"
      >
        <div className={styles.drawerInner}>
          <div className={styles.drawerBrand} aria-hidden="true">
            🦞
          </div>
          <NavItems
            section={section}
            setHash={setHash}
            onSelect={() => setDrawerOpen(false)}
          />
          <GitFooter />
        </div>
      </Drawer>

      {/* Main content area */}
      <main className={styles.sectionHost}>{children}</main>
    </div>
  );
}
