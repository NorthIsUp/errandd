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
  url: string;
  status: "affected" | "resolved";
  packages: LockedPackage[];
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
  packages: LockedPackage[];
  alerts: { alert: CveAlert; packages: LockedPackage[] }[];
}
