import type { CveAlert, CveRule } from "./cve";
export interface LockedPackage {
  name: string;
  version: string;
  ecosystem: string;
  path: string;
}
export interface CveFinding {
  id: string;
  aliases: string[];
  title: string;
  severity: string;
  sources?: CveAlert["sources"];
  technologies?: string[];
  url: string;
  status: "candidate" | "affected" | "resolved";
  packages: LockedPackage[];
  paths?: string[];
  generation?: number;
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt?: number;
  resolution?: string;
}
export interface CveScanState {
  repository: string;
  job: string;
  checkedAt: number;
  packageCount: number;
  paths: string[];
  error?: string;
  unscannedPaths?: string[];
  historyProgress?: { checked: number; total: number; complete: boolean; error?: string };
  findings: CveFinding[];
}
export interface CveSubscriptionInfo {
  name: string;
  enabled: boolean;
  rule: CveRule;
  scans: CveScanState[];
  history: { complete: boolean; processed: number; error?: string };
}
export interface LockScanResult {
  fingerprint: string;
  unscannedPaths?: string[];
  packages: LockedPackage[];
  alerts: { alert: CveAlert; packages: LockedPackage[] }[];
  historical?: { alert: CveAlert; packages: LockedPackage[] }[];
  historyProgress?: { checked: number; total: number; complete: boolean; error?: string };
  historyAcknowledgements?: string[];
}
export interface CveFindingSummary extends Pick<CveFinding, "sources" | "technologies"> {
  key: string;
  id: string;
  aliases: string[];
  job: string;
  repository: string;
  title: string;
  severity: string;
  status: CveFinding["status"];
  updatedAt: number;
  packageNames: string[];
}
export const cveFindingKey = (job: string, repository: string, id: string): string =>
  `cve-finding:${encodeURIComponent(JSON.stringify([job, repository, id]))}`;
