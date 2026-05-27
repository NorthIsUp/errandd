import { type ReactNode, useEffect } from "react";
import { setPageHeader } from "../pageHeader";
import { Breadcrumbs, type Crumb } from "./Breadcrumbs";

/**
 * Registers this page's title + actions into the global header slot rendered
 * by App. Optionally renders breadcrumbs inline beneath the global header.
 */
export function PageHeader({
  title,
  crumbs,
  actions,
}: {
  title: ReactNode;
  crumbs: Crumb[];
  actions?: ReactNode;
}) {
  useEffect(() => {
    setPageHeader({ title, actions: actions ?? null, crumbs: null });
    return () => {
      setPageHeader({ title: null, actions: null, crumbs: null });
    };
  }, [title, actions]);

  if (crumbs.length <= 1) {
    return null;
  }
  return (
    <div className="-mt-1">
      <Breadcrumbs crumbs={crumbs} />
    </div>
  );
}
