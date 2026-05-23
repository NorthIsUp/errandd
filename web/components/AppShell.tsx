import { Sidebar } from "@pikoloo/darwin-ui";
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
 * AppShell — owns the global layout.
 *
 * Desktop: Darwin Sidebar renders a left rail (200px expanded / 56px collapsed)
 *          with built-in collapse toggle. Brand 🦞 and GitFooter are rendered
 *          outside the Sidebar in the same flex column (Darwin has no brand/footer slot).
 *
 * Mobile: Darwin Sidebar renders a hamburger button (top-right fixed) that
 *         slides in a full-height nav panel. Our custom Drawer is no longer needed.
 *
 * The 🦞 brand wiggle animation is kept in AppShell.module.css (just the keyframe).
 */
export function AppShell({ children }: Props) {
  const { section, setHash } = useHash();
  const brandRef = useRef<HTMLButtonElement>(null);

  const wiggle = () => {
    const el = brandRef.current;
    if (!el) return;
    // biome-ignore lint/style/noNonNullAssertion: CSS module class guaranteed to exist
    el.classList.remove(styles.brandWiggle!);
    // force reflow so animation restarts on rapid re-clicks
    void el.offsetWidth;
    // biome-ignore lint/style/noNonNullAssertion: CSS module class guaranteed to exist
    el.classList.add(styles.brandWiggle!);
  };

  // Map section id → label for Darwin Sidebar's activeItem matching
  const activeLabel =
    NAV_ITEMS.find((item) => item.id === section)?.label ?? "Home";

  const sidebarItems = NAV_ITEMS.map((item) => ({
    label: item.label,
    onClick: () => setHash(item.id),
    icon: item.Icon,
  }));

  return (
    <div className={styles.shell}>
      {/* Brand — above Darwin Sidebar (Darwin has no brand slot) */}
      <button
        ref={brandRef}
        type="button"
        className={styles.brand}
        onClick={wiggle}
        aria-label="ClaudeClaw"
      >
        🦞
      </button>

      {/* Darwin Sidebar — owns desktop rail + mobile hamburger + slide-in nav */}
      <Sidebar
        items={sidebarItems}
        activeItem={activeLabel}
        onLogout={() => {
          /* no logout in ClaudeClaw */
        }}
        collapsible
        glass
      />

      {/* GitFooter — below Darwin Sidebar (Darwin has no footer slot) */}
      <div className={styles.gitFooterWrap}>
        <GitFooter />
      </div>

      {/* Main content area */}
      <main className={styles.sectionHost}>{children}</main>
    </div>
  );
}
