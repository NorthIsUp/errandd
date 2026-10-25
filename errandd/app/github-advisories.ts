/** Incremental, restart-safe discovery from GitHub's reviewed Advisory API. */
import { readGithubAdvisory, type CveAlert } from "../shared/cve";
import type { AdvisoryStore } from "./cve-store";
const API = "https://api.github.com/advisories";
interface Cursor {
  since: string;
  window?: { until: string; after?: string };
}
export class GithubAdvisoryPoller {
  constructor(
    private readonly store: AdvisoryStore,
    private readonly consume: (alert: CveAlert) => Promise<void>,
    private readonly fetcher: typeof fetch = fetch,
    private readonly signal?: AbortSignal,
  ) {}
  async poll(now = Date.now()): Promise<void> {
    let cursor = this.store.get<Cursor>("github-advisories", "cursor")?.value;
    try {
      if (!cursor) {
        // No historical flood when enabling a source. The next pass catches
        // updates since this baseline, including delayed publications.
        this.store.set("github-advisories", "cursor", { since: new Date(now).toISOString() });
        this.store.set("github-advisories", "status", {
          lastPollAt: now,
          initialized: true,
          processed: 0,
        });
        return;
      }
      if (!Number.isFinite(Date.parse(cursor.since)))
        throw new Error("Invalid GitHub advisory cursor");
      const window = cursor.window ?? { until: new Date(now).toISOString() };
      if (!Number.isFinite(Date.parse(window.until)))
        throw new Error("Invalid GitHub advisory window");
      const url = new URL(API);
      url.search = new URLSearchParams({
        type: "reviewed",
        sort: "updated",
        direction: "asc",
        per_page: "100",
        // Inclusive overlap plus SQL material receipts handles equal timestamps.
        // GitHub rejects fractional seconds in advisory date-range filters.
        updated: `${new Date(cursor.since).toISOString().replace(/\.\d{3}Z$/, "Z")}..${new Date(window.until).toISOString().replace(/\.\d{3}Z$/, "Z")}`,
        ...(window.after ? { after: window.after } : {}),
      }).toString();
      const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
      const response = await this.fetcher(url.href, {
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "errandd-cve-monitor",
          "X-GitHub-Api-Version": "2026-03-10",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.any([
          AbortSignal.timeout(30_000),
          ...(this.signal ? [this.signal] : []),
        ]),
      });
      if (!response.ok) throw new Error(`GitHub advisories HTTP ${response.status}`);
      // A page is capped at 100 records; also bound the response body.
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty GitHub advisory response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8 * 1024 * 1024) throw new Error("GitHub advisory page exceeds 8 MiB");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const values: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(values) || values.length > 100)
        throw new Error("Invalid GitHub advisory page");
      let processed = 0;
      for (const value of values) {
        const alert = readGithubAdvisory(value);
        if (!alert) throw new Error("Invalid reviewed GitHub advisory");
        this.signal?.throwIfAborted();
        await this.consume(alert);
        processed++;
      }
      const next = response.headers
        .get("link")
        ?.split(",")
        .find((value) => /;\s*rel="next"/.test(value));
      if (next) {
        const href = /<([^>]+)>/.exec(next)?.[1];
        const link = href ? new URL(href) : null;
        const after = link?.searchParams.get("after");
        if (
          link?.origin !== new URL(API).origin ||
          link.pathname !== "/advisories" ||
          !after ||
          after.length > 2048 ||
          after === window.after
        )
          throw new Error("Invalid GitHub advisory pagination");
        cursor = { since: cursor.since, window: { until: window.until, after } };
      } else {
        cursor = { since: window.until };
      }
      this.store.set("github-advisories", "cursor", cursor);
      this.store.set("github-advisories", "status", {
        lastPollAt: now,
        processed,
        catchingUp: Boolean(cursor.window),
      });
    } catch (error) {
      this.store.set("github-advisories", "status", { lastPollAt: now, error: String(error) });
      throw error;
    }
  }
}
