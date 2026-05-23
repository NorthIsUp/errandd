import { CircularProgress } from "@pikoloo/darwin-ui";
import { useCallback, useEffect, useState } from "react";
import type { HomeResponse } from "../../api/home";
import { getHome } from "../../api/home";
import type { SessionUsage } from "../../api/usage";
import { getUsage } from "../../api/usage";
import { SectionFrame } from "../../components/SectionFrame";
import { DashboardCharts } from "../../features/home/DashboardCharts";
import styles from "./HomeSection.module.css";

const REFETCH_INTERVAL_MS = 30_000;

export function HomeSection() {
  const [home, setHome] = useState<HomeResponse | null>(null);
  const [usage, setUsage] = useState<SessionUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [homeData, usageData] = await Promise.all([getHome(), getUsage()]);
      setHome(homeData);
      setUsage(Array.isArray(usageData) ? usageData : []);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load home data.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(); // async fetch — setState called in promise resolution, not synchronously
    const id = setInterval(() => {
      void load();
    }, REFETCH_INTERVAL_MS);
    return () => {
      clearInterval(id);
    };
  }, [load]);

  return (
    <SectionFrame title="Home">
      {loading && !home ? (
        <div className={styles.center}>
          <CircularProgress indeterminate size={32} strokeWidth={3} />
        </div>
      ) : error !== null && !home ? (
        <div className={styles.center}>
          <p className={styles.errorMsg}>{error}</p>
        </div>
      ) : (
        <div className={styles.dashScroll}>
          <DashboardCharts allUsage={usage} />
        </div>
      )}
    </SectionFrame>
  );
}
