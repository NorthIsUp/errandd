import type { ReactNode } from "react";
import type { AsyncState } from "../useAsync";
import { Empty, ErrorBanner, Loader } from "./Loader";

/**
 * Renders the standard loading/error/empty triplet around a `useAsync`
 * result, calling `children(data)` only when data is present.
 *
 * Replaces the boilerplate:
 *   {state.loading && <Loader />}
 *   {state.error && <ErrorBanner error={state.error} />}
 *   {state.data && <X data={state.data} />}
 *
 * Pass `empty` for the "data resolved but is array-empty" case. The default
 * `isEmpty` predicate treats `[]` and `null` as empty.
 */
export function Async<T>({
  state,
  children,
  empty,
  isEmpty,
  loadingLabel,
}: {
  state: AsyncState<T>;
  children: (data: T) => ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  loadingLabel?: string;
}) {
  if (state.loading && state.data === null) {
    return loadingLabel ? <Loader label={loadingLabel} /> : <Loader />;
  }
  if (state.error) {
    return <ErrorBanner error={state.error} />;
  }
  if (state.data === null) {
    return null;
  }
  const isEmptyFn = isEmpty ?? defaultIsEmpty;
  if (empty && isEmptyFn(state.data)) {
    return <Empty>{empty}</Empty>;
  }
  return <>{children(state.data)}</>;
}

function defaultIsEmpty(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  return false;
}
