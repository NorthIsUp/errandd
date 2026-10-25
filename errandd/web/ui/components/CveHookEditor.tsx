import { useEffect, useState } from "react";
import { CVE_REMEDIATION_PROMPT, defaultCveRule, type CveRule } from "../../../shared/cve";
import { apiJSON } from "../../api/client";
import { CopyButton } from "../../components/CopyButton";
import { PillList } from "./HookConfigEditor";

export function CveHookEditor({
  value,
  onChange,
}: {
  value: boolean | CveRule;
  onChange: (value: CveRule) => void;
}) {
  const rule = typeof value === "object" ? value : defaultCveRule();
  const [known, setKnown] = useState<string[]>([]);
  const [repository, setRepository] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void apiJSON<{ prs: { repo: string }[]; states?: Record<string, unknown> }>("/api/prs/open", {
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted)
          setKnown(
            [
              ...new Set([
                ...(data.prs ?? []).map((pr) => pr.repo),
                ...Object.keys(data.states ?? {}).map((key) => key.split("#")[0] ?? ""),
              ]),
            ].filter((repo) => /^[\w.-]+\/[\w.-]+$/.test(repo)),
          );
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const options = [...new Set(["current", ...rule.repositories, ...known])];
  const select = (field: "repositories" | "severity", item: string, selected: boolean) => {
    const before =
      field === "severity" && rule.severity.includes("*")
        ? ["critical", "high", "medium", "low", "unknown"]
        : rule[field];
    onChange({
      ...rule,
      [field]: selected
        ? [...new Set([...before, item])]
        : before.filter((value) => value !== item),
    });
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-base-content/70">
        Delivery mode, feed and polling frequency are configured in{" "}
        <a
          className="link text-primary"
          href={
            location.pathname.startsWith("/v3")
              ? "#/settings/events/cve"
              : "/v3/#/settings/events/cve"
          }
        >
          Settings → Event sources → CVEs
        </a>
        .
      </p>
      {!rule.poll && (
        <div className="rounded border border-base-300 p-3 text-sm">
          This errand has a legacy polling opt-out.{" "}
          <button
            type="button"
            className="link text-primary"
            onClick={() => onChange({ ...rule, poll: true })}
          >
            Allow connection polling
          </button>
        </div>
      )}
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">
          Repositories to assess and create fix PRs in
        </legend>
        {options.map((repo) => (
          <label key={repo} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="checkbox checkbox-sm"
              checked={rule.repositories.includes(repo)}
              onChange={(event) => select("repositories", repo, event.target.checked)}
            />
            {repo === "current" ? "Current working repository" : repo}
          </label>
        ))}
        <div className="flex flex-wrap gap-2">
          <input
            className="input input-sm input-bordered min-w-0 flex-1"
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            aria-label="Additional CVE repository"
            placeholder="owner/repo"
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              const repo = repository.trim();
              if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
                setError("Use an explicit owner/repo name.");
                return;
              }
              onChange({ ...rule, repositories: [...new Set([...rule.repositories, repo])] });
              setRepository("");
              setError("");
            }}
          >
            Add repository
          </button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
        {!rule.repositories.length && (
          <p className="text-xs text-warning">Select a repository to enable assessment.</p>
        )}
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Severity</legend>
        <div className="flex flex-wrap gap-3">
          {["critical", "high", "medium", "low", "unknown"].map((severity) => (
            <label key={severity} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={rule.severity.includes("*") || rule.severity.includes(severity)}
                onChange={(event) => select("severity", severity, event.target.checked)}
              />
              {severity}
            </label>
          ))}
        </div>
      </fieldset>
      {(
        [
          ["ecosystem", "Package ecosystems", "npm, pypi, maven, cargo, golang"],
          ["language", "Languages", "javascript, typescript, python, java, rust, go"],
          ["technology", "Technologies", "*node*, react, postgresql, linux"],
          ["product", "Products", "Product/package globs"],
          ["vendor", "Vendors", "Vendor globs"],
          ["project", "CVEFeed projects", "Project slug (webhook only)"],
        ] as const
      ).map(([field, label, placeholder]) => (
        <PillList
          key={field}
          label={label}
          items={rule[field]}
          placeholder={placeholder}
          supportsExclude
          onChange={(next) => onChange({ ...rule, [field]: next })}
          hint="Empty matches all. Use globs to narrow the feed."
        />
      ))}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="checkbox checkbox-sm"
          checked={rule.includeUnclassified}
          onChange={(event) => onChange({ ...rule, includeUnclassified: event.target.checked })}
        />
        Include advisories missing classification metadata
      </label>
      <p className="text-xs text-base-content/65">
        Language is inferred from package ecosystems. These filters select advisories; the agent
        verifies whether the repository is actually affected. The first poll starts at current
        updates; missed batches resume from SQL after a restart.
      </p>
      <details>
        <summary className="cursor-pointer text-sm">Suggested assessment and fix prompt</summary>
        <div className="relative mt-2 rounded border border-base-300 bg-base-200 p-3 pr-10">
          <CopyButton text={CVE_REMEDIATION_PROMPT} label="CVE remediation prompt" />
          <pre className="whitespace-pre-wrap text-xs">{CVE_REMEDIATION_PROMPT}</pre>
        </div>
      </details>
    </div>
  );
}
