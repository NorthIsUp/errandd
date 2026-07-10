import { type ReactNode, useEffect, useState } from "react";

export interface PageHeaderState {
  title: ReactNode;
  actions: ReactNode | null;
  crumbs: ReactNode | null;
}

let current: PageHeaderState = { title: null, actions: null, crumbs: null };
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) {
    l();
  }
}

export function setPageHeader(next: PageHeaderState): void {
  current = next;
  emit();
}

export function usePageHeaderValue(): PageHeaderState {
  // eslint-disable-next-line @eslint-react/use-state -- force-rerender counter; the value is intentionally discarded
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return current;
}

export function useRegisterPageHeader(state: PageHeaderState): void {
  // Register on every render. Cheap (just object identity swap + emit) and
  // avoids needing callers to memoize their JSX.
  useEffect(() => {
    setPageHeader(state);
    return () => {
      setPageHeader({ title: null, actions: null, crumbs: null });
    };
    // re-run when any visible portion changes
  }, [state.title, state.actions, state.crumbs, state]);
}
