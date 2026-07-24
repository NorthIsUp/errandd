import { apiJSON } from "./client";

// ---------------------------------------------------------------------------
// Types — mirrors buildState() in src/ui/services/state.ts
// ---------------------------------------------------------------------------

export interface DaemonInfo {
  running: boolean;
  pid: number;
  startedAt: number;
  uptimeMs: number;
}

export interface HeartbeatInfo {
  enabled: boolean;
  intervalMinutes: number;
  nextAt: number | null;
  nextInMs: number | null;
}

export interface JobsRepoConfig {
  kind: "git" | "plugin";
  url: string;
  branch: string;
  intervalSeconds: number;
}

export interface RuntimeGit {
  sha?: string;
  sha8?: string;
  dirty?: boolean;
  branch?: string;
  commitUrl?: string;
  tag?: string | null;
  describe?: string | null;
}

export interface JobSummary {
  name: string;
  /** All cron schedules for this routine (empty for event-only). */
  schedules: string[];
  /** First schedule, kept for back-compat with single-cron consumers. */
  schedule: string;
  prompt: string;
  running: boolean;
  lastResult: "ok" | "error" | "skipped" | "pass" | null;
  lastRanAt: number | null;
}

export interface SecuritySettings {
  level: string;
}

/** A registered MCP server, surfaced read-only in Settings. */
export interface McpServerSummary {
  name: string;
  transport: "stdio" | "http" | "sse";
  /** For stdio: the command + args string. For http/sse: the URL. */
  target: string;
}

export interface StateResponse {
  daemon: DaemonInfo;
  model: string;
  fallback: { model: string; api: string } | string;
  /** When true, spawned sessions run in Claude Code's multi-agent
   *  orchestration ("ultracode") mode. */
  ultracode: boolean;
  /** Registered MCP servers, read-only (empty when the runtime has no
   *  `claude mcp` CLI or the list call fails). */
  mcpServers: McpServerSummary[];
  jobsRepo: JobsRepoConfig | null; // back-compat
  jobsRepos: JobsRepoConfig[];
  timezone: string;
  timezoneOffsetMinutes: number;
  heartbeat: HeartbeatInfo;
  jobs: JobSummary[];
  security: SecuritySettings;
  telegram: { configured: boolean; allowedUserCount: number };
  discord: { configured: boolean; allowedUserCount: number };
  session: {
    sessionIdShort: string;
    createdAt: string;
    lastUsedAt: string;
  } | null;
  web: Record<string, unknown>;
  /** `managed` is true when the identity is set via env (GitOps) rather than
   *  the writable settings file — the UI then renders it read-only. */
  git: { name: string; email: string; managed?: boolean };
  /** Populated when the request came in over a trusted Tailscale proxy
   *  (daemon launched with `--web-trust-tailnet`) and carried the
   *  `Tailscale-User-Login` header. Null in the token/cookie path. */
  tailnet: {
    login: string;
    displayName?: string;
    tailnet?: string;
  } | null;
  runtime: {
    git: RuntimeGit;
    version: string | null;
    /** Active exec runtime id: "claude" | "pi". */
    id?: string;
    /** The binary the daemon spawns (e.g. "pi", or a full path). */
    executable?: string;
    /** Feature flags for the active runtime, driving graceful UI degradation
     *  (e.g. the plugins card only renders when `supportsPlugins`). */
    capabilities?: {
      supportsResume: boolean;
      reportsContextTokens: boolean;
      supportsPlugins: boolean;
      supportsMcpCli: boolean;
    };
  };
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

export function getState(): Promise<StateResponse> {
  return apiJSON<StateResponse>("/api/state");
}
