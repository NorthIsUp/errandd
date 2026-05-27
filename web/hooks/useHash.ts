import { useCallback, useEffect, useState } from "react";

const VALID_SECTIONS = ["home", "chats", "routines", "settings"] as const;
export type Section = (typeof VALID_SECTIONS)[number];

export interface HashState {
  section: Section;
  params: URLSearchParams;
}

function parseHash(): HashState {
  const raw = window.location.hash.slice(1);
  const qIdx = raw.indexOf("?");
  const sectionStr = qIdx === -1 ? raw : raw.slice(0, qIdx);
  const section: Section = (VALID_SECTIONS as readonly string[]).includes(
    sectionStr,
  )
    ? (sectionStr as Section)
    : "home";
  const params =
    qIdx === -1
      ? new URLSearchParams()
      : new URLSearchParams(raw.slice(qIdx + 1));
  return { section, params };
}

function writeHash(section: Section, params: URLSearchParams): void {
  const qs = params.toString();
  window.location.hash = qs ? `${section}?${qs}` : section;
}

export function useHash() {
  const [state, setState] = useState<HashState>(parseHash);

  useEffect(() => {
    function onHashChange() {
      setState(parseHash());
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const setSection = useCallback((name: Section) => {
    writeHash(name, new URLSearchParams());
  }, []);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(state.params);
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
      writeHash(state.section, next);
    },
    [state],
  );

  return { ...state, setSection, setParam };
}
