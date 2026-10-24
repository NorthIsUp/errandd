import { hookOrigin } from "./hookOrigin";
import type { ActivityMessage, Message } from "@ag-ui/client";
import { z } from "zod";
import { toStockMessages, type CapturedChat } from "./chatExamples";
import { webhookDisplayMarkdown } from "./webhookDisplay";

export const NOTICE_ACTIVITY = "errandd.notice.v1";
export const SOURCES_ACTIVITY = "errandd.sources.v1";
export const noticeSchema = z.object({
  kind: z.enum(["capture", "external", "fyi", "outcome", "tool-error", "file-edit"]),
  title: z.string(),
  body: z.string(),
  at: z.number().optional(),
  href: z.string().url().refine((value) => /^https?:\/\//.test(value)).optional(),
});
export const sourcesSchema = z.object({ links: z.array(z.object({
  label: z.string(),
  href: z.string().url().refine((value) => /^https?:\/\//.test(value)),
})) });
export type NoticeContent = z.infer<typeof noticeSchema>;
export type SourcesContent = z.infer<typeof sourcesSchema>;

/** Standard AG-UI activity messages carry UI annotations without becoming
 * model instructions. Ordinary text/tool messages retain their original roles. */
export function toAnnotatedMessages(examples: CapturedChat[]): Message[] {
  const messages: Message[] = [];
  const notice = (id: string, content: NoticeContent) => messages.push({
    id, role: "activity", activityType: NOTICE_ACTIVITY, content,
  } satisfies ActivityMessage);
  for (const example of examples) {
    notice(`${example.id}:capture`, { kind: "capture", title: example.title, body: "Captured conversation", href: example.sourceUrl });
    for (const part of example.parts) {
      const id = `${example.id}:${part.id}`;
      if (part.notInContext || part.kind === "system") {
        const body = part.kind === "system" ? part.text : part.kind === "text" || part.kind === "reasoning" ? part.markdown : JSON.stringify(part);
        notice(id, { kind: part.notInContext ? "fyi" : "outcome", title: part.notInContext ? "FYI · not sent to the agent" : "Trigger / run outcome", body: webhookDisplayMarkdown(body), ...(part.at == null ? {} : { at: part.at }) });
        continue;
      }
      if (part.kind === "sources") {
        messages.push({ id, role: "activity", activityType: SOURCES_ACTIVITY, content: { links: part.sources.map(({ href, label }) => ({ href, label })) } });
        continue;
      }
      const origin = part.kind === "text" && part.role === "user" ? hookOrigin(part.markdown, example.threadId) : null;
      for (const message of toStockMessages([{ ...example, parts: [part] }])) {
        messages.push({ ...message, metadata: { errandd: { threadId: example.threadId, partKind: part.kind, ...(origin ? { origin } : {}), ...(part.at == null ? {} : { at: part.at }), ...(part.kind === "tool" ? { toolState: part.tool.state } : {}) } } });
      }
      if (part.kind === "tool" && part.tool.state === "output-error") {
        const output = part.tool.output;
        const body = part.tool.errorText || (typeof output?.text === "string" ? output.text : JSON.stringify(output ?? {}));
        notice(`${id}:error`, { kind: "tool-error", title: `${part.tool.type} · failed`, body, ...(part.at == null ? {} : { at: part.at }) });
      }
      if (part.kind === "tool" && /^(Edit|Write|apply_patch)$/i.test(part.tool.type)) {
        const input = part.tool.input ?? {};
        const oldText = typeof input.old_string === "string" ? input.old_string : "";
        const newText = typeof input.new_string === "string" ? input.new_string : typeof input.content === "string" ? input.content : "";
        if (oldText || newText) {
          const diff = [...oldText.split("\n").map((line) => `-${line}`), ...newText.split("\n").map((line) => `+${line}`)].join("\n");
          notice(`${id}:edit`, { kind: "file-edit", title: `File edit · ${typeof input.file_path === "string" ? input.file_path : part.tool.type}`, body: `\`\`\`diff\n${diff}\n\`\`\``, ...(part.at == null ? {} : { at: part.at }) });
        }
      }
    }
    if (example.sources.length) messages.push({ id: `${example.id}:references`, role: "activity", activityType: SOURCES_ACTIVITY, content: { links: example.sources.map(({ href, label }) => ({ href, label })) } });
  }
  return messages;
}
