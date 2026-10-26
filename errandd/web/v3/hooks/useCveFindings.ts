import { useEffect, useState } from "react";
import { apiJSON } from "../../api/client";
import type { CveFindingSummary } from "../../../shared/cveSubscriptions";
export function useCveFindings(): CveFindingSummary[] {
  const [findings, setFindings] = useState<CveFindingSummary[]>([]);
  useEffect(() => {
    let active = true;
    const load = () => {
      void apiJSON<{ findings: CveFindingSummary[] }>("/api/cve/findings")
        .then((data) => {
          if (active) setFindings(data.findings ?? []);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return findings;
}
