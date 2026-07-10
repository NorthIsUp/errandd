import { CheckCircle2, CircleSlash, ShieldOff } from "lucide-react";
import {
  type Delivery,
  getReceiverStatus,
  listDeliveries,
  listTriggers,
  type PrTrigger,
  type ReceiverStatus,
} from "../../api/hooks";
import { Card } from "../components/Card";
import { Empty, ErrorBanner, Loader } from "../components/Loader";
import { PageHeader } from "../components/PageHeader";
import { ReceiverCard } from "../components/ReceiverCard";
import { useAsync } from "../useAsync";

export function HooksSection() {
  const status = useAsync<ReceiverStatus>(() => getReceiverStatus());
  const deliveries = useAsync<{ deliveries: Delivery[] }>(() => listDeliveries());
  const triggers = useAsync<{ triggers: PrTrigger[] }>(() => listTriggers());

  return (
    <>
      <PageHeader
        title="Hooks"
        crumbs={[{ label: "Hooks" }]}
        actions={
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              status.reload();
              deliveries.reload();
              triggers.reload();
            }}
          >
            Refresh
          </button>
        }
      />

      {/* Receiver config (URL + secret) is a configure-once thing — keep
          it collapsed by default so live data (triggers + deliveries)
          gets the real estate. The summary still surfaces the
          signature-mode badge so a quick glance shows whether the
          receiver is in verifying or unsigned mode. */}
      <details className="collapse collapse-arrow border border-base-300 bg-base-100">
        <summary className="collapse-title text-sm font-medium">
          GitHub receiver
          {status.data && (
            <span className="ml-2 align-middle">
              {status.data.configured ? (
                <span className="badge badge-success badge-sm gap-1">
                  <CheckCircle2 size={10} /> signatures verified
                </span>
              ) : (
                <span className="badge badge-warning badge-sm gap-1">
                  <ShieldOff size={10} /> unsigned mode
                </span>
              )}
            </span>
          )}
        </summary>
        <div className="collapse-content">
          {status.loading && <Loader />}
          {status.error ? <ErrorBanner error={status.error} /> : null}
          {status.data && <ReceiverCard status={status.data} />}
        </div>
      </details>

      <Card title={`PR triggers (${triggers.data?.triggers.length ?? 0})`}>
        {triggers.loading && <Loader />}
        {triggers.error ? <ErrorBanner error={triggers.error} /> : null}
        {triggers.data?.triggers.length === 0 && (
          <Empty>
            No jobs have an <code>on.pr</code> block yet. Add one to a routine&rsquo;s YAML
            frontmatter.
          </Empty>
        )}
        {triggers.data && triggers.data.triggers.length > 0 && (
          <TriggerList triggers={triggers.data.triggers} />
        )}
      </Card>

      <Card title={`Recent deliveries (${deliveries.data?.deliveries.length ?? 0})`}>
        {deliveries.loading && <Loader />}
        {deliveries.error ? <ErrorBanner error={deliveries.error} /> : null}
        {deliveries.data?.deliveries.length === 0 && (
          <Empty>No webhooks received yet. Configure GitHub to POST to the URL above.</Empty>
        )}
        {deliveries.data && deliveries.data.deliveries.length > 0 && (
          <DeliveryList deliveries={deliveries.data.deliveries} />
        )}
      </Card>
    </>
  );
}

function TriggerList({ triggers }: { triggers: PrTrigger[] }) {
  return (
    <ul className="divide-y divide-base-300 -mx-2 text-sm">
      {triggers.map((t) => (
        <li
          key={`${t.job}::${Array.isArray(t.repo) ? t.repo.join(",") : t.repo}::${t.user.join(",")}::${t.action.join(",")}`}
          className="px-2 py-2 min-w-0"
        >
          <div className="flex items-baseline justify-between gap-2 min-w-0">
            <span className="font-mono font-medium truncate">{t.job}</span>
            <span className="text-[11px] text-base-content/60">PR</span>
          </div>
          <div className="text-xs text-base-content/70 truncate">
            <span className="opacity-60">repo: </span>
            <span className="font-mono">{Array.isArray(t.repo) ? t.repo.join(", ") : t.repo}</span>
          </div>
          <div className="text-xs text-base-content/70 truncate">
            <span className="opacity-60">user: </span>
            <span className="font-mono">{t.user.join(", ")}</span>
          </div>
          {t.branch.length > 0 && t.branch[0] !== "*" && (
            <div className="text-xs text-base-content/70 truncate">
              <span className="opacity-60">branch: </span>
              <span className="font-mono">{t.branch.join(", ")}</span>
            </div>
          )}
          {t.labels.length > 0 && (
            <div className="text-xs text-base-content/70 truncate">
              <span className="opacity-60">labels: </span>
              <span className="font-mono">{t.labels.join(", ")}</span>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}


function DeliveryList({ deliveries }: { deliveries: Delivery[] }) {
  return (
    <ul className="divide-y divide-base-300 -mx-2">
      {deliveries.map((d) => (
        <li key={d.id} className="px-2 py-2 min-w-0">
          <div className="flex items-baseline justify-between gap-2 min-w-0">
            <span className="font-mono font-medium truncate">{d.event}</span>
            <span className="text-xs text-base-content/60 tabular-nums shrink-0">
              {new Date(d.receivedAt).toLocaleString()}
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-2 min-w-0">
            <span className="text-sm text-base-content/80 truncate">{d.summary}</span>
            <DeliveryStatus status={d.status} />
          </div>
          <div className="text-xs mt-0.5 flex items-center gap-1.5">
            {d.matched.length > 0 ? (
              <>
                <span className="badge badge-success badge-xs gap-1">
                  <CheckCircle2 size={10} /> fired
                </span>
                <span className="text-base-content/60 truncate">
                  → {d.matched.join(", ")}
                </span>
              </>
            ) : d.status === "ok" ? (
              // The delivery was accepted but no job's on: rules matched.
              // Could be "no job opted in for this event" or "matched the
              // event class but a sub-rule filtered it out" — receiver
              // doesn't surface that distinction yet, so we collapse both
              // into "no match" for now. (Distinguishing filtered vs
              // unmatched is a follow-up — see hooks/receiver.ts.)
              <span className="badge badge-ghost badge-xs gap-1">
                <CircleSlash size={10} /> no match
              </span>
            ) : null}
          </div>
          <details className="mt-1">
            <summary className="cursor-pointer text-[11px] text-base-content/60">payload</summary>
            <pre className="mt-1 bg-base-200 border border-base-300 rounded-box px-2 py-1 overflow-x-auto font-mono text-[11px] max-h-48 overflow-y-auto">
              {d.payloadSnippet || "(empty)"}
            </pre>
          </details>
        </li>
      ))}
    </ul>
  );
}

function DeliveryStatus({ status }: { status: Delivery["status"] }) {
  if (status === "ok") {
    return <span className="badge badge-success badge-xs">ok</span>;
  }
  if (status === "duplicate") {
    return <span className="badge badge-ghost badge-xs">duplicate</span>;
  }
  if (status === "bad-signature") {
    return <span className="badge badge-error badge-xs">bad signature</span>;
  }
  if (status === "missing-secret") {
    return <span className="badge badge-warning badge-xs">no secret</span>;
  }
  return <span className="badge badge-error badge-xs">error</span>;
}

