import { z } from "zod";
import { ecosystemName, type CveAlert } from "./cve";

const coordinate = z.object({ name: z.string().trim().min(1), ecosystem: z.string().trim().min(1) });
const affectedPackage = z.object({ package: coordinate });
export interface RemediationPackage { name: string; ecosystem: string }

/** Work identity excludes advisory IDs, ranges, versions and paths: those are evidence, not chats. */
export function remediationPackages(alert: Pick<CveAlert, "dependencyEvidence" | "affected">): RemediationPackage[] {
  const evidence = alert.dependencyEvidence;
  const affected = Array.isArray(alert.affected) ? alert.affected : [];
  const parsedEvidence = z.array(coordinate).safeParse(evidence);
  if (evidence?.length && !parsedEvidence.success) return [];
  const packages = evidence?.length && parsedEvidence.success ? parsedEvidence.data : affected.flatMap(value => {
    const parsed = affectedPackage.safeParse(value);
    return parsed.success ? [parsed.data.package] : [];
  });
  // A partially understood advisory must not silently lose its other products.
  if (!evidence?.length && packages.length !== affected.length) return [];
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
  return normalized.length ? JSON.stringify([repository.trim().toLowerCase(), normalized]) : null;
}
