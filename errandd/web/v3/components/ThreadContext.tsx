import { ExternalLink, FileText, X } from "lucide-react";
import type { SourceLink } from "../../../shared/transcriptParts";
import { RoutineDocument } from "../../components/RoutineDocument";
import type { JobDocument } from "../lib/threadContext";
import { Markdown } from "./prompt-kit/markdown";

export function ThreadContext({ documents, sources, jobName, olderCount, onLoadOlder, loadingOlder, onClose }: {
  documents: JobDocument[];
  sources: SourceLink[];
  jobName: string;
  olderCount: number;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onClose: () => void;
}) {
  return <aside id="v3-thread-context" className="v3-thread-context" aria-label="Thread context">
    <header><h2>Context</h2><button type="button" aria-label="Close context" onClick={onClose}><X size={16} /></button></header>
    <section><h3>Job instructions</h3>
      {jobName && <p className="v3-context-job-name"><FileText size={14} aria-hidden="true" />{jobName}.md</p>}
      {documents.map(document => <div key={document.id} className="v3-context-document">
        {documents.length > 1 && document.at != null && <time dateTime={new Date(document.at).toISOString()}>{new Date(document.at).toLocaleString()}</time>}
        <RoutineDocument title={document.title} markdown={document.body}><Markdown>{document.content}</Markdown></RoutineDocument>
      </div>)}
      {documents.length === 0 && <p className="v3-context-empty">{olderCount > 0 ? "Load earlier messages to find the original job instructions." : "This transcript does not include a job document."}</p>}
      {olderCount > 0 && <button type="button" className="v3-context-load" onClick={onLoadOlder} disabled={loadingOlder}>{loadingOlder ? "Loading…" : `Load earlier messages (${olderCount})`}</button>}
    </section>
    <section><h3>Sources</h3>{sources.length ? sources.map(source => <a key={source.href} href={source.href} target="_blank" rel="noreferrer" className="v3-context-source"><ExternalLink size={14} aria-hidden="true" /><span>{source.label}{source.title && source.title !== source.label && <small>{source.title}</small>}</span></a>) : <p className="v3-context-empty">No source links recorded yet.</p>}</section>
  </aside>;
}
