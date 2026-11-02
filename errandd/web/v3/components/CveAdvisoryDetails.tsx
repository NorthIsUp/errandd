import type { CveFindingSummary } from "../../../shared/cveSubscriptions";
import { isCveNotAffected } from "../../../shared/cveSubscriptions";
import { Button } from "./ui/button";

export function CveAdvisoryDetails({ finding, onOpenRemediation }: {
  finding: CveFindingSummary;
  onOpenRemediation?: (() => void) | undefined;
}) {
  const sources = [...new Map((finding.sources ?? []).filter(source => /^https?:\/\//.test(source.url)).map(source => [source.url, source])).values()];
  return <div className="space-y-2 px-3 py-2 pl-12 text-xs text-base-content/70">
    <p>{finding.title}</p>
    {finding.affectedVersions?.length ? <table className="w-full text-left text-[11px]">
      <thead><tr><th className="font-medium">Affected range</th><th className="font-medium">Fixed in</th></tr></thead>
      <tbody>{finding.affectedVersions.map((row, index) => <tr key={`${row.product}:${row.range}:${index}`}><td className="pr-2">{row.product}: {row.range}</td><td>{row.fixed}</td></tr>)}</tbody>
    </table> : <p>Fix range not yet known.</p>}
    {isCveNotAffected(finding) && <p className="text-success">Resolved — not affected. {finding.applicability?.reason}</p>}
    {onOpenRemediation && <div>
      <p>Remediation is tracked in the shared package chat.</p>
      <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={onOpenRemediation}>Open package remediation chat</Button>
    </div>}
    {sources.length > 0 && <div className="flex flex-wrap gap-2">{sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer" className="underline">{source.source} report</a>)}</div>}
  </div>;
}
