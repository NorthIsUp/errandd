import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Run an async function on mount + whenever `key` changes.
 *
 * `reload()` bumps an internal counter that's included in the effect's deps,
 * so the request re-fires without us having to call the closure ourselves
 * from outside the effect (which would otherwise need refs).
 */
export function useAsync<T>(fn: () => Promise<T>, key = ""): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  // Keep the latest `fn` in a ref so callers can pass inline closures without
  // re-firing the effect every render (which would loop forever as the effect
  // calls setState). The effect only re-runs on `key` / `nonce` changes. The
  // ref is updated in an effect (not during render) per react-hooks/refs; it
  // runs before the fetch effect below on every commit, so the fetch always
  // sees the latest closure.
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fnRef
      .current()
      .then((v) => {
        if (cancelled) {
          return;
        }
        setData(v);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) {
          return;
        }
        setError(e);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key, nonce]);

  return { data, error, loading, reload };
}
