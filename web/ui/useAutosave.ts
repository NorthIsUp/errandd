import { useEffect, useRef, useState } from "react";

export type AutosaveStatus = "idle" | "saving" | "saved" | "error";

/**
 * Debounced autosave hook. Watches `value`; after `delayMs` of no further
 * changes, calls `save(value)`. The first value (initial sync from server) is
 * skipped. Errors are captured into `status` + `error`.
 *
 * `enabled` lets callers gate the save (e.g. don't autosave while the form
 * is still hydrating).
 */
export function useAutosave<T>(
  value: T,
  save: (v: T) => Promise<void>,
  options: { delayMs?: number; enabled?: boolean } = {},
): { status: AutosaveStatus; error: unknown } {
  const { delayMs = 600, enabled = true } = options;
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const [error, setError] = useState<unknown>(null);
  const lastSentRef = useRef<T | undefined>(undefined);
  const firstSeenRef = useRef(false);
  // Latest-`save` ref, updated in an effect (not during render) per
  // react-hooks/refs; the debounce effect below reads saveRef.current.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (!firstSeenRef.current) {
      // Adopt the initial value as the baseline; don't save it.
      firstSeenRef.current = true;
      lastSentRef.current = value;
      return;
    }
    // Bail if nothing changed (deep-ish: JSON identity check).
    if (jsonEqual(lastSentRef.current, value)) {
      return;
    }
    const handle = setTimeout(() => {
      void (async () => {
        setStatus("saving");
        setError(null);
        try {
          await saveRef.current(value);
          lastSentRef.current = value;
          setStatus("saved");
        } catch (e) {
          setError(e);
          setStatus("error");
        }
      })();
    }, delayMs);
    return () => clearTimeout(handle);
  }, [value, enabled, delayMs]);

  return { status, error };
}

function jsonEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
