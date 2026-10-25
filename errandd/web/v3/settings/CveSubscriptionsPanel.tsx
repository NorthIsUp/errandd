import { useEffect, useState } from "react";
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
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const load = () => {
      void getCveSubscriptions()
        .then((data) => {
          if (active) {
            setSubscriptions(data.subscriptions ?? []);
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
      description="Choose what you watch in an errand. Connection settings below control delivery; subscriptions select repositories and technologies."
    >
      <button type="button" className="settings-link" onClick={openErrands}>
        Subscribe to CVEs / manage subscriptions →
      </button>
      {!polling && (
        <p className="settings-hint" role="status">
          Choose Poll feed or Both below to run lockfile and historical subscriptions.
        </p>
      )}
      {loading && <p className="settings-hint">Loading subscriptions…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && !subscriptions.length && (
        <p className="settings-hint">
          No CVE subscriptions yet. In Errands, choose a library and select “Subscribe to CVEs”.
        </p>
      )}
      {subscriptions.map((subscription) => {
        const affected = subscription.scans.flatMap((scan) =>
          scan.findings.filter((finding) => finding.status === "affected"),
        );
        const resolved = subscription.scans.flatMap((scan) =>
          scan.findings.filter((finding) => finding.status === "resolved"),
        );
        const targets = subscription.rule.repositories.join(", ");
        return (
          <details key={subscription.name} className="settings-provider-details">
            <summary>
              {subscription.name} · {targets}{" "}
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
            {subscription.scans.map((scan) => (
              <div key={scan.repository}>
                <strong>{scan.repository}</strong>
                <p className="settings-hint" role={scan.error ? "alert" : undefined}>
                  {scan.error ??
                    `${scan.packageCount} locked package versions · last complete scan ${scan.checkedAt ? new Date(scan.checkedAt).toLocaleString() : "pending"}`}
                </p>
                {scan.paths.length > 0 && <p className="settings-hint">{scan.paths.join(", ")}</p>}
                {scan.findings.length > 0 && (
                  <ul className="settings-cve-findings">
                    {scan.findings.slice(0, 50).map((finding) => (
                      <li key={finding.id}>
                        <a href={finding.url} target="_blank" rel="noreferrer">
                          {finding.id}
                        </a>{" "}
                        <SettingsBadge tone={finding.status === "resolved" ? "good" : "warning"}>
                          {finding.status === "resolved" ? "Resolved" : finding.severity}
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
                {scan.findings.length > 50 && (
                  <p className="settings-hint">Showing 50 of {scan.findings.length} findings.</p>
                )}
              </div>
            ))}
            {resolved.length > 0 && (
              <p className="settings-hint">
                {resolved.length} resolved after version-aware rescans.{" "}
                {subscription.rule.autoResolve === false
                  ? "Automatic clearing is disabled."
                  : "Fixed findings are retained for history."}
              </p>
            )}
          </details>
        );
      })}
    </SettingsPanel>
  );
}
