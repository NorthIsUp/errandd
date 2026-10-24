import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";
import { CopyButton } from "./CopyButton";
import "./routine-document.css";

export function RoutineDocument({ title, markdown, children }: {
  title: string;
  markdown: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article className="errandd-job-document" aria-label="Errand job instructions">
      <CopyButton text={markdown} label="job instructions" />
      <details onToggle={event => setExpanded(event.currentTarget.open)}>
        <summary>
          <span className="errandd-job-mark" role="img" aria-label="Errandd">🦞</span>
          <span className="errandd-job-heading">
            <span className="errandd-job-label">Errand job · Markdown</span>
            <span className="errandd-job-title">{title}</span>
            <span className="errandd-job-hint">{expanded ? "Hide instructions" : "Read instructions"}</span>
          </span>
          <ChevronDown className="errandd-job-chevron" size={16} aria-hidden="true" />
        </summary>
        {expanded && <div className="errandd-job-body">{children}</div>}
      </details>
    </article>
  );
}
