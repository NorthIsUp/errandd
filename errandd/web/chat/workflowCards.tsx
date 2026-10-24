import { type ToolCallMessagePartProps, useAuiState } from "@assistant-ui/react";
import { useAgUiSetState, useAgUiState } from "@assistant-ui/react-ag-ui";
import { type ReactNode, useState } from "react";
import { z } from "zod";
import {
  jobActivitySchema,
  reviewReportSchema,
  workflowStateSchema,
  type WorkflowState,
} from "../../shared/workflowCards";
import { HookOriginIcon } from "./MessageSender";
import { DiffCodeBlock } from "../components/UnifiedDiff";
import { AssistantToolCard } from "./toolCards";
import "./workflowCards.css";

export function JobActivity({ data }: { data: unknown }) {
  const shared = workflowStateSchema.safeParse(useAgUiState());
  const parsed = jobActivitySchema.safeParse(data);
  if (!parsed.success) return null;
  // Activity patches update the active stream. Shared state survives a native
  // interrupt/resume, so the original card settles without a duplicate card.
  const settled =
    shared.success &&
    shared.data.erranddDemo.jobId === parsed.data.jobId &&
    shared.data.erranddDemo.completed === 4
      ? shared.data.erranddDemo
      : null;
  const job = settled ?? parsed.data;
  return (
    <section className="workflow-card" data-job-id={job.jobId} aria-label="Webhook job">
      <header>
        <strong>{job.title}</strong>
        <span className="workflow-status" data-status={job.status}>
          {job.status}
        </span>
      </header>
      <p className="workflow-muted">
        <HookOriginIcon
          provider={
            job.provider === "GitHub"
              ? "github"
              : job.provider === "Datadog"
                ? "datadog"
                : job.provider === "Sentry"
                  ? "sentry"
                  : "webhook"
          }
        />{" "}
        {job.provider} · action: {job.action} · author: {job.author}
      </p>
      <p>{job.stage}</p>
      <progress max={4} value={job.completed} aria-label="Job progress" />
    </section>
  );
}

/** Hooks subscribe directly to the AG-UI runtime, without a parallel state store. */
export function WorkflowInspector() {
  const shared = useAgUiState();
  const setShared = useAgUiSetState<WorkflowState>();
  const running = useAuiState((state) => state.thread.isRunning);
  const parsed = workflowStateSchema.safeParse(shared);
  if (!parsed.success) return null;
  const job = parsed.data.erranddDemo;
  return (
    <aside className="workflow-context" aria-label="Workflow state">
      <div>
        <strong>Run context</strong>
        <span>
          {job.stage} · {job.completed}/4 stages
        </span>
      </div>
      <label>
        Result detail{" "}
        <select
          aria-label="Result detail"
          value={job.detail}
          disabled={running || job.status !== "waiting"}
          onChange={(event) => {
            const detail = event.target.value === "summary" ? "summary" : "full";
            setShared((previous) => ({
              erranddDemo: { ...(previous ?? parsed.data).erranddDemo, detail },
            }));
          }}
        >
          <option value="full">Full report</option>
          <option value="summary">Summary</option>
        </select>
      </label>
    </aside>
  );
}

const reviewerSchema = z.object({ reviewer: z.string() });
export function SubagentCard({
  children,
  ...props
}: ToolCallMessagePartProps & { children: ReactNode }) {
  const args = reviewerSchema.safeParse(props.args);
  const status =
    props.result !== undefined
      ? "completed"
      : props.status.type === "incomplete"
        ? "stopped"
        : "working";
  return (
    <details className="workflow-card workflow-subagent" open>
      <summary>
        <strong>{args.success ? args.data.reviewer : "Review worker"}</strong>
        <span className="workflow-status">{status}</span>
      </summary>
      <div className="workflow-nested">{children}</div>
    </details>
  );
}

export function ReviewReportCard(props: ToolCallMessagePartProps) {
  const report = reviewReportSchema.safeParse(props.result);
  if (!report.success) return <AssistantToolCard {...props} />;
  const value = report.data;
  return (
    <section className="workflow-card" data-custom-card="review-report">
      <header>
        <strong>{value.title}</strong>
        <span className="workflow-status">Draft</span>
      </header>
      <dl className="workflow-checks">
        {value.checks.map((check) => (
          <div key={check.name}>
            <dt>{check.name}</dt>
            <dd>{check.result}</dd>
          </div>
        ))}
      </dl>
      <details>
        <summary>Changed files · {value.files.length}</summary>
        <ul>
          {value.files.map((file) => (
            <li key={file}>
              <code>{file}</code>
            </li>
          ))}
        </ul>
      </details>
      <div className="workflow-diff">
        <DiffCodeBlock code={value.diff} language="diff">
          <pre aria-label="Proposed diff">
            <code>{value.diff}</code>
          </pre>
        </DiffCodeBlock>
      </div>
      <a
        download={value.artifact.name}
        href={`data:text/markdown;charset=utf-8,${encodeURIComponent(value.artifact.text)}`}
      >
        Download {value.artifact.name}
      </a>
    </section>
  );
}

/** respondToApproval is the stock runtime action: it constructs the resume
 * request, associates the decision with this tool, and resumes the AG-UI run. */
export function ReviewDecisionCard(props: ToolCallMessagePartProps) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gate = props.approval;
  const pending = gate && gate.approved === undefined && !gate.resolution;
  const decide = async (approved: boolean) => {
    setSending(true);
    setError(null);
    try {
      await props.respondToApproval({ approved });
    } catch {
      setError("The decision could not be recorded. Try again.");
    } finally {
      setSending(false);
    }
  };
  return (
    <section className="workflow-card" aria-label="Review decision">
      <header>
        <strong>Review draft</strong>
        <span className="workflow-status">
          {pending
            ? "Needs your decision"
            : gate?.approved === true
              ? "Approved"
              : gate?.approved === false
                ? "Declined"
                : gate?.resolution
                  ? "Closed"
                  : "Preparing"}
        </span>
      </header>
      <p>{gate?.prompt ?? "Preparing the preview decision…"}</p>
      {pending && (
        <div className="workflow-actions">
          <button
            type="button"
            disabled={sending}
            onClick={() => {
              void decide(true);
            }}
          >
            Approve preview
          </button>
          <button
            type="button"
            disabled={sending}
            onClick={() => {
              void decide(false);
            }}
          >
            Decline preview
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
