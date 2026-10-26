import type { CveAlert } from "./cve";

export const CVE_SYSTEM_CONTEXT_MARKER = "<!-- errandd:cve-system-context -->";
const cell = (value: string) => value.replace(/[\\`*_[\]<>]/g, "\\$&").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

/** Generated repository evidence is separate from the external CVE notification. */
export function cveSystemContextMarkdown(alert: Pick<CveAlert, "targetRepository" | "dependencyEvidence">): string {
  const repository = alert.targetRepository ?? "current";
  const repositoryUrl = /^[\w.-]+\/[\w.-]+$/.test(repository) ? `https://github.com/${repository}` : null;
  const repo = repositoryUrl ? `[${cell(repository)}](${repositoryUrl})` : cell(repository);
  const lines = ["## Where this affects our system", `**Repository:** ${repo}`];
  if (alert.dependencyEvidence?.length) {
    lines.push("Locked versions match affected ranges; reachability and exploit prerequisites still need investigation.", "### Locked dependencies");
    const rows = alert.dependencyEvidence.map(pkg => {
      const safePath = !pkg.path.startsWith("/") && !pkg.path.split(/[\\/]/).some(segment => segment === ".." || segment === ".");
      const path = repositoryUrl && safePath ? `[${cell(pkg.path)}](${repositoryUrl}/blob/HEAD/${pkg.path.split("/").map(encodeURIComponent).join("/")})` : cell(pkg.path);
      return `| ${[cell(pkg.name), cell(pkg.ecosystem), cell(pkg.version), path].join(" | ")} |`;
    });
    lines.push("| Package | Ecosystem | Locked version | Lockfile |\n| --- | --- | --- | --- |\n" + rows.join("\n"));
  } else lines.push("No lockfile match evidence was attached to this alert. Applicability in this repository has not yet been assessed.");
  return lines.join("\n\n");
}

/** Split generated context off a recorded model turn without changing its stored text. */
export function splitCveSystemContext(text: string): { message: string; context: string } | null {
  if (!/^## Incoming hooks?\b/m.test(text)) return null;
  const index = text.lastIndexOf(CVE_SYSTEM_CONTEXT_MARKER);
  if (index < 0) return null;
  const context = text.slice(index + CVE_SYSTEM_CONTEXT_MARKER.length).trim();
  return context ? { message: text.slice(0, index).trimEnd(), context } : null;
}
