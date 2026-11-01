import { useEffect, useState } from "react";
import { getApiToken } from "../../api/client";
import { alertSnapshotSchema, type AlertReport } from "../../../shared/datadogAlerts";

export function useAlertReports(): AlertReport[] {
  const [reports, setReports] = useState<AlertReport[]>([]);
  useEffect(() => {
    const token = getApiToken();
    const stream = new EventSource(`/api/alerts/events${token ? `?token=${encodeURIComponent(token)}` : ""}`);
    stream.onmessage = event => {
      try {
        const parsed = alertSnapshotSchema.safeParse(JSON.parse(event.data as string));
        if (parsed.success) setReports(parsed.data.alerts);
      } catch { /* EventSource reconnect retains the last usable snapshot. */ }
    };
    return () => stream.close();
  }, []);
  return reports;
}
