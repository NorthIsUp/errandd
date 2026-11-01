import { z } from "zod";
import { createHash } from "node:crypto";
import { getReadCache, type ReadCache } from "./readCache";
import { defaultSentryRule } from "./hooks/schema";
import { matchSentryRule, readSentryPayload } from "./hooks/match";
import { dispatchSentryAlert } from "./hooks/sentry";
import { sentryExtractFields, sentryExtractKeys } from "./hooks/evaluate";
import { recordDelivery, attachDeliveryPayload, setDeliveryEvaluation } from "./hooks/deliveries";
import type { WebhookDeps } from "./hooks/receiver";

const API = "https://sentry.io";
const INTERVAL = 5 * 60_000;
const PAGE_SIZE = 10;
const issueSchema = z.object({
  id: z.string().regex(/^\d+$/), shortId: z.string(), title: z.string(),
  level: z.string(), status: z.string(), firstSeen: z.string(), lastSeen: z.string(),
  permalink: z.url(), project: z.object({ slug: z.string(), name: z.string().optional() }),
});
const eventSchema = z.object({
  tags: z.array(z.object({ key: z.string(), value: z.string() })).default([]),
  environment: z.string().nullish(), server_name: z.string().nullish(),
});
export interface SentryPollStatus {
  organization?: string;
  lastAttemptAt?: number;
  lastPollAt?: number;
  nextAttemptAt?: number;
  cursor?: string;
  processed?: number;
  error?: string;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
export function sentryPollingConfigured(): boolean {
  return Boolean((process.env.SENTRY_AUTH_TOKEN || process.env.SENTRY_ACCESS_TOKEN) && process.env.SENTRY_ORG);
}
export const getSentryPollStatus = (store: Pick<ReadCache, "get"> = getReadCache()) =>
  store.get<SentryPollStatus>("sentry-poller", "status")?.value;

function parseSentry<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw Error("Incomplete Sentry API response");
  return parsed.data;
}
async function sentryJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw Error("Empty Sentry API response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 * 1024) throw Error("Sentry API response exceeds size limit");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw Error("Invalid Sentry API JSON"); }
}

function nextCursor(link: string | null, pathname: string): string | undefined {
  for (const part of link?.split(",") ?? []) {
    if (!part.includes('rel="next"') || !part.includes('results="true"')) continue;
    const match = /<([^>]+)>/.exec(part);
    if (!match) throw Error("Invalid Sentry pagination");
    const next = new URL(match[1]);
    if (next.origin !== API || next.pathname !== pathname) throw Error("Unexpected Sentry pagination origin");
    const cursor = next.searchParams.get("cursor");
    if (!cursor || cursor.length > 200) throw Error("Invalid Sentry cursor");
    return cursor;
  }
  return undefined;
}

