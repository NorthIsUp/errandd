import { CheckCircle2, Download, RefreshCw } from "lucide-react";
import { useState } from "react";
import { applyUpdate, checkForUpdate, type UpdateCheck } from "../../api/runtime";
import { getState, type StateResponse } from "../../api/state";
import { Card } from "../components/Card";
import { ErrorBanner, Loader } from "../components/Loader";
import { PageHeader } from "../components/PageHeader";
import { useAsync } from "../useAsync";

export function AboutSection() {
  const state = useAsync<StateResponse>(() => getState());

  return (
    <>
      <PageHeader title="About" crumbs={[{ label: "About" }]} />
      <Card>
        <div className="flex items-center gap-4">
          <span className="text-5xl select-none" aria-hidden>
            🦞
          </span>
          <div>
            <div className="flex items-baseline gap-2">
              <h2 className="text-xl font-semibold">Errandd</h2>
              {state.data?.runtime.version && (
                <code className="text-xs text-base-content/60 font-mono">
                  v{state.data.runtime.version}
                </code>
              )}
            </div>
            <p className="text-sm text-base-content/70">
              A daemon for Claude Code routines, chats, and hooks.
            </p>
          </div>
        </div>
      </Card>

      <Card title="Runtime">
        {state.loading && <Loader />}
        {state.error ? <ErrorBanner error={state.error} /> : null}
        {state.data && (
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-y-2 gap-x-6 text-sm">
            <Row label="Model" value={state.data.model || "—"} />
            <Row label="Runtime" value={formatRuntime(state.data.runtime)} />
            <Row label="Fallback model" value={formatFallback(state.data.fallback)} />
            <Row
              label="Daemon"
              value={
                state.data.daemon.running ? `running · pid ${state.data.daemon.pid}` : "stopped"
              }
            />
            <Row label="Timezone" value={state.data.timezone} />
            {/* When installed as a Claude Code plugin we publish a
                semver in plugin.json — show that. When running from a
                checkout the daemon also has a real git tree we can show
                the sha of. Both can exist (dev iterating on a clone of
                the plugin tarball); render whichever is set. */}
            <RuntimeIdentityRow
              git={state.data.runtime.git}
              version={state.data.runtime.version}
            />
          </dl>
        )}
      </Card>

      <UpdatesCard />


      <Card title="Links">
        <ul className="text-sm space-y-1">
          <li>
            <a
              className="link link-primary"
              href="https://github.com/teamclara/errandd"
              target="_blank"
              rel="noopener noreferrer"
            >
              Source on GitHub
            </a>
          </li>
          <li>
            <a
              className="link link-primary"
              href="https://daisyui.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              UI: daisyUI
            </a>
          </li>
        </ul>
      </Card>
    </>
  );
}

/** Display 8 chars when the value looks like a sha (long hex); otherwise
 *  return as-is so version strings like "1.0.97" don't get truncated. */
function shortLabel(value: string): string {
  return /^[0-9a-f]{8,}$/i.test(value) ? value.slice(0, 8) : value;
}

function formatSha(g: { sha?: string; sha8?: string; dirty?: boolean } | undefined): string {
  if (!g) {
    return "—";
  }
  const sha = g.sha8 ?? g.sha?.slice(0, 8);
  if (!sha) {
    return "—";
  }
  return g.dirty ? `${sha}*` : sha;
}

/** Show the most authoritative runtime-identity row available:
 *  - git checkout → "Sha <hex>"
 *  - plugin install (no git) → "Version <semver>"
 *  - neither → "Sha —" so the row keeps the same vertical position as
 *    other deployments.
 */
function RuntimeIdentityRow({
  git,
  version,
}: {
  git: { sha?: string; sha8?: string; dirty?: boolean } | undefined;
  version: string | null;
}) {
  const sha = git?.sha8 ?? git?.sha?.slice(0, 8);
  if (sha) {
    return <Row label="Sha" value={formatSha(git)} />;
  }
  if (version) {
    return <Row label="Version" value={version} />;
  }
  return <Row label="Sha" value="—" />;
}

