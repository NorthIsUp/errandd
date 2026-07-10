import type { ReactNode } from "react";
import type { AsyncState } from "../useAsync";
import { Async } from "./Async";
import { Card } from "./Card";

/**
 * `Card` + `Async` combined. Collapses the very common shape:
 *
 *   <Card title="X" actions={...}>
 *     {state.loading && <Loader />}
 *     {state.error && <ErrorBanner error={state.error} />}
 *     {state.data && state.data.length === 0 && <Empty>...</Empty>}
 *     {state.data && <Inner data={state.data} />}
 *   </Card>
 *
 * into:
 *
 *   <AsyncCard title="X" actions={...} state={state} empty="No items">
 *     {(data) => <Inner data={data} />}
 *   </AsyncCard>
 */
export function AsyncCard<T>({
  title,
  actions,
  state,
  empty,
  isEmpty,
  loadingLabel,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  state: AsyncState<T>;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  loadingLabel?: string;
  children: (data: T) => ReactNode;
  className?: string;
}) {
  return (
    <Card title={title} actions={actions} className={className ?? ""}>
      <Async
        state={state}
        {...(empty !== undefined ? { empty } : {})}
        {...(isEmpty ? { isEmpty } : {})}
        {...(loadingLabel ? { loadingLabel } : {})}
      >
        {children}
      </Async>
    </Card>
  );
}
