import type { HomeJob } from "../../api/home";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import styles from "./HomeCards.module.css";
import { fmtDur, nextRunAt } from "./utils";

interface Props {
  jobs: HomeJob[];
}

export function UpcomingJobsCard({ jobs }: Props) {
  const now = new Date();
  const displayed = jobs.slice(0, 8);

  return (
    <Card title="Upcoming Jobs">
      {displayed.length === 0 ? (
        <EmptyState message="No jobs configured." />
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
    </Card>
  );
}
