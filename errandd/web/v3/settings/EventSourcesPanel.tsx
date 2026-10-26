import { CveSubscriptionsPanel } from "./CveSubscriptionsPanel";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  BookOpen,
  Check,
  Circle,
  GitPullRequest,
  Layers,
  Radio,
  Rss,
  Shield,
  Ticket,
  Zap,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import type { CveConnection, EventSourceInfo } from "../../api/eventSources";
import { testCveSource } from "../../api/eventSources";
import { CopyButton } from "../../components/CopyButton";
import { SettingsBadge, SettingsField, SettingsPanel, SettingsRow } from "./parts";
const PROVIDERS: Record<string, { name: string; description: string; icon: typeof Shield }> = {
  github: {
    name: "GitHub",
    description: "Pull requests, comments and checks",
    icon: GitPullRequest,
  },
  sentry: { name: "Sentry", description: "Issues and error events", icon: Circle },
  datadog: { name: "Datadog", description: "Monitor and alert events", icon: Bell },
  linear: { name: "Linear", description: "Issues, mentions and security ticket destination", icon: Ticket },
  cve: { name: "CVEs", description: "Vulnerability advisories", icon: Shield },
};
export function EventSourcesPanel({
  sources,
  selected,
  connection,
  onChange,
  navigate,
  openErrands,
  ticketing,
}: {
  sources: EventSourceInfo[];
  selected: string | undefined;
  connection: CveConnection;
  onChange: (next: CveConnection) => void;
  navigate: (id?: string) => void;
  openErrands: () => void;
  ticketing?: ReactNode;
}) {
  const [checking, setChecking] = useState(false),
    [result, setResult] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  const source = sources.find((item) => item.id === selected);
  async function check() {
    setChecking(true);
    setError(null);
    setResult(null);
    try {
      const tested = await testCveSource(connection);
      setResult(
        `${tested.format} is reachable${tested.records == null ? "" : ` · ${tested.records} CVE IDs in the feed`}. No errands were run.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Feed check failed");
    } finally {
      setChecking(false);
    }
  }
  if (!source)
    return (
      <>
        <div className="settings-page-title">
          <h1>Event sources</h1>
          <p>
            Where events arrive. Configure delivery mode, connection details and verification here.
          </p>
        </div>
        <div className="settings-source-list">
          {sources.map((item) => {
            const meta = PROVIDERS[item.id] ?? {
              name: item.id,
              description: "Webhook integration",
              icon: Radio,
            };
            const Icon = meta.icon;
            const polling =
              item.id === "cve" &&
              item.connection?.mode !== "webhook" &&
              item.errands.some((job) => job.enabled && job.polling);
            return (
              <button
                type="button"
                key={item.id}
                className="settings-source-row"
                onClick={() => navigate(item.id)}
              >
                <Icon size={23} />
                <span>
                  <strong>{meta.name}</strong>
                  <small>{meta.description}</small>
                  <small>
                    {item.errands.length} connected errand{item.errands.length === 1 ? "" : "s"}
                  </small>
                </span>
                <span className="settings-source-state">
                  <SettingsBadge
                    tone={
                      polling || item.configured
                        ? "good"
                        : item.id === "cve"
                          ? "neutral"
                          : "warning"
                    }
                  >
                    {polling
                      ? "Polling"
                      : item.configured
                        ? "Verification configured"
                        : item.id === "cve"
                          ? "Set up delivery"
                          : "Not verified"}
                  </SettingsBadge>
                  <small>
                    {item.connection
                      ? { webhook: "Webhook", poll: "Poll feed", both: "Webhook + poll feed" }[
                          item.connection.mode
                        ]
                      : "Webhook"}
                  </small>
                </span>
                <ArrowRight size={16} />
              </button>
            );
          })}
        </div>
        <p className="settings-hint">
          Connections receive data.{" "}
          <button type="button" className="settings-link" onClick={openErrands}>
            Errands
          </button>{" "}
          own the filters, target repositories and agent prompt.
        </p>
      </>
    );
  const meta = PROVIDERS[source.id] ?? {
    name: source.id,
    description: "Webhook integration",
    icon: Radio,
  };
  const Icon = meta.icon;
  return (
    <>
      <button type="button" className="settings-link" onClick={() => navigate()}>
        <ArrowLeft size={14} />
        All event sources
      </button>
      <div className="settings-page-title">
        <h1>
          <Icon size={24} />
          {meta.name}
        </h1>
        <p>{meta.description}</p>
      </div>
      {(source.id === "linear" || source.id === "cve") && ticketing}
      {source.id === "cve" && (
        <CveSubscriptionsPanel openErrands={openErrands} polling={connection.mode !== "webhook"} />
      )}
      {source.id === "cve" ? (
        <SettingsPanel
          title="Delivery mode"
          description="Choose how advisories reach Errandd. Existing per-errand polling opt-outs are preserved."
        >
          <div className="settings-mode-picker" role="group" aria-label="CVE delivery mode">
            {[
              { id: "webhook", name: "Webhook", description: "Push from CVEFeed", icon: Zap },
              {
                id: "poll",
                name: "Poll feed",
                description: "Check a feed on a schedule",
                icon: Rss,
              },
              { id: "both", name: "Both", description: "Webhook + polling", icon: Layers },
            ].map((mode) => (
              <button
                type="button"
                key={mode.id}
                aria-pressed={connection.mode === mode.id}
                onClick={() => {
                  onChange({ ...connection, mode: mode.id as CveConnection["mode"] });
                  setResult(null);
                }}
              >
                <mode.icon size={19} />
                <strong>{mode.name}</strong>
                <small>{mode.description}</small>
                {connection.mode === mode.id && <Check className="settings-mode-check" size={14} />}
              </button>
            ))}
          </div>
        </SettingsPanel>
      ) : (
        <p className="settings-hint">
          <Zap size={14} />
          Webhook delivery. Other delivery modes are not supported by this integration.
        </p>
      )}
      {(source.id !== "cve" || connection.mode !== "poll") && (
        <SettingsPanel title={source.id === "cve" ? "Webhook · CVEFeed" : "Webhook connection"}>
          <div className="settings-field">
            <span>Receiver URL</span>
            <div className="settings-copy-box">
              <code>{source.url}</code>
              <CopyButton text={source.url} label="receiver URL" />
            </div>
            <small>
              External senders need a publicly reachable webhook address for this deployment.
            </small>
          </div>
          <SettingsRow
            title={source.configured ? "Verification configured" : "Verification not configured"}
            description={
              source.id === "cve"
                ? "CVEFeed sends X-Webhook-Secret. The receiver is disabled until its secret is configured."
                : "Verification uses the provider’s signature or shared secret."
            }
          >
            <SettingsBadge tone={source.configured ? "good" : "warning"}>
              {source.configured ? "Configured" : "Not configured"}
            </SettingsBadge>
          </SettingsRow>
          {source.botMention && <SettingsRow title="Bot mention" description={source.botMention} />}
          {source.payloadTemplate != null && (
            <details>
              <summary>Recommended payload</summary>
              <div className="settings-copy-box">
                <pre>{JSON.stringify(source.payloadTemplate, null, 2)}</pre>
                <CopyButton
                  text={JSON.stringify(source.payloadTemplate, null, 2)}
                  label="recommended payload"
                />
              </div>
            </details>
          )}
          <details>
            <summary>Credential setup</summary>
            <div className="settings-copy-box">
              <code>{source.secretEnv}</code>
              <CopyButton text={source.secretEnv} label="secret environment variable" />
            </div>
            <p className="settings-hint">
              Set this environment variable in your deployment and restart. Credentials are managed
              outside application settings.
            </p>
          </details>
        </SettingsPanel>
      )}
      {source.id === "cve" && connection.mode !== "webhook" && (
        <SettingsPanel
          title="Poll feed"
          description="RSS/Atom entries are resolved to official CVE records before filters and remediation run."
        >
          <div className="settings-two-fields">
            <SettingsField label="Feed format">
              {(id) => (
                <select
                  id={id}
                  value={connection.feedFormat}
                  onChange={(e) => {
                    onChange({
                      ...connection,
                      feedFormat: e.target.value as CveConnection["feedFormat"],
                    });
                    setResult(null);
                  }}
                >
                  <option value="official">Official CVE JSON</option>
                  <option value="rss">RSS / Atom</option>
                </select>
              )}
            </SettingsField>
            <SettingsField label="Polling interval (minutes)">
              {(id) => (
                <input
                  id={id}
                  type="number"
                  min={1}
                  max={1440}
                  value={connection.intervalMinutes}
                  onChange={(e) =>
                    onChange({ ...connection, intervalMinutes: e.target.valueAsNumber })
                  }
                />
              )}
            </SettingsField>
          </div>
          {connection.feedFormat === "rss" ? (
            <SettingsField
              label="RSS / Atom feed URL"
              hint="RSS catch-up is limited to entries still retained by the publisher."
            >
              {(id) => (
                <input
                  id={id}
                  type="url"
                  placeholder="https://example.com/vulnerabilities.xml"
                  value={connection.feedUrl}
                  onChange={(e) => {
                    onChange({ ...connection, feedUrl: e.target.value });
                    setResult(null);
                  }}
                />
              )}
            </SettingsField>
          ) : (
            <div className="settings-copy-box">
              <code>CVEProject/cvelistV5</code>
              <CopyButton
                text="https://github.com/CVEProject/cvelistV5"
                label="official CVE feed"
              />
            </div>
          )}
          <SettingsRow
            title="GitHub Security Advisories"
            description="Also discover reviewed advisories, including those without CVE IDs. Existing ecosystem, language and package filters apply; CVE/GHSA aliases share one assessment per repository."
          >
            <label className="settings-checkbox">
              <input
                type="checkbox"
                aria-label="Discover GitHub Security Advisories"
                checked={connection.githubAdvisories !== false}
                onChange={(e) => {
                  onChange({ ...connection, githubAdvisories: e.target.checked });
                  setResult(null);
                }}
              />
              Enabled
            </label>
          </SettingsRow>
          {connection.githubAdvisories !== false && (
            <p className="settings-hint" role="status">
              {source.githubPollStatus?.error
                ? source.githubPollStatus.error
                : source.githubPollStatus?.catchingUp
                  ? "GitHub advisories: catching up"
                  : source.githubPollStatus?.lastPollAt
                    ? `GitHub advisories: last attempt ${new Date(source.githubPollStatus.lastPollAt).toLocaleString()}`
                    : "GitHub advisories: baselines on first poll; no historical jobs are created."}
            </p>
          )}
          <SettingsRow
            title="Sync status"
            description={
              source.pollStatus?.lastPollAt
                ? `Last attempt: ${new Date(source.pollStatus.lastPollAt).toLocaleString()}`
                : "No poll has been recorded."
            }
          >
            <SettingsBadge tone={source.pollStatus?.error ? "warning" : "neutral"}>
              {source.pollStatus?.error
                ? "Needs attention"
                : source.pollStatus?.catchingUp
                  ? "Catching up"
                  : source.errands.some((job) => job.enabled && job.polling)
                    ? "Scheduled"
                    : "Idle"}
            </SettingsBadge>
          </SettingsRow>
          {source.pollStatus?.error && (
            <p role="alert" className="settings-error">
              {source.pollStatus.error}
            </p>
          )}
          <button
            type="button"
            className="btn btn-sm btn-outline"
            disabled={checking}
            onClick={() => void check()}
          >
            {checking ? "Checking…" : "Check feed"}
          </button>
          {result && (
            <p role="status" className="settings-hint">
              {result}
            </p>
          )}
          {error && (
            <p role="alert" className="settings-error">
              {error}
            </p>
          )}
          <p className="settings-hint">
            First sync starts with new advisories. Progress and duplicate receipts persist in SQL.
            Checking a feed does not run errands or reset progress.
          </p>
        </SettingsPanel>
      )}
      <SettingsPanel
        title="Connected errands"
        description="Repository targets, severity, language, technology filters and prompts stay in each errand."
      >
        {source.errands.length ? (
          source.errands.map((job) => (
            <SettingsRow
              key={job.name}
              title={job.name}
              description={
                source.id === "cve" && !job.polling
                  ? "Legacy polling opt-out"
                  : job.enabled
                    ? "Enabled"
                    : "Disabled"
              }
            >
              <BookOpen size={15} />
            </SettingsRow>
          ))
        ) : (
          <p className="settings-hint">
            No connected errand. Add and enable an errand to start processing events.
          </p>
        )}
        <button type="button" className="btn btn-sm btn-outline" onClick={openErrands}>
          Open errands <ArrowRight size={14} />
        </button>
      </SettingsPanel>
    </>
  );
}
