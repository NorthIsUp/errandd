import {
  AlertTriangle,
  Bug,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  GitPullRequest,
  LineChart,
  ShieldOff,
  Ticket,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ProviderReceiver, ReceiverStatus } from "../../api/hooks";

/**
 * Receiver setup card — one row per webhook provider (GitHub, Sentry,
 * Datadog), each with a configured badge, webhook URL (+ copy), a
 * reveal-able secret, and the env-var hint for where the secret comes from.
 *
 * Datadog gets two extras: the token-in-URL form (auth rides as `?token=`)
 * as the copy target, and a copy-paste block of the recommended Payload
 * template — Datadog payloads are user-defined, so matching depends on the
 * field names in that template.
 *
 * Falls back to the back-compat top-level GitHub fields when an older
 * daemon doesn't send the `providers` object.
 */
export function ReceiverCard({ status }: { status: ReceiverStatus }) {
  // Older daemons only send the top-level GitHub fields — synthesize a
  // providers object so the render path is uniform.
  const providers = status.providers ?? {
    github: {
      configured: status.configured,
      secret: status.secret,
      url: status.url,
      secretEnv: "CLAWDCODE_GITHUB_WEBHOOK_SECRET",
    },
    sentry: undefined,
    datadog: undefined,
    linear: undefined,
  };

  return (
    <div className="space-y-4">
      {providers.github && (
        <ProviderRow
          icon={<GitPullRequest size={14} className="opacity-70" />}
          name="GitHub"
          provider={providers.github}
          urlHint={
            <>
              Set this as the Payload URL in GitHub. Content type:{" "}
              <code className="font-mono">application/json</code>.
            </>
          }
        >
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
          <GithubCurlSnippet url={providers.github.url} />
        </ProviderRow>
      )}

      {providers.sentry && (
        <ProviderRow
          icon={<Bug size={14} className="opacity-70" />}
          name="Sentry"
          provider={providers.sentry}
          urlHint={
            <>
              Add this as an Internal Integration webhook URL in Sentry. Signatures are verified
              with the client secret.
            </>
          }
        />
      )}

      {providers.datadog && (
        <ProviderRow
          icon={<LineChart size={14} className="opacity-70" />}
          name="Datadog"
          provider={providers.datadog}
          // Datadog auth rides in the URL as ?token=, so copy the tokenUrl.
          copyUrl={providers.datadog.tokenUrl ?? providers.datadog.url}
          urlHint={
            <>
              Use this as the Datadog webhook URL — the <code className="font-mono">?token=</code>{" "}
              in the URL authenticates the delivery.
            </>
          }
        >
          {providers.datadog.recommendedPayload !== undefined && (
            <DatadogPayloadBlock payload={providers.datadog.recommendedPayload} />
          )}
        </ProviderRow>
      )}

      {providers.linear && (
        <ProviderRow
          icon={<Ticket size={14} className="opacity-70" />}
          name="Linear"
          provider={providers.linear}
          urlHint={
            <>
              Add this as a webhook URL in Linear (Settings → API → Webhooks). Linear provides the
              signing secret — set it as <code className="font-mono">CLAWDCODE_LINEAR_WEBHOOK_SECRET</code>.
            </>
          }
        >
          {providers.linear.botMention && (
            <p className="text-[11px] text-base-content/60">
              Routines with <code className="font-mono">on: linear</code> fire on tickets/comments
              that @mention <code className="font-mono">{providers.linear.botMention}</code> (from{" "}
              <code className="font-mono">{providers.linear.botMentionEnv}</code>; set{" "}
              <code className="font-mono">mention: false</code> on the rule to fire on any event).
            </p>
          )}
        </ProviderRow>
      )}

      {!isPubliclyReachable() && (
        <div className="alert alert-warning text-xs">
          <AlertTriangle size={14} />
          <span>
            Daemon is bound to a non-public address. Webhook providers can&rsquo;t reach localhost;
            expose it via cloudflared / ngrok / a reverse proxy before adding the webhook.
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ProviderRow({
  icon,
  name,
  provider,
  urlHint,
  copyUrl,
  children,
}: {
  icon: ReactNode;
  name: string;
  provider: ProviderReceiver;
  urlHint: ReactNode;
  /** Override the value placed in the URL field's copy button (Datadog
   *  copies the token-bearing URL). Defaults to provider.url. */
  copyUrl?: string;
  children?: ReactNode;
}) {
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const displayUrl = copyUrl ?? provider.url;

  return (
    <div className="rounded-box border border-base-300 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
          {icon}
          {name}
        </span>
        {provider.configured ? (
          <span className="badge badge-success badge-sm gap-1">
            <CheckCircle2 size={12} /> verifying signatures
          </span>
        ) : (
          <span className="badge badge-warning badge-sm gap-1">
            <ShieldOff size={12} /> unsigned mode
          </span>
        )}
      </div>

      <div>
        <div className="join w-full">
          <input
            readOnly
            value={displayUrl}
            className="input input-bordered input-sm join-item flex-1 font-mono text-xs"
            aria-label={`${name} webhook URL`}
          />
          <button
            type="button"
            className="btn btn-sm join-item"
            onClick={() => copy(displayUrl, setCopiedUrl)}
          >
            <Copy size={14} />
            {copiedUrl ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="text-[11px] text-base-content/60 mt-1">{urlHint}</p>
      </div>

      <div>
        <div className="text-xs text-base-content/70 mb-1">
          Secret{" "}
          <span className="opacity-60">
            (from <code className="font-mono">{provider.secretEnv}</code>)
          </span>
        </div>
        {provider.configured ? (
          <div className="join w-full">
            <input
              readOnly
              type={revealed ? "text" : "password"}
              value={provider.secret}
              className="input input-bordered input-sm join-item flex-1 font-mono text-xs"
              aria-label={`${name} webhook secret`}
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
              onClick={() => copy(provider.secret, setCopiedSecret)}
            >
              <Copy size={14} />
              {copiedSecret ? "Copied" : "Copy"}
            </button>
          </div>
        ) : (
          <p className="text-[11px] text-base-content/60">
            Env var not set — deliveries accepted without signature verification. To enforce
            signing, set <code className="font-mono">{provider.secretEnv}</code> and restart the
            daemon.
          </p>
        )}
      </div>

      {children}
    </div>
  );
}

function DatadogPayloadBlock({ payload }: { payload: unknown }) {
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(payload, null, 2);
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="text-xs text-base-content/70">
          Paste this into the Datadog webhook Payload field
        </div>
        <button type="button" className="btn btn-xs" onClick={() => copy(text, setCopied)}>
          <Copy size={12} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="bg-base-200 border border-base-300 rounded-box px-3 py-2 overflow-x-auto font-mono text-[11px]">
        {text}
      </pre>
      <p className="text-[11px] text-base-content/50 mt-1">
        Datadog payloads are user-defined — clawdcode matches on these exact field names, so keep
        the keys intact.
      </p>
    </div>
  );
}

function GithubCurlSnippet({ url }: { url: string }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-base-content/70">Test from curl</summary>
      <pre className="mt-2 bg-base-200 border border-base-300 rounded-box px-3 py-2 overflow-x-auto font-mono text-[11px]">{`SECRET=$CLAWDCODE_GITHUB_WEBHOOK_SECRET
BODY='{"zen":"hello"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | cut -d' ' -f2)
curl -sS -X POST "${url}" \\
  -H 'Content-Type: application/json' \\
  -H 'X-GitHub-Event: ping' \\
  -H "X-GitHub-Delivery: $(uuidgen)" \\
  -H "X-Hub-Signature-256: sha256=$SIG" \\
  --data "$BODY"`}</pre>
    </details>
  );
}

async function copy(value: string, setter: (b: boolean) => void) {
  try {
    await navigator.clipboard.writeText(value);
    setter(true);
    setTimeout(() => setter(false), 1500);
  } catch {
    // Clipboard API may be unavailable on insecure origins.
  }
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
