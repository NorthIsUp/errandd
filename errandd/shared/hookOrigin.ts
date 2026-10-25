import { z } from "zod";

export const hookOriginSchema = z.object({
  provider: z.enum(["github", "datadog", "sentry", "cve", "webhook"]),
  author: z.string().optional(),
  event: z.string().optional(),
  action: z.string().optional(),
});
export type HookOrigin = z.infer<typeof hookOriginSchema>;
export const hookSenderMetadataSchema = z.object({ origin: hookOriginSchema });

/** Structured provenance is preferred; older captured hooks retain the same
 * sender identity through their explicit hook header and thread source. */
export function hookOrigin(markdown: string, threadId = ""): HookOrigin | null {
  const header = /^\s*#{1,6}\s*Incoming hooks?\s*[·:]?\s*([^\n]*)/i.exec(markdown);
  const legacyHook = threadId.includes(":hook:") && /^\s*#{1,6}\s*(?:Hook payload|Webhook)\b/i.test(markdown);
  if (!header && !legacyHook) return null;
  const source = header?.[1]?.trim() ?? "";
  const provider = /^cve\b/i.test(source) ? "cve" : /^github\b/i.test(source) || /^(pr-|dependabot)/.test(threadId) ? "github"
    : /^datadog\b/i.test(source) || threadId.startsWith("datadog") ? "datadog"
    : /^sentry\b/i.test(source) || threadId.startsWith("sentry") ? "sentry" : "webhook";
  const readable = markdown.replace(/\*\*/g, "");
  const author = /\bauthor:\s*([^\s·\n]+)/i.exec(readable)?.[1];
  const action = /\baction:\s*([^\s·\n]+)/i.exec(readable)?.[1];
  const event = /^(?:github|datadog|sentry|cve)\s+([\w.:-]+)/i.exec(source)?.[1];
  return { provider, ...(author ? { author } : {}), ...(action ? { action } : {}), ...(event ? { event } : {}) };
}
