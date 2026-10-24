/** Read-only capture for /demos/chat/compare. Run under your existing proxy
 * when needed: tsmux run bun scripts/import-chat-examples.ts ORIGIN THREAD... */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CapturedChat, ChatExamples } from "../shared/chatExamples";
import type { ChatPart, SourceLink } from "../shared/transcriptParts";

const [source, ...threads] = process.argv.slice(2);
if (!source || threads.length === 0) throw new Error("Usage: bun scripts/import-chat-examples.ts https://your-errandd.example THREAD_ID...");
const origin = new URL(source).origin;
if (!origin.startsWith("https://") && !origin.startsWith("http://localhost")) throw new Error("Use HTTPS for the source instance");
const headers: Record<string, string> = { Accept: "application/json" };
if (process.env.ERRANDD_CAPTURE_TOKEN) headers.Authorization = `Bearer ${process.env.ERRANDD_CAPTURE_TOKEN}`;
let redactions = 0;
function redact(text: string): string {
  return text
    .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, () => { redactions++; return "[credential redacted]"; })
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}={0,2}/gi, (_match, prefix: string) => { redactions++; return `${prefix}[redacted]`; })
    .replace(/([?&](?:access_token|token|api_key)=)[^&\s"'<>]+/gi, (_match, prefix: string) => { redactions++; return `${prefix}[redacted]`; });
}
function sourcesFrom(parts: ChatPart[]): SourceLink[] {
  const links = new Map<string, SourceLink>();
  const text = JSON.stringify(parts);
  for (const match of text.matchAll(/https:\/\/(?:github\.com\/[^\s"<>\\]+\/pull\/\d+|linear\.app\/[^\s"<>\\]+)/g)) {
    const href = match[0].replace(/[),.;]+$/, "");
    if (links.size >= 8) break;
    const url = new URL(href);
    const pr = /\/([^/]+)\/pull\/(\d+)/.exec(url.pathname);
    const label = pr ? `${pr[1]}#${pr[2]}` : url.pathname.split("/").filter(Boolean).slice(-2).join("/");
    links.set(href, { href, label: label || url.hostname });
  }
  return [...links.values()];
}
const examples: CapturedChat[] = [];
for (const [index, threadId] of threads.entries()) {
  const url = `${origin}/api/v3/threads/${encodeURIComponent(threadId)}/messages?limit=250&offset=0`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`${threadId}: HTTP ${response.status}`);
  const raw = await response.json() as { parts?: unknown; total?: number };
  if (!Array.isArray(raw.parts) || !raw.parts.length) throw new Error(`${threadId}: no transcript parts available`);
  if (!raw.parts.every((part: unknown) => part && typeof part === "object" && "kind" in part && "id" in part)) throw new Error(`${threadId}: invalid transcript shape`);
  const parts = JSON.parse(JSON.stringify(raw.parts, (_key, value: unknown) => typeof value === "string" ? redact(value) : value)) as ChatPart[];
  const sourceUrl = `${origin}/v3/#/chat/${encodeURIComponent(threadId)}`;
  examples.push({ id: `capture-${index + 1}`, title: threadId.replace(":hook:", " · "), threadId, sourceUrl, totalParts: raw.total ?? parts.length, parts, sources: sourcesFrom(parts) });
  console.log(`Captured ${parts.length} parts from ${threadId}`);
}
const file = join(process.cwd(), ".claude/errandd/demos/chat-examples.json");
const data: ChatExamples = { version: 1, sourceOrigin: origin, capturedAt: new Date().toISOString(), examples };
await mkdir(dirname(file), { recursive: true });
await writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
console.log(`Saved ${examples.length} conversations to local ignored state; ${redactions} credential patterns redacted.`);
