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
            <h2 className="text-xl font-semibold">ClawdCode</h2>
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
            <Row label="Fallback model" value={formatFallback(state.data.fallback)} />
            <Row
              label="Daemon"
              value={
                state.data.daemon.running ? `running · pid ${state.data.daemon.pid}` : "stopped"
              }
            />
            <Row label="Timezone" value={state.data.timezone} />
            <Row
              label="Heartbeat"
              value={
                state.data.heartbeat.enabled
                  ? `every ${state.data.heartbeat.intervalMinutes} min`
                  : "off"
              }
            />
            <Row
              label="Git"
              value={state.data.runtime.git.describe ?? state.data.runtime.git.sha8 ?? "—"}
            />
          </dl>
        )}
      </Card>

      <Card title="Links">
        <ul className="text-sm space-y-1">
          <li>
            <a
              className="link link-primary"
              href="https://github.com/teamclara/clawdcode"
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

function formatFallback(f: { model: string; api: string } | string | undefined): string {
  if (!f) {
    return "—";
  }
  if (typeof f === "string") {
    return f || "—";
  }
  return f.model || f.api || "—";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-base-200 pb-1">
      <dt className="text-base-content/60">{label}</dt>
      <dd className="font-mono text-right">{value}</dd>
    </div>
  );
}
