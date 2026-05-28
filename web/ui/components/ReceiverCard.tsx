import { AlertTriangle, CheckCircle2, Copy, Eye, EyeOff, ShieldOff } from "lucide-react";
import { useState } from "react";
import type { ReceiverStatus } from "../../api/hooks";

/**
 * Receiver setup card — webhook URL + secret + curl test snippet.
 *
 * Extracted from the (now-retired) Hooks page so it can live under
 * Settings alongside the rest of the pod's configuration. The legacy
 * HooksSection still imports it for the back-compat /hooks/ route.
 */
export function ReceiverCard({ status }: { status: ReceiverStatus }) {
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
          Secret{" "}
          <span className="opacity-60">
            (from <code className="font-mono">CLAWDCODE_GITHUB_WEBHOOK_SECRET</code>)
          </span>
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

function isPubliclyReachable(): boolean {
  const host = location.hostname;
  if (host === "localhost") return false;
  if (/^127\./.test(host)) return false;
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return false;
  return true;
}
