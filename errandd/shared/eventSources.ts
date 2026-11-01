/** Shared, validated source connection settings. Credentials stay in deployment env. */
export type CveDeliveryMode = "webhook" | "poll" | "both";
export interface CveConnection {
  mode: CveDeliveryMode;
  feedFormat: "official" | "rss";
  feedUrl: string;
  intervalMinutes: number;
  githubAdvisories?: boolean;
}
/** Preserve pre-settings behavior: webhooks and per-errand polling are both eligible. */
export const defaultCveConnection = (): CveConnection => ({
  mode: "both",
  feedFormat: "official",
  feedUrl: "",
  intervalMinutes: 1,
  githubAdvisories: true,
});
export function parseCveConnection(value: unknown): CveConnection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected source settings");
  const raw = value as Record<string, unknown>;
  if (raw.mode !== "webhook" && raw.mode !== "poll" && raw.mode !== "both")
    throw new Error("Unknown delivery mode");
  if (raw.feedFormat !== "official" && raw.feedFormat !== "rss")
    throw new Error("Unknown feed format");
  if (
    typeof raw.intervalMinutes !== "number" ||
    !Number.isInteger(raw.intervalMinutes) ||
    raw.intervalMinutes < 1 ||
    raw.intervalMinutes > 1440
  )
    throw new Error("Polling interval must be 1–1440 minutes");
  if (raw.githubAdvisories !== undefined && typeof raw.githubAdvisories !== "boolean")
    throw new Error("GitHub advisories must be enabled or disabled");
  const feedUrl = typeof raw.feedUrl === "string" ? raw.feedUrl.trim() : "";
  if (feedUrl.length > 2048) throw new Error("Feed URL is too long");
  if (raw.feedFormat === "rss" && (raw.mode !== "webhook" || feedUrl)) {
    let url: URL;
    try {
      url = new URL(feedUrl);
    } catch {
      throw new Error("Enter an RSS/Atom feed URL");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("Use an HTTP(S) feed URL without embedded credentials");
  }
  return {
    mode: raw.mode,
    feedFormat: raw.feedFormat,
    feedUrl,
    intervalMinutes: raw.intervalMinutes,
    githubAdvisories: raw.githubAdvisories !== false,
  };
}
export const pollsCves = (connection: CveConnection): boolean => connection.mode !== "webhook";
export const acceptsCveWebhooks = (connection: CveConnection): boolean =>
  connection.mode !== "poll";
export interface EventSourceInfo {
  id: string;
  url: string;
  configured: boolean;
  webhookConfigured?: boolean;
  pollingConfigured?: boolean;
  secretEnv: string;
  modes: CveDeliveryMode[];
  payloadTemplate?: unknown;
  botMention?: string;
  errands: { name: string; enabled: boolean; polling: boolean }[];
  connection?: CveConnection;
  githubPollStatus?: {
    lastPollAt: number;
    processed?: number;
    error?: string;
    catchingUp?: boolean;
  };
  pollStatus?: { lastPollAt?: number; processed?: number; error?: string; catchingUp?: boolean };
}
