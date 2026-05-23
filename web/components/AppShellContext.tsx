import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

interface AppShellSlot {
  actions: ReactNode | null;
}

interface AppShellContextValue {
  slot: AppShellSlot | null;
  setSlot: (slot: AppShellSlot | null) => void;
}

const AppShellContext = createContext<AppShellContextValue>({
  slot: null,
  setSlot: () => {},
});

export function AppShellProvider({ children }: { children: ReactNode }) {
  const [slot, setSlotState] = useState<AppShellSlot | null>(null);
  const setSlot = useCallback((next: AppShellSlot | null) => {
    setSlotState(next);
  }, []);
  const value = useMemo(() => ({ slot, setSlot }), [slot, setSlot]);
  return (
    <AppShellContext.Provider value={value}>
      {children}
    </AppShellContext.Provider>
  );
}

/**
 * Used by AppShell to read the active section's actions.
 */
export function useAppShellSlot(): AppShellSlot | null {
  return useContext(AppShellContext).slot;
}

/**
 * Used by sections to register their actions in the topbar.
 * Pass `null` for `actions` when the section has no per-section actions.
 */
export { AppShellContext };
