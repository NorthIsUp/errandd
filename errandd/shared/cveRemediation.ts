import { z } from "zod";
import { ecosystemName, type CveAlert } from "./cve";

const affectedPackage = z.object({ package: z.object({ name: z.string().min(1), ecosystem: z.string().min(1) }) });
export interface RemediationPackage { name: string; ecosystem: string }

/** Work identity excludes advisory IDs, ranges, versions and paths: those are evidence, not chats. */
export function remediationPackages(alert: Pick<CveAlert, "dependencyEvidence" | "affected">): RemediationPackage[] {
  const evidence = alert.dependencyEvidence;
  const packages = evidence?.length ? evidence : alert.affected.flatMap(value => {
    const parsed = affectedPackage.safeParse(value);
    return parsed.success ? [parsed.data.package] : [];
  });
  // A partially understood advisory must not silently lose its other products.
  if (!evidence?.length && packages.length !== alert.affected.length) return [];
  const normalized = packages.map(pkg => {
    const ecosystem = ecosystemName(pkg.ecosystem.trim());
    const name = ecosystem === "pypi" ? pkg.name.trim().toLowerCase().replace(/[-_.]+/g, "-") : pkg.name.trim();
    return { ecosystem, name };
  });
  return [...new Map(normalized.map(pkg => [JSON.stringify(pkg), pkg])).values()]
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function remediationIdentity(repository: string, packages: RemediationPackage[]): string | null {
  if (!packages.length) return null;
  const normalized = remediationPackages({ dependencyEvidence: packages.map(pkg => ({ ...pkg, version: "", path: "" })), affected: [] });
  return JSON.stringify([repository.trim().toLowerCase(), normalized]);
}
