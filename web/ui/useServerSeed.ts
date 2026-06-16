import { type Dispatch, type SetStateAction, useState } from "react";
import type { AsyncState } from "./useAsync";

/**
 * Seed a piece of local form state from server data **exactly once per fetch**.
 *
 * The common pattern: an async source returns `data`, and a panel needs a
 * mutable local copy (a draft) the user can edit. We want to overwrite the
 * draft when the server hands us a fresh payload (e.g. after `reload()`),
 * but not on every render — otherwise the user's in-flight edits get
 * clobbered.
 *
 * Returns `[draft, setDraft]` so callers behave like a normal `useState`.
 * Until the server's first successful response, `draft` is `null`.
 */
export function useServerSeed<T, D>(
  state: AsyncState<T>,
  mapper: (data: T) => D,
): [D | null, Dispatch<SetStateAction<D | null>>] {
  const [draft, setDraft] = useState<D | null>(null);
  const [seen, setSeen] = useState<T | null>(null);
  if (state.data && state.data !== seen) {
    setSeen(state.data);
    setDraft(mapper(state.data));
  }
  return [draft, setDraft];
}