function UpdatesCard() {
  const check = useAsync<UpdateCheck>(() => checkForUpdate());
  const [refreshing, setRefreshing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updatedSha, setUpdatedSha] = useState<string | null>(null);

  async function onRefresh() {
    setRefreshing(true);
    try {
      // Force a fresh `git fetch` instead of returning a cached check.
      await checkForUpdate(true);
      check.reload();
    } finally {
      setRefreshing(false);
    }
  }

  async function onUpdate() {
    setUpdating(true);
    setUpdateError(null);
    try {
      const result = await applyUpdate();
      if (result.ok) {
        setUpdatedSha(result.newSha);
        check.reload();
      } else {
        setUpdateError(result.error ?? "update failed");
      }
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdating(false);
    }
  }

  const data = check.data;

  return (
    <Card
      title="Updates"
      actions={
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          onClick={() => void onRefresh()}
          disabled={refreshing || check.loading}
          aria-label="Re-check for updates"
        >
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
          {refreshing ? "Checking…" : "Check now"}
        </button>
      }
    >
      {check.loading && !data && <Loader />}
      {check.error ? <ErrorBanner error={check.error} /> : null}

      {data && (
        <div className="space-y-2 text-sm">
          {updatedSha && (
            <div className="alert alert-success">
              <CheckCircle2 size={16} />
              <span>
                Updated to <code className="font-mono">{shortLabel(updatedSha)}</code>. Restart
                the daemon to apply.
              </span>
            </div>
          )}

          {!updatedSha && data.behind === 0 && !data.error && data.kind !== "image" && (
            <div className="flex items-center gap-2 text-base-content/70">
              <CheckCircle2 size={16} className="text-success" />
              {data.kind === "plugin" ? (
                <>
                  Up to date
                  {data.currentSha ? (
                    <>
                      {" "}
                      at <code className="font-mono">v{data.currentSha}</code>
                    </>
                  ) : null}
                  .
                </>
              ) : (
                <>
                  Up to date
                  {data.branch ? (
                    <>
                      {" "}
                      on <code className="font-mono">{data.branch}</code>
                    </>
                  ) : null}
                  .
                </>
              )}
            </div>
          )}

          {!updatedSha && data.behind > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Download size={16} className="text-warning" />
              <span>
                {data.kind === "plugin"
                  ? `New version available: v${data.latestSha ?? "?"}`
                  : `${data.behind} commit${data.behind === 1 ? "" : "s"} behind ${data.branch}`}
              </span>
              {data.compareUrl && (
                <a
                  href={data.compareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="link link-hover text-xs"
                >
                  See what changed →
                </a>
              )}
              {(data.canPull || data.canPlugin) && (
                <button
                  type="button"
                  className="btn btn-sm btn-primary ml-auto"
                  onClick={() => void onUpdate()}
                  disabled={updating}
                  title={data.updateCommand ?? "Update now"}
                >
                  {updating ? "Updating…" : "Update now"}
                </button>
              )}
            </div>
          )}

          {!updatedSha && data.error && (
            <div className="alert alert-warning text-sm">
              <span>Can't check for updates: {data.error}</span>
            </div>
          )}

          {data.kind === "image" && !updatedSha && (
            <div className="flex items-center gap-2 text-base-content/70">
              <CheckCircle2 size={16} className="text-base-content/40" />
              <span>
                Deployed image
                {data.currentSha ? (
                  <>
                    {" "}
                    at <code className="font-mono">v{data.currentSha}</code>
                  </>
                ) : null}
                . Pull a newer build to update.
              </span>
            </div>
          )}

          {updateError && <div className="text-xs text-error">{updateError}</div>}

          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-y-1 gap-x-6 text-xs text-base-content/60 pt-1">
            {data.currentSha && (
              <Row label="Current" value={shortLabel(data.currentSha)} />
            )}
            {data.latestSha && (
              <Row label="Latest" value={shortLabel(data.latestSha)} />
            )}
            {data.updateCommand && (
              <Row label="Command" value={data.updateCommand} />
            )}
          </dl>
        </div>
      )}
    </Card>
  );
}

function formatFallback(f: { model: string; api: string } | string | undefined): string {
  if (!f) {
    return "—";
  }
  if (typeof f === "string") {
    return f || "—";
  }
  return f.model || f.api || "—";
}

/** "pi", or "pi · mypi" when the spawned binary's name differs from the id. */
function formatRuntime(r: { id?: string; executable?: string } | undefined): string {
  const id = r?.id;
  if (!id) {
    return "—";
  }
  const proc = r?.executable?.split("/").pop();
  return proc && proc !== id ? `${id} · ${proc}` : id;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-base-200 pb-1">
      <dt className="text-base-content/60">{label}</dt>
      <dd className="font-mono text-right">{value}</dd>
    </div>
  );
}
