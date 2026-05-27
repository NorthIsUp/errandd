import { AlertTriangle, CheckCircle2, Copy, Eye, EyeOff, ShieldOff } from "lucide-react";
import { useState } from "react";
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

      <Card title="GitHub receiver">
        {status.loading && <Loader />}
        {status.error ? <ErrorBanner error={status.error} /> : null}
        {status.data && <ReceiverCard status={status.data} />}
      </Card>

      <Card title={`PR triggers (${triggers.data?.triggers.length ?? 0})`}>
        {triggers.loading && <Loader />}
        {triggers.error ? <ErrorBanner error={triggers.error} /> : null}
        {triggers.data && triggers.data.triggers.length === 0 && (
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
        {deliveries.data && deliveries.data.deliveries.length === 0 && (
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

function ReceiverCard({ status }: { status: ReceiverStatus }) {
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [revealed, setRevealed] = useState(false);

  async function copy(value: string, setter: (b: boolean) => void) {
    try {
      await navigator.clipboard.writeText(value);
      setter(true);
      setTimeout(() => setter(false), 1500);
    } catch {
      // Clipboard API may be unavailable on insecure origins.
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-2 mb-1">
          {status.configured ? (
            <span className="badge badge-success gap-1">
              <CheckCircle2 size={12} /> verifying signatures
            </span>
          ) : (
            <span className="badge badge-warning gap-1">
              <ShieldOff size={12} /> unsigned mode
            </span>
          )}
        </div>

        <div className="join w-full">
          <input
            readOnly
            value={status.url}
            className="input input-bordered input-sm join-item flex-1 font-mono text-xs"
            aria-label="Webhook URL"
          />
          <button
            type="button"
            className="btn btn-sm join-item"
            onClick={() => copy(status.url, setCopiedUrl)}
          >
            <Copy size={14} />
            {copiedUrl ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="text-[11px] text-base-content/60 mt-1">
          Set this as the Payload URL in GitHub. Content type:{" "}
          <code className="font-mono">application/json</code>.
        </p>
      </div>

      <div>
        <div className="text-xs text-base-content/70 mb-1">
          Secret <span className="opacity-60">(from <code className="font-mono">CLAWDCODE_GITHUB_WEBHOOK_SECRET</code>)</span>
        </div>
        {status.configured ? (
          <div className="join w-full">
            <input
              readOnly
              type={revealed ? "text" : "password"}
              value={status.secret}
              className="input input-bordered input-sm join-item flex-1 font-mono text-xs"
              aria-label="Webhook secret"
            />
            <button
              type="button"
              className="btn btn-sm join-item"
              onClick={() => setRevealed((r) => !r)}
              aria-pressed={revealed}
            >
              {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
              {revealed ? "Hide" : "Reveal"}
            </button>
            <button
              type="button"
              className="btn btn-sm join-item"
              onClick={() => copy(status.secret, setCopiedSecret)}
            >
              <Copy size={14} />
              {copiedSecret ? "Copied" : "Copy"}
            </button>
          </div>
        ) : (
          <p className="text-[11px] text-base-content/60">
            Env var not set — deliveries accepted without signature verification. To enforce signing,
            set <code className="font-mono">CLAWDCODE_GITHUB_WEBHOOK_SECRET</code> and restart the
            daemon.
          </p>
        )}
      </div>

      <div className="text-xs text-base-content/70">
        <span className="opacity-70">Last event: </span>
        {status.lastEventAt ? (
          <>
            <span className="font-mono">{status.lastEvent}</span>
            <span> · </span>
            <time dateTime={new Date(status.lastEventAt).toISOString()}>
              {new Date(status.lastEventAt).toLocaleString()}
            </time>
          </>
        ) : (
          <span className="italic">none</span>
        )}
      </div>

      {!isPubliclyReachable() && (
        <div className="alert alert-warning text-xs">
          <AlertTriangle size={14} />
          <span>
            Daemon is bound to a non-public address. GitHub can&rsquo;t reach localhost; expose it
            via cloudflared / ngrok / a reverse proxy before adding the webhook.
          </span>
        </div>
      )}

      <details className="text-xs">
        <summary className="cursor-pointer text-base-content/70">Test from curl</summary>
        <pre className="mt-2 bg-base-200 border border-base-300 rounded-box px-3 py-2 overflow-x-auto font-mono text-[11px]">{`SECRET=$CLAWDCODE_GITHUB_WEBHOOK_SECRET
BODY='{"zen":"hello"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | cut -d' ' -f2)
curl -sS -X POST "${status.url}" \\
  -H 'Content-Type: application/json' \\
  -H 'X-GitHub-Event: ping' \\
  -H "X-GitHub-Delivery: $(uuidgen)" \\
  -H "X-Hub-Signature-256: sha256=$SIG" \\
  --data "$BODY"`}</pre>
      </details>
    </div>
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
          {d.matched.length > 0 && (
            <div className="text-xs text-base-content/60 mt-0.5">
              matched: {d.matched.join(", ")}
            </div>
          )}
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

function isPubliclyReachable(): boolean {
  const host = location.hostname;
  if (host === "localhost") {
    return false;
  }
  if (/^127\./.test(host)) {
    return false;
  }
  if (/^10\./.test(host)) {
    return false;
  }
  if (/^192\.168\./.test(host)) {
    return false;
  }
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) {
    return false;
  }
  return true;
}
