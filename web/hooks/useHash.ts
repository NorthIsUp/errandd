import { useCallback, useEffect, useState } from "react";

const VALID_SECTIONS = ["home", "chats", "jobs", "settings"] as const;
type Section = (typeof VALID_SECTIONS)[number];

export interface HashState {
  section: Section;
  /** For `#jobs?file=X&repo=Y` — the `file` query param value (decoded). */
  file: string | null;
  /** For `#jobs?file=X&repo=Y` — the `repo` query param value (decoded). */
  repo: string | null;
}

/**
 * Parse the current URL hash into a structured HashState.
 *
 * Hash format: `#<section>[?<key>=<val>[&<key>=<val>...]]`
 * e.g. `#chats?id=abc123&closed=1`
 *      `#jobs?file=foo.md&repo=myrepo`
 *      `#settings?tab=model`
 */
function parseHash(): HashState {
  const raw = window.location.hash.slice(1); // strip leading '#'
  const qIdx = raw.indexOf("?");
  const sectionStr = qIdx === -1 ? raw : raw.slice(0, qIdx);
  const section: Section = (VALID_SECTIONS as readonly string[]).includes(
    sectionStr,
  )
    ? (sectionStr as Section)
    : "home";

  if (qIdx === -1) return { section, file: null, repo: null };

  const params = new URLSearchParams(raw.slice(qIdx + 1));
  return {
    section,
    file: params.get("file"),
    repo: params.get("repo"),
  };
}

/**
 * Parse just the query params from the current hash, returning a URLSearchParams.
 */
function getHashParams(): URLSearchParams {
  const raw = window.location.hash.slice(1);
  const qIdx = raw.indexOf("?");
  return qIdx === -1
    ? new URLSearchParams()
    : new URLSearchParams(raw.slice(qIdx + 1));
}

/**
 * Update a single key in the hash query string without changing section.
 * Pass `null` to remove the key.
 */
function setHashParam(key: string, value: string | null): void {
  const raw = window.location.hash.slice(1);
  const qIdx = raw.indexOf("?");
  const section = qIdx === -1 ? raw : raw.slice(0, qIdx);
  const params =
    qIdx === -1
      ? new URLSearchParams()
      : new URLSearchParams(raw.slice(qIdx + 1));
  if (value === null || value === "") {
    params.delete(key);
  } else {
    params.set(key, value);
  }
  const qs = params.toString();
  window.location.hash = qs ? `${section}?${qs}` : section;
}

export function useHash(): HashState & { setHash: (name: Section) => void } {
  const [state, setState] = useState<HashState>(parseHash);

  useEffect(() => {
    function onHashChange() {
      setState(parseHash());
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const setHash = useCallback((name: Section) => {
    // Navigate to new section, clearing all query params
    window.location.hash = name;
  }, []);

  return { ...state, setHash };
}

/**
 * Persist a single UI state key in the URL hash query string.
 *
 * Usage:
 *   const [tab, setTab] = useFragmentState("tab", "model");
 *
 * The value is stored as `#<section>?tab=model` — survives refresh.
 * Multiple keys are combined: `#chats?id=abc&closed=1`.
 *
 * @param key   - The query param key (e.g. "tab", "id", "closed")
 * @param defaultValue - Value to use when the key is absent from the URL
 */
export function useFragmentState(
  key: string,
  defaultValue: string,
): [string, (value: string) => void] {
  const [value, setValue] = useState<string>(() => {
    const params = getHashParams();
    return params.get(key) ?? defaultValue;
  });

  // Stay in sync when the hash changes externally (e.g. back/forward navigation)
  useEffect(() => {
    function onHashChange() {
      const params = getHashParams();
      setValue(params.get(key) ?? defaultValue);
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [key, defaultValue]);

  const set = useCallback(
    (next: string) => {
      setValue(next);
      setHashParam(key, next === defaultValue ? null : next);
    },
    [key, defaultValue],
  );

  return [value, set];
}
