import { routineDocument } from "../../../shared/routineDocument";
import type { ChatPart, SourceLink } from "../../../shared/transcriptParts";

export interface JobDocument {
  id: string;
  title: string;
  body: string;
  content: string;
  at?: number;
}

/** Display-only projection: hook attribution and FYI stay in the transcript;
 * instructions and references move to Context. Stored/provider data is intact. */
export function projectThreadContext(parts: ChatPart[]) {
  const documents = new Map<string, JobDocument>();
  const sources = new Map<string, SourceLink>();
  const conversation: ChatPart[] = [];
  for (const part of parts) {
    if (part.kind === "sources" && !part.notInContext) {
      for (const source of part.sources) sources.set(source.href, source);
      continue;
    }
    const text = !part.notInContext && (part.kind === "system" ? part.text : part.kind === "text" && part.role === "user" ? part.markdown : null);
    const document = text ? routineDocument(text) : null;
    if (!document) { conversation.push(part); continue; }
    documents.delete(document.body);
    documents.set(document.body, { id: part.id, title: document.title, body: document.body, content: document.content, ...(part.at == null ? {} : { at: part.at }) });
    if (document.context) {
      if (part.kind === "system") conversation.push({ ...part, text: document.context });
      else if (part.kind === "text") conversation.push({ ...part, markdown: document.context });
    }
  }
  return { conversation, documents: [...documents.values()].reverse(), sources: [...sources.values()] };
}
