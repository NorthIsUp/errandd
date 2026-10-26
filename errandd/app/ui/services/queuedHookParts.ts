import { queuedCveAlert } from "../../../shared/cve";
import { cveSystemContextMarkdown } from "../../../shared/cveSystemContext";
import { ticketProjectInstructions } from "../../../shared/ticketing";
import type { Job } from "../../jobs";
import type { QueuedMessage } from "../../hookQueue";
import type { ChatPart } from "../../../shared/transcriptParts";
import { buildHookEssentials, renderHookEssentialsMarkdown } from "../../../shared/hookEssentials";

/** Show the durable incoming messages immediately, before an agent transcript exists. */
export function queuedHookParts(messages: QueuedMessage[], jobs: Pick<Job, "name" | "prompt">[] = [], ticketProject?: string): ChatPart[] {
  let instructionsIncluded = false;
  return [...messages].sort((a, b) => a.enqueuedAt - b.enqueuedAt).flatMap((message): ChatPart[] => {
    const payload = message.payload as { text?: unknown } | null;
    const essentials = buildHookEssentials(message.event, message.payload);
    let markdown = message.event === "web:message" && typeof payload?.text === "string"
      ? payload.text
      : `## Incoming hook · ${essentials.source} ${essentials.event}\n${renderHookEssentialsMarkdown(essentials)}`;
    if (!instructionsIncluded && message.event !== "web:message") {
      const job = jobs.find(job => job.name === message.jobName);
      if (job?.prompt.trim()) {
        const prompt = job.prompt.trim();
        const separator = message.event.startsWith("cve:") ? "\n\n---\n\n" : "\n\n";
        markdown += `${separator}${prompt.startsWith("# ") ? prompt : `# Errand instructions\n\n${prompt}`}`;
        const destination = ticketProjectInstructions(ticketProject);
        if (destination) markdown += `\n\n${destination}`;
        instructionsIncluded = true;
      }
    }
    const parts: ChatPart[] = [{ kind: "text", role: "user", id: `queued-hook:${message.id}`, markdown, at: message.enqueuedAt }];
    const alert = message.event.startsWith("cve:") ? queuedCveAlert(message.payload) : null;
    if (alert) parts.push({ kind: "system", contextType: "repository-analysis", id: `queued-hook:${message.id}:repository`, text: cveSystemContextMarkdown(alert), at: message.enqueuedAt });
    return parts;
  });
}
