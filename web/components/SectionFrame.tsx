import type { ReactNode } from "react";
import { useContext, useEffect } from "react";
import { AppShellContext } from "./AppShellContext";
import styles from "./SectionFrame.module.css";

interface Props {
  /** @deprecated Title is no longer shown in the topbar — tabs replace it. Kept for back-compat. */
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
}

/**
 * SectionFrame — registers section actions into the AppShell topbar
 * (via AppShellContext) and provides the scrollable body region.
 *
 * `title` is accepted for back-compat but ignored — the active tab
 * communicates which section is open.
 */
export function SectionFrame({ actions, children, bodyClassName }: Props) {
  const { setSlot } = useContext(AppShellContext);

  useEffect(() => {
    setSlot({ actions: actions ?? null });
    return () => {
      setSlot(null);
    };
  }, [setSlot, actions]);

  return (
    <div className={styles.frame}>
      <div className={[styles.body, bodyClassName].filter(Boolean).join(" ")}>
        {children}
      </div>
    </div>
  );
}