/** API ingestion complements webhooks; the configured routine still owns applicability and debounce. */
export class SentryPoller {
  private readonly controller = new AbortController();
  private inFlight: Promise<void> | null = null;
  constructor(
    private readonly deps: Required<Pick<WebhookDeps, "getJobs" | "onHookFire">>,
    private readonly store: Pick<ReadCache, "get" | "set"> = getReadCache(),
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  stop(): void { this.controller.abort(); }
  tick(now = Date.now()): Promise<void> {
    const previous = getSentryPollStatus(this.store);
    const saved = previous?.organization === process.env.SENTRY_ORG ? previous : undefined;
    if (!sentryPollingConfigured() || this.controller.signal.aborted || now < (saved?.nextAttemptAt ?? 0)) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.poll(now).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  private async request(url: URL): Promise<Response> {
    const response = await this.fetcher(url, {
      headers: { Authorization: `Bearer ${process.env.SENTRY_AUTH_TOKEN || process.env.SENTRY_ACCESS_TOKEN}`, Accept: "application/json" },
      redirect: "error", signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) throw Error(`Sentry API HTTP ${response.status}`);
    return response;
  }
  private async poll(now: number): Promise<void> {
    const jobs = (await this.deps.getJobs()).filter(job => job.enabled !== false && job.hookConfig?.sentry).sort((a, b) => a.name.localeCompare(b.name));
    if (!jobs.length || this.controller.signal.aborted) return;
    const org = process.env.SENTRY_ORG!;
    const saved = getSentryPollStatus(this.store);
    const previous = saved?.organization === org ? saved : undefined;
    if (!/^[\w-]+$/.test(org)) {
      this.store.set("sentry-poller", "status", { ...previous, organization: org, error: "Invalid SENTRY_ORG", nextAttemptAt: now + INTERVAL });
      return;
    }
    this.store.set("sentry-poller", "status", { ...previous, organization: org, lastAttemptAt: now, nextAttemptAt: now + INTERVAL });
    try {
      const url = new URL(`/api/0/organizations/${encodeURIComponent(org)}/issues/`, API);
      url.searchParams.set("query", "is:unresolved");
      url.searchParams.set("sort", "new");
      url.searchParams.set("limit", String(PAGE_SIZE));
      if (previous?.cursor) url.searchParams.set("cursor", previous.cursor);
      const response = await this.request(url);
      const issues = parseSentry(z.array(issueSchema).max(PAGE_SIZE), await sentryJson(response));
      const cursor = nextCursor(response.headers.get("link"), url.pathname);
      let processed = 0;
      for (const issue of issues) {
        this.controller.signal.throwIfAborted();
        const receiptKey = hash([org, issue.id, jobs.map(job => [job.name, job.hookConfig?.sentry])]);
        const eventUrl = new URL(`/api/0/organizations/${encodeURIComponent(org)}/issues/${issue.id}/events/latest/`, API);
        const eventResponse = await this.request(eventUrl);
        const event = parseSentry(eventSchema, await sentryJson(eventResponse));
        const environment = event.environment ?? event.tags.find(tag => tag.key === "environment")?.value ?? "";
        const serverName = event.server_name ?? event.tags.find(tag => tag.key === "server_name")?.value ?? "";
        const revision = hash([issue.firstSeen, issue.status, environment, serverName, issue.level, issue.project.slug]);
        if (this.store.get<string>("sentry-poll-receipts", receiptKey)?.value === revision) continue;
        // Only the fields needed for matching and remediation enter the durable queue; no event-user data.
        const payload = { action: "created", data: { issue: { ...issue, metadata: { environment } }, environment, event: { environment, server_name: serverName } } };
        const parsed = readSentryPayload(payload);
        if (!parsed || !jobs.some(job => { const rule = job.hookConfig?.sentry; return rule && matchSentryRule(rule === true ? defaultSentryRule() : rule, parsed); })) {
          this.store.set("sentry-poll-receipts", receiptKey, revision);
          continue;
        }
        const id = `sentry-poll-${hash([org, issue.id, receiptKey, revision])}`;
        const delivery = { id, event: "sentry:issue", receivedAt: now, summary: `sentry · issue · ${issue.shortId}`, status: "ok" as const, matched: [] as string[], payloadSnippet: JSON.stringify(payload).slice(0, 2048) };
        recordDelivery(delivery);
        attachDeliveryPayload(id, payload);
        const routines = await dispatchSentryAlert(payload, "sentry:issue", id, delivery, { ...this.deps,
          getJobs: async () => (await this.deps.getJobs()).filter(job => job.enabled !== false && job.hookConfig?.sentry), onHookFire: (job, event, deliveryId, value, options) => this.deps.onHookFire(job, event, `${deliveryId}-${hash(job)}`, value, options),
        }, true);
        setDeliveryEvaluation(id, { pk: issue.id, fields: sentryExtractFields("sentry:issue", payload), keys: sentryExtractKeys("sentry:issue", payload), routines });
        if (routines.length) this.store.set("sentry-poll-receipts", receiptKey, revision);
        processed++;
      }
      this.store.set("sentry-poller", "status", { organization: org, lastAttemptAt: now, lastPollAt: now, cursor, processed, nextAttemptAt: now + (cursor ? 30_000 : INTERVAL) } satisfies SentryPollStatus);
    } catch (error) {
      if (this.controller.signal.aborted) return;
      this.store.set("sentry-poller", "status", { ...previous, organization: org, lastAttemptAt: now, nextAttemptAt: now + INTERVAL, error: error instanceof Error ? error.message : "Sentry polling failed" } satisfies SentryPollStatus);
    }
  }
}
