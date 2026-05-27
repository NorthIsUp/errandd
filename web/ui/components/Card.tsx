import type { ReactNode } from "react";

export function Card({
  title,
  actions,
  children,
  className = "",
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card bg-base-100 shadow-sm border border-base-300 ${className}`}>
      {(title || actions) && (
        <div className="card-body px-3 sm:px-4 pt-3 sm:pt-4 pb-2 flex-row items-center justify-between gap-2">
          {title && <h2 className="card-title text-base">{title}</h2>}
          {actions && <div className="flex items-center gap-1 ml-auto">{actions}</div>}
        </div>
      )}
      <div className="card-body px-3 sm:px-4 pt-2 pb-3 sm:pb-4">{children}</div>
    </section>
  );
}
