import { Card, CardContent, CardHeader, CardTitle } from "@pikoloo/darwin-ui";
import type { HomeJob } from "../../api/home";
import styles from "./HomeCards.module.css";
import { fmtDur, nextRunAt } from "./utils";

interface Props {
  jobs: HomeJob[];
}

export function UpcomingJobsCard({ jobs }: Props) {
  const now = new Date();
  const displayed = jobs.slice(0, 8);

  return (
    <Card glass>
      <CardHeader>
        <CardTitle>Upcoming Jobs</CardTitle>
      </CardHeader>
      <CardContent>
        {displayed.length === 0 ? (
          <p style={{ color: "var(--muted)", fontSize: "13px" }}>
            No jobs configured.
          </p>
        ) : (
          displayed.map((job) => {
            const next = nextRunAt(job.schedule, now);
            const nextLabel = next
              ? fmtDur(next.getTime() - now.getTime())
              : "n/a";
            return (
              <div key={job.name} className={styles.listItem}>
                <span className={styles.listName}>{job.name}</span>
                <span className={styles.listMeta}>{nextLabel}</span>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
