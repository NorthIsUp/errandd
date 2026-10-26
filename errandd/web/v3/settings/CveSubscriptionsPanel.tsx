import { useEffect, useState } from "react";
import { CVE_REMEDIATION_PROMPT } from "../../../shared/cve";
import { Markdown } from "../components/prompt-kit/markdown";
import { getCveSubscriptions } from "../../api/eventSources";
import type { CveSubscriptionInfo } from "../../../shared/cveSubscriptions";
import { SettingsPanel, SettingsBadge } from "./parts";
export function CveSubscriptionsPanel({
  openErrands,
  polling,
}: {
  openErrands: () => void;
  polling: boolean;
}) {
  const [subscriptions, setSubscriptions] = useState<CveSubscriptionInfo[]>([]);
  const [discoveryErrors, setDiscoveryErrors] = useState<{ repository: string; error?: string }[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  useEffect(() => {
    let active = true;
    const load = () => {
      void getCveSubscriptions()
        .then((data) => {
          if (active) {
            setSubscriptions(data.subscriptions ?? []);
            setDiscoveryErrors((data.discovery ?? []).filter(item => item.error));
            setError("");
            setLoading(false);
          }
        })
        .catch((error) => {
          if (active) {
            setError(error instanceof Error ? error.message : "Could not load subscriptions");
            setLoading(false);
          }
        });
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <SettingsPanel
      title="CVE subscriptions"
      description="Known repositories with lockfiles are subscribed automatically. Connection settings below control delivery; each errand can narrow repositories and technologies."
    >
      <button type="button" className="settings-link" onClick={openErrands}>
        Subscribe to CVEs / manage subscriptions →
      </button>
      <details className="settings-provider-details" open>
        <summary>CVE investigation instructions</summary>
        <p className="settings-hint">
          Incoming CVE hooks start an errand conversation. The default instructions below create or
          reuse a tracking issue, set priority and urgency from severity, and update it throughout
          investigation and remediation. Existing errands keep their saved prompt; edit it in Errands
          to adopt these instructions.
        </p>
        <Markdown>{CVE_REMEDIATION_PROMPT}</Markdown>
      </details>
      {!polling && (
        <p className="settings-hint" role="status">
          Choose Poll feed or Both below to run lockfile and historical subscriptions.
        </p>
      )}
      {loading && <p className="settings-hint">Loading subscriptions…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && !subscriptions.length && (
        <p className="settings-hint">
          Checking known repositories for lockfiles in the background. Subscriptions appear automatically when lockfiles are found. You can also add one from Errands.
        </p>
      )}
      {discoveryErrors.map(item => <p key={item.repository} className="settings-hint" role="status">Automatic discovery for {item.repository}: {item.error}</p>)}
      {subscriptions.length > 0 && (
        <div className="settings-two-fields">
          <label className="settings-field">
            Finding status
            <select
              aria-label="Finding status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">All findings</option>
              <option value="affected">Still affected</option>
              <option value="resolved">Auto-closed / resolved</option>
              <option value="candidate">Awaiting version check</option>
            </select>
          </label>
          <label className="settings-field">
            CVE or package
            <input
              aria-label="Find a CVE or package"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="CVE, Django, Next.js…"
            />
          </label>
        </div>
      )}
      {subscriptions.map((subscription) => {
        const affected = subscription.scans.flatMap((scan) =>
          scan.findings.filter((finding) => finding.status === "affected"),
        );
        const resolved = subscription.scans.flatMap((scan) =>
          scan.findings.filter((finding) => finding.status === "resolved"),
        );
        return (
          <details
            key={subscription.name}
            open={subscriptions.length === 1}
            className="settings-provider-details cve-subscription-disclosure"
          >
            <summary>
              {subscription.name}{" "}
              <SettingsBadge
                tone={
                  !subscription.enabled
                    ? "neutral"
                    : affected.length || subscription.scans.some((scan) => scan.error)
                      ? "warning"
                      : "good"
                }
              >
                {!subscription.enabled
                  ? "Disabled"
                  : subscription.scans.some((scan) => scan.error)
                    ? "Needs attention"
                    : affected.length
                      ? `${affected.length} affected`
                      : "Monitoring"}
              </SettingsBadge>
            </summary>
            <div className="cve-subscription-body">
              <p className="settings-hint">
                {subscription.rule.lockfiles
                  ? "Anything in lockfiles · exact version checks include historical advisories"
                  : [
                      subscription.rule.language.join(", "),
                      (subscription.rule.webserver ?? []).join(", "),
                      subscription.rule.technology.join(", "),
                    ]
                      .filter(Boolean)
                      .join(" · ") || "All matching new advisories"}
              </p>
              {!subscription.rule.lockfiles && subscription.rule.history && (
                <p className="settings-hint">
                  Historical scan:{" "}
                  {subscription.history.error ??
                    (subscription.history.complete ? "Complete" : "Queued / catching up")}{" "}
                  · {subscription.history.processed} advisories checked
                </p>
              )}
              {subscription.rule.lockfiles && !subscription.scans.length && (
                <p className="settings-hint">
                  Initial lockfile scan queued. Results appear after the next poll.
                </p>
              )}
              {subscription.scans.map((scan) => {
                const visible = scan.findings.filter(
                  (finding) =>
                    (statusFilter === "all" || finding.status === statusFilter) &&
                    (!search ||
                      [
                        finding.id,
                        ...finding.aliases,
                        finding.title,
                        ...finding.packages.map((pkg) => pkg.name),
                      ]
                        .join(" ")
                        .toLowerCase()
                        .includes(search.toLowerCase())),
                );
                return (
                  <section key={scan.repository} className="cve-repository-block">
                    <h3>{scan.repository}</h3>
                    <p className="settings-hint" role={scan.error ? "alert" : undefined}>
                      {scan.error ??
                        `${scan.packageCount} locked package versions · last complete scan ${scan.checkedAt ? new Date(scan.checkedAt).toLocaleString() : "pending"}`}
                    </p>
                    {Boolean(scan.unscannedPaths?.length) && (
                      <p className="settings-hint" role="status">
                        Unpinned manifests were excluded from version checks:{" "}
                        {scan.unscannedPaths!.join(", ")}. Findings from these paths are retained.
                      </p>
                    )}
                    {scan.paths.length > 0 && (
                      <p className="settings-hint">{scan.paths.join(", ")}</p>
                    )}
                    {scan.historyProgress && (
                      <p className="settings-hint">
                        Historical packages checked: {scan.historyProgress.checked} /{" "}
                        {scan.historyProgress.total}
                        {scan.historyProgress.error
                          ? ` · ${scan.historyProgress.error}`
                          : scan.historyProgress.complete
                            ? " · Complete"
                            : " · Catching up"}
                      </p>
                    )}
                    {visible.length > 0 && (
                      <ul className="settings-cve-findings">
                        {visible.slice(0, 50).map((finding) => (
                          <li key={finding.id}>
                            <a href={finding.url} target="_blank" rel="noreferrer">
                              {finding.id}
                            </a>{" "}
                            <SettingsBadge
                              tone={finding.status === "resolved" ? "good" : "warning"}
                            >
                              {finding.status === "resolved"
                                ? "Resolved"
                                : finding.status === "candidate"
                                  ? "Awaiting version check"
                                  : finding.severity}
                            </SettingsBadge>
                            <p>{finding.title}</p>
                            <small>
                              {finding.packages
                                .map((pkg) => `${pkg.name}@${pkg.version} (${pkg.path})`)
                                .join(", ")}
                              {finding.resolution ? ` · ${finding.resolution}` : ""}
                            </small>
                          </li>
                        ))}
                      </ul>
                    )}
                    {visible.length > 50 && (
                      <p className="settings-hint">
                        Showing 50 of {visible.length} matching findings.
                      </p>
                    )}
                  </section>
                );
              })}
              {resolved.length > 0 && (
                <p className="settings-hint">
                  {resolved.length} resolved after version-aware rescans.{" "}
                  {subscription.rule.autoResolve === false
                    ? "Automatic clearing is disabled."
                    : "Fixed findings are retained for history."}
                </p>
              )}
            </div>
          </details>
        );
      })}
    </SettingsPanel>
  );
}
