import { join, isAbsolute } from "path";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { normalizeTimezoneName, resolveTimezoneOffsetMinutes } from "./timezone";
import { parseWatchdogConfig, type WatchdogConfig } from "./watchdog";
import { parsePlugins, type PluginEntry } from "./plugins";
import { applyEnvOverrides } from "./env-overrides";

/** Re-exported under the name used in the Settings interface. */
export type WatchdogSettings = WatchdogConfig;

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "errandd");
const SETTINGS_FILE = join(HEARTBEAT_DIR, "settings.json");
const DEFAULT_JOBS_DIR = join(HEARTBEAT_DIR, "jobs");
/** Legacy single-repo clone dir — kept for migration compatibility. */
const JOBS_REPO_DIR = join(HEARTBEAT_DIR, "jobs-repo");
/** New multi-repo parent dir — each repo lives under <slug>/. */
const JOBS_REPOS_DIR = join(HEARTBEAT_DIR, "jobs-repos");
const LOGS_DIR = join(HEARTBEAT_DIR, "logs");

/** Default Claude session timeout (30 minutes). Exported so runner.ts can reference the same value. */
export const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export const DEFAULT_IMAGE_OUTPUT_ROOT = join(HEARTBEAT_DIR, "outbox", "discord");

export function getJobsDir(): string {
  return getJobsDirs()[0];
}

/**
 * Return the list of job directories in priority order.
 * When repos are configured each repo's clone dir comes first,
 * then the default local-only jobs dir is appended last.
 * When no repos are configured (or jobsDir override is set) falls back to a single dir.
 */
export function getJobsDirs(): string[] {
  // Legacy jobsDir override wins as a single dir.
  if (cached?.jobsDir) {
    const d = cached.jobsDir;
    return [isAbsolute(d) ? d : join(process.cwd(), d)];
  }
  const repos = cached?.jobsRepos ?? [];
  if (repos.length > 0) {
    const repoDirs = repos
      .filter((r) => r.url)
      .map((r) => getJobsRepoDirForRepo(r));
    return [...repoDirs, DEFAULT_JOBS_DIR];
  }
  // Legacy single-repo field fallback (pre-migration, no jobsRepos yet)
  if (cached?.jobsRepo?.url) return [JOBS_REPO_DIR];
  return [DEFAULT_JOBS_DIR];
}

/**
 * Derive a filesystem-safe slug from a git URL.
 * - strip trailing .git
 * - take the last path segment
 * - lowercase, replace non-[a-z0-9-] with -, collapse runs of -
 * - if empty, use a short sha256 hash of the URL
 */
export function slugForRepo(url: string, existingSlugs = new Set<string>()): string {
  const noGit = url.replace(/\.git$/i, "");
  const segment = noGit.split(/[\\/]/).filter(Boolean).pop() ?? "";
  let slug = segment.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!slug) slug = shortHash(url);
  if (existingSlugs.has(slug)) {
    slug = slug + "-" + shortHash(url);
  }
  return slug;
}

function shortHash(s: string): string {
  // Simple deterministic short hash — not crypto-strength, just for collision avoidance.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 8);
}

/** Return the clone directory for a given repo config. */
export function getJobsRepoDirForRepo(repo: JobsRepoConfig | string): string {
  const slug =
    typeof repo === "string"
      ? slugForRepo(repo)
      : repo.slug ?? slugForRepo(repo.url);
  return join(JOBS_REPOS_DIR, slug);
}

/** Legacy single-repo clone dir — kept so existing code that calls getJobsRepoDir() still works. */
export function getJobsRepoDir(): string {
  return JOBS_REPO_DIR;
}

/** Legacy single-repo dir constant — exported for migration code. */
export const LEGACY_JOBS_REPO_DIR = JOBS_REPO_DIR;

/** The parent directory for multi-repo clones. */
export const JOBS_REPOS_PARENT_DIR = JOBS_REPOS_DIR;

/** Return the first configured jobs repo, or null. */
export function firstJobsRepo(): JobsRepoConfig | null {
  return cached?.jobsRepos?.[0] ?? (cached?.jobsRepo?.url ? cached.jobsRepo : null);
}

/** Returns the root directory for agent-scoped sessions and jobs. */
export function getAgentsDir(): string {
  return join(process.cwd(), "agents");
}

const DEFAULT_SETTINGS: Settings = {
  runtime: "claude",
  model: "",
  api: "",
  fallback: {
    model: "",
    api: "",
  },
  agentic: {
    enabled: false,
    defaultMode: "implementation",
    modes: [
      {
        name: "planning",
        model: "opus",
        keywords: [
          "plan", "design", "architect", "strategy", "approach",
          "research", "investigate", "analyze", "explore", "understand",
          "think", "consider", "evaluate", "assess", "review",
          "system design", "trade-off", "decision", "choose", "compare",
          "brainstorm", "ideate", "concept", "proposal",
        ],
        phrases: [
          "how to implement", "how should i", "what's the best way to",
          "should i", "which approach", "help me decide", "help me understand",
        ],
      },
      {
        name: "implementation",
        model: "sonnet",
        keywords: [
          "implement", "code", "write", "create", "build", "add",
          "fix", "debug", "refactor", "update", "modify", "change",
          "deploy", "run", "execute", "install", "configure",
          "test", "commit", "push", "merge", "release",
          "generate", "scaffold", "setup", "initialize",
        ],
      },
    ],
  },
  timezone: "UTC",
  timezoneOffsetMinutes: 0,
  heartbeat: {
    enabled: true,
    interval: 15,
    prompt: "",
    excludeWindows: [],
    forwardToTelegram: true,
  },
  telegram: { token: "", allowedUserIds: [], listenChats: [], receiveEnabled: true, dmIsolation: "shared" },
  discord: { token: "", allowedUserIds: [], listenChannels: [], listenGuilds: [], allowedGuilds: [], imageOutputRoots: [], streaming: false },
  slack: { botToken: "", appToken: "", allowedUserIds: [], listenChannels: [], allowBots: [], allowBotIds: [] },
  security: { level: "moderate", allowedTools: [], disallowedTools: [] },
  web: { enabled: false, host: "127.0.0.1", port: 4632 },
  stt: { baseUrl: "", model: "" },
  sessionTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
  timeouts: { telegram: 5, heartbeat: 15, job: 30, default: 5 },
  watchdog: { maxConsecutiveTimeouts: null, maxRuntimeSeconds: null },
  session: { autoRotate: false, maxMessages: 50, maxAgeHours: 24, summaryPath: "" },
  plugins: {},
  jobsRepo: { kind: "git", url: "", branch: "main", intervalSeconds: 300 },
  jobsRepos: [],
  git: { name: "", email: "" },
  hooks: { defaultPrRepo: ["*/*"], defaultPrUser: ["*"] },
};

export interface HeartbeatExcludeWindow {
  days?: number[];
  start: string;
  end: string;
}

export interface HeartbeatConfig {
  enabled: boolean;
  interval: number;
  prompt: string;
  excludeWindows: HeartbeatExcludeWindow[];
  forwardToTelegram: boolean;
}

export interface TelegramConfig {
  token: string;
  allowedUserIds: number[];
  listenChats: number[];
  /** When false, skip Telegram polling (incoming messages). Useful for send-only instances. Default: true */
  receiveEnabled: boolean;
  /**
   * Controls session isolation for Telegram DMs.
   * - "shared": all DMs share the global session (matches Discord DM behaviour). Default.
   * - "perUser": each DM user gets their own isolated session.
   */
  dmIsolation: "shared" | "perUser";
  /** Local whisper.cpp model for voice transcription. Default: "base.en".
   *  Supported values: tiny, base, small, medium, large-v3, large-v3-turbo (with or without .en suffix).
   *  Ignored when stt.baseUrl is configured. */
  whisperModel?: string;
}

export interface DiscordConfig {
  token: string;
  allowedUserIds: string[]; // Discord snowflake IDs exceed Number.MAX_SAFE_INTEGER
  listenChannels: string[]; // Channel IDs where bot responds to all messages (no mention needed)
  listenGuilds: string[]; // Guild IDs where bot responds to all messages in any channel/thread
  allowedGuilds: string[]; // Guild IDs where the bot will post a welcome message on join (empty = silent)
  channelNames?: Record<string, string>; // channelId -> friendly name for system prompt context
  imageOutputRoots: string[]; // Absolute path prefixes from which image uploads are permitted
  streaming?: boolean; // When true, POST a live preview while Claude is working. Default: false.
}

export interface SlackConfig {
  botToken: string;       // xoxb-... bot token
  appToken: string;       // xapp-... Socket Mode token
  allowedUserIds: string[];
  listenChannels: string[]; // Channel IDs where bot responds without @mention
  allowBots: string[];    // Channel IDs where bot-posted messages are passed through
  allowBotIds: string[];  // Optional: Slack app/bot IDs (B...) that may post; empty = any bot in allowBots channel
}

export type SecurityLevel =
  | "locked"
  | "strict"
  | "moderate"
  | "unrestricted";

export interface SecurityConfig {
  level: SecurityLevel;
  allowedTools: string[];
  disallowedTools: string[];
}

export interface TimeoutsConfig {
  /** Max minutes for a telegram message subprocess. Default: 5 min. */
  telegram: number;
  /** Max minutes for a heartbeat subprocess. Default: 15 min. */
  heartbeat: number;
  /** Max minutes for a scheduled job subprocess. Default: 30 min. */
  job: number;
  /** Max minutes for all other subprocesses (bootstrap, trigger, etc). Default: 5 min. */
  default: number;
}

export interface Settings {
  /** Which coding-agent CLI the daemon shells out to. Default "claude".
   *  Override via settings.json or ERRANDD_RUNTIME. */
  runtime: "claude" | "pi";
  model: string;
  api: string;
  fallback: ModelConfig;
  agentic: AgenticConfig;
  timezone: string;
  timezoneOffsetMinutes: number;
  heartbeat: HeartbeatConfig;
  telegram: TelegramConfig;
  discord: DiscordConfig;
  slack: SlackConfig;
  security: SecurityConfig;
  web: WebConfig;
  stt: SttConfig;
  apiToken?: string;
  sessionTimeoutMs: number;
  timeouts: TimeoutsConfig;
  watchdog: WatchdogSettings;
  plugins: Record<string, PluginEntry>;
  session: SessionConfig;
  jobsDir?: string;
  /** @deprecated single-repo form; migrated into `jobsRepos[0]` at parse time. The on-disk
   *  JSON may still carry this key until the user saves from the Settings UI. */
  jobsRepo: JobsRepoConfig;
  /** Multi-repo list. Takes precedence over legacy `jobsRepo` when non-empty. */
  jobsRepos: JobsRepoConfig[];
  /** Identity to attribute UI-triggered git commits to. Required in
   *  containerized deployments where `git config --global user.email` is
   *  unset — without it `git commit` errors with "Author identity unknown". */
  git: GitIdentityConfig;
  /** Defaults applied to a filtered `pr:` hook rule when it omits `repo`/`user`
   *  (e.g. a label-only rule like pr-babysit). Both default to "any". Override
   *  in settings.json — e.g. set `defaultPrUser: ["*", "!*[bot]"]` to exclude
   *  bots fleet-wide on public repos. */
  hooks: HooksConfig;
}

export interface GitIdentityConfig {
  name: string;
  email: string;
}

export interface HooksConfig {
  /** Default `repo` glob list for a filtered `pr:` rule that omits it. */
  defaultPrRepo: string[];
  /** Default `user` glob list for a filtered `pr:` rule that omits it. */
  defaultPrUser: string[];
}


export interface AgenticMode {
  name: string;
  model: string;
  keywords: string[];
  phrases?: string[];
}

export interface AgenticConfig {
  enabled: boolean;
  defaultMode: string;
  modes: AgenticMode[];
}

export interface ModelConfig {
  model: string;
  api: string;
}

export interface WebConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface SttConfig {
  /** Base URL of an OpenAI-compatible STT API, e.g. "http://127.0.0.1:8000".
   *  When set, errandd routes voice transcription through this API instead
   *  of the bundled whisper.cpp binary. */
  baseUrl: string;
  /** Model name passed to the API (default: "Systran/faster-whisper-large-v3") */
  model: string;
  /** MCP tool name or CLI command to delegate transcription to (e.g. "mcp__whisper__transcribe"
   *  or "whisper"). When set, whisper is skipped and Claude is asked to call this tool directly
   *  with the audio file path. When unset (default), whisper handles transcription. */
  delegateTool?: string;
}

export interface SessionConfig {
  /** Automatically rotate the global session when a threshold is exceeded. Default: false. */
  autoRotate: boolean;
  /** Rotate after this many messages. Default: 50. */
  maxMessages: number;
  /** Rotate after this many hours. Default: 24. */
  maxAgeHours: number;
  /** Directory to write markdown summaries before rotation. Empty string disables summaries. */
  summaryPath: string;
}

export interface JobsRepoConfig {
  /** Kind of source.
   *  - "git" (default): clone a git repo and read .md routines from it.
   *  - "plugin": install via `claude plugin install` and read routines from
   *    the plugin's install path.  `url` carries `<marketplace>/<plugin>`. */
  kind: "git" | "plugin";
  /** Git remote URL (kind=git) or `<marketplace>/<plugin>` (kind=plugin).
   *  Empty string disables the jobs-repo feature. */
  url: string;
  /** Branch to track (git only — ignored for plugins). Default "main". */
  branch: string;
  /** Seconds between automatic pulls. Default 300; 0 disables periodic pull. */
  intervalSeconds: number;
  /** Filesystem-safe identifier, computed once at config parse with
   *  collision-avoidance across the configured list. Consumers MUST read
   *  this rather than recomputing `slugForRepo(url)` with an empty set —
   *  doing so would merge two URL-colliding repos onto the same dir.
   *  Falls back to `slugForRepo(url)` when absent (e.g. test/env-built configs). */
  slug?: string;
}

let cached: Settings | null = null;

export async function initConfig(): Promise<void> {
  await mkdir(HEARTBEAT_DIR, { recursive: true });
  await mkdir(getJobsDir(), { recursive: true });
  await mkdir(LOGS_DIR, { recursive: true });

  if (!existsSync(SETTINGS_FILE)) {
    await Bun.write(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n");
  }
}

const VALID_LEVELS = new Set<SecurityLevel>([
  "locked",
  "strict",
  "moderate",
  "unrestricted",
]);

/** Narrow an unknown to a string-keyed record for safe optional reads. */
function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function parseAgenticMode(raw: unknown): AgenticMode | null {
  if (!raw || typeof raw !== "object") return null;
  const r = asRecord(raw);
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const model = typeof r.model === "string" ? r.model.trim() : "";
  if (!name || !model) return null;
  const keywords = Array.isArray(r.keywords)
    ? r.keywords.filter((k): k is string => typeof k === "string").map((k) => k.toLowerCase().trim())
    : [];
  const phrases = Array.isArray(r.phrases)
    ? r.phrases.filter((p): p is string => typeof p === "string").map((p) => p.toLowerCase().trim())
    : undefined;
  return { name, model, keywords, ...(phrases && phrases.length > 0 ? { phrases } : {}) };
}

function parseAgenticConfig(raw: unknown): AgenticConfig {
  const defaults = DEFAULT_SETTINGS.agentic;
  if (!raw || typeof raw !== "object") return defaults;
  const r = asRecord(raw);

  const enabled = r.enabled === true;

  // Backward compat: old planningModel/implementationModel format
  if (!Array.isArray(r.modes) && ("planningModel" in r || "implementationModel" in r)) {
    const planningModel = typeof r.planningModel === "string" ? r.planningModel.trim() : "opus";
    const implModel = typeof r.implementationModel === "string" ? r.implementationModel.trim() : "sonnet";
    return {
      enabled,
      defaultMode: "implementation",
      modes: [
        { ...defaults.modes[0], model: planningModel },
        { ...defaults.modes[1], model: implModel },
      ],
    };
  }

  // New modes format
  const modes: AgenticMode[] = [];
  if (Array.isArray(r.modes)) {
    for (const m of r.modes) {
      const parsed = parseAgenticMode(m);
      if (parsed) modes.push(parsed);
    }
  }

  return {
    enabled,
    defaultMode: typeof r.defaultMode === "string" ? r.defaultMode.trim() : "implementation",
    modes: modes.length > 0 ? modes : defaults.modes,
  };
}

function parseJobsRepoConfig(raw: unknown): JobsRepoConfig {
  const r = asRecord(raw);
  return {
    kind: r.kind === "plugin" ? "plugin" : "git",
    url: typeof r.url === "string" ? r.url.trim() : "",
    branch: typeof r.branch === "string" && r.branch.trim() ? r.branch.trim() : "main",
    intervalSeconds: Number.isFinite(r.intervalSeconds) && Number(r.intervalSeconds) >= 0
      ? Number(r.intervalSeconds) : 300,
  };
}

/**
 * Parse and migrate jobsRepo/jobsRepos.
 * - jobsRepos (array) wins if non-empty.
 * - Otherwise, if legacy jobsRepo.url is set, lift it into jobsRepos[0].
 * - Otherwise jobsRepos = [].
 *
 * Each config's `slug` is computed ONCE here, with collision-avoidance across
 * the list, so every downstream consumer (clone dir, status, lookup) reads a
 * single stable identifier instead of recomputing it with an empty set.
 */
function parseJobsRepos(raw: Record<string, unknown>): JobsRepoConfig[] {
  let repos: JobsRepoConfig[];
  // New array form wins if present and non-empty
  if (Array.isArray(raw.jobsRepos) && raw.jobsRepos.length > 0) {
    repos = raw.jobsRepos
      .filter((r) => {
        if (!r || typeof r !== "object") return false;
        const url = asRecord(r).url;
        return typeof url === "string" && url.trim() !== "";
      })
      .map(parseJobsRepoConfig);
  } else {
    // Legacy single-repo form: lift into array
    const jobsRepo = asRecord(raw.jobsRepo);
    const legacyUrl = typeof jobsRepo.url === "string" ? jobsRepo.url.trim() : "";
    repos = legacyUrl ? [parseJobsRepoConfig(raw.jobsRepo)] : [];
  }
  return assignSlugs(repos);
}

/** Stamp each repo with a collision-avoided slug, first occurrence wins. */
function assignSlugs(repos: JobsRepoConfig[]): JobsRepoConfig[] {
  const seen = new Set<string>();
  for (const repo of repos) {
    const slug = slugForRepo(repo.url, seen);
    seen.add(slug);
    repo.slug = slug;
  }
  return repos;
}

function parseSettings(
  raw: Record<string, unknown>,
  discordUserIds?: string[],
): Settings {
  const security = asRecord(raw.security);
  const fallback = asRecord(raw.fallback);
  const hooks = asRecord(raw.hooks);
  const heartbeat = asRecord(raw.heartbeat);
  const telegram = asRecord(raw.telegram);
  const discord = asRecord(raw.discord);
  const slack = asRecord(raw.slack);
  const web = asRecord(raw.web);
  const stt = asRecord(raw.stt);
  const timeouts = asRecord(raw.timeouts);
  const session = asRecord(raw.session);
  const git = asRecord(raw.git);

  const rawLevel = security.level;
  const level: SecurityLevel =
    typeof rawLevel === "string" && VALID_LEVELS.has(rawLevel as SecurityLevel)
      ? (rawLevel as SecurityLevel)
      : "moderate";

  const parsedTimezone = parseTimezone(raw.timezone);

  return {
    runtime: raw.runtime === "pi" ? "pi" : "claude",
    model: typeof raw.model === "string" ? raw.model.trim() : "",
    api: typeof raw.api === "string" ? raw.api.trim() : "",
    fallback: {
      model: typeof fallback.model === "string" ? fallback.model.trim() : "",
      api: typeof fallback.api === "string" ? fallback.api.trim() : "",
    },
    agentic: parseAgenticConfig(raw.agentic),
    // `hooks` was previously omitted from the parsed result, so a configured
    // `settings.hooks.defaultPrRepo`/`defaultPrUser` was silently ignored (the
    // consumer fell back to the built-in default). Strict mode surfaced it.
    hooks: {
      defaultPrRepo: Array.isArray(hooks.defaultPrRepo)
        ? hooks.defaultPrRepo.filter((x): x is string => typeof x === "string")
        : ["*/*"],
      defaultPrUser: Array.isArray(hooks.defaultPrUser)
        ? hooks.defaultPrUser.filter((x): x is string => typeof x === "string")
        : ["*"],
    },
    timezone: parsedTimezone,
    timezoneOffsetMinutes: parseTimezoneOffsetMinutes(raw.timezoneOffsetMinutes, parsedTimezone),
    heartbeat: {
      enabled: heartbeat.enabled === true,
      interval: typeof heartbeat.interval === "number" ? heartbeat.interval : 15,
      prompt: typeof heartbeat.prompt === "string" ? heartbeat.prompt : "",
      excludeWindows: parseExcludeWindows(heartbeat.excludeWindows),
      forwardToTelegram: heartbeat.forwardToTelegram === true,
    },
    telegram: {
      token: typeof telegram.token === "string" ? telegram.token.trim() : "",
      allowedUserIds: Array.isArray(telegram.allowedUserIds)
        ? telegram.allowedUserIds.filter((x): x is number => typeof x === "number")
        : [],
      listenChats: Array.isArray(telegram.listenChats) ? telegram.listenChats.map((x) => Number(x)) : [],
      receiveEnabled: telegram.receiveEnabled !== false,
      dmIsolation: telegram.dmIsolation === "perUser" ? "perUser" : "shared",
      ...(typeof telegram.whisperModel === "string" && telegram.whisperModel.trim()
        ? { whisperModel: telegram.whisperModel.trim() }
        : {}),
    },
    discord: {
      token: typeof discord.token === "string" ? discord.token.trim() : "",
      allowedUserIds: Array.isArray(discordUserIds) && discordUserIds.length > 0
        ? discordUserIds
        : Array.isArray(discord.allowedUserIds)
          ? discord.allowedUserIds.map((x) => String(x))
          : [],
      listenChannels: Array.isArray(discord.listenChannels)
        ? discord.listenChannels.map((x) => String(x))
        : [],
      listenGuilds: Array.isArray(discord.listenGuilds)
        ? discord.listenGuilds.map((x) => String(x))
        : [],
      allowedGuilds: Array.isArray(discord.allowedGuilds)
        ? discord.allowedGuilds.map((x) => String(x))
        : [],
      channelNames: discord.channelNames && typeof discord.channelNames === "object"
        ? Object.fromEntries(
            Object.entries(discord.channelNames as Record<string, unknown>).map(([k, v]) => [String(k), String(v)]),
          )
        : undefined,
      imageOutputRoots: Array.isArray(discord.imageOutputRoots)
        ? discord.imageOutputRoots.filter((r): r is string => typeof r === "string" && isAbsolute(r))
        : [],
      streaming: discord.streaming === true,
    },
    slack: {
      botToken: typeof slack.botToken === "string" ? slack.botToken.trim() : "",
      appToken: typeof slack.appToken === "string" ? slack.appToken.trim() : "",
      allowedUserIds: Array.isArray(slack.allowedUserIds) ? slack.allowedUserIds.map((x) => String(x)) : [],
      listenChannels: Array.isArray(slack.listenChannels) ? slack.listenChannels.map((x) => String(x)) : [],
      allowBots: Array.isArray(slack.allowBots) ? slack.allowBots.map((x) => String(x)) : [],
      allowBotIds: Array.isArray(slack.allowBotIds) ? slack.allowBotIds.map((x) => String(x)) : [],
    },
    security: {
      level,
      allowedTools: Array.isArray(security.allowedTools)
        ? security.allowedTools.filter((x): x is string => typeof x === "string")
        : [],
      disallowedTools: Array.isArray(security.disallowedTools)
        ? security.disallowedTools.filter((x): x is string => typeof x === "string")
        : [],
    },
    web: {
      enabled: web.enabled === true,
      host: typeof web.host === "string" ? web.host : "127.0.0.1",
      port: typeof web.port === "number" && Number.isFinite(web.port) ? web.port : 4632,
    },
    stt: {
      baseUrl: typeof stt.baseUrl === "string" ? stt.baseUrl.trim() : "",
      model: typeof stt.model === "string" ? stt.model.trim() : "",
      ...(typeof stt.delegateTool === "string" && stt.delegateTool.trim()
        ? { delegateTool: stt.delegateTool.trim() }
        : {}),
    },
    sessionTimeoutMs: typeof raw.sessionTimeoutMs === "number" && raw.sessionTimeoutMs > 0
      ? raw.sessionTimeoutMs
      : DEFAULT_SESSION_TIMEOUT_MS,
    timeouts: {
      telegram: Number.isFinite(timeouts.telegram) && Number(timeouts.telegram) > 0 ? Number(timeouts.telegram) : 5,
      heartbeat: Number.isFinite(timeouts.heartbeat) && Number(timeouts.heartbeat) > 0 ? Number(timeouts.heartbeat) : 15,
      job: Number.isFinite(timeouts.job) && Number(timeouts.job) > 0 ? Number(timeouts.job) : 30,
      default: Number.isFinite(timeouts.default) && Number(timeouts.default) > 0 ? Number(timeouts.default) : 5,
    },
    watchdog: parseWatchdogConfig(raw.watchdog),
    plugins: parsePlugins(raw.plugins),
    session: {
      autoRotate: session.autoRotate === true,
      maxMessages: Number.isFinite(session.maxMessages) ? Number(session.maxMessages) : 50,
      maxAgeHours: Number.isFinite(session.maxAgeHours) ? Number(session.maxAgeHours) : 24,
      summaryPath: typeof session.summaryPath === "string" ? session.summaryPath.trim() : "",
    },
    apiToken: typeof raw.apiToken === "string" && raw.apiToken.trim() ? raw.apiToken.trim() : undefined,
    ...(typeof raw.jobsDir === "string" && raw.jobsDir.trim() ? { jobsDir: raw.jobsDir.trim() } : {}),
    jobsRepo: parseJobsRepoConfig(raw.jobsRepo),
    jobsRepos: parseJobsRepos(raw),
    git: {
      name: typeof git.name === "string" ? git.name.trim() : "",
      email: typeof git.email === "string" ? git.email.trim() : "",
    },
  };
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function parseTimezone(value: unknown): string {
  return normalizeTimezoneName(value);
}

function parseExcludeWindows(value: unknown): HeartbeatExcludeWindow[] {
  if (!Array.isArray(value)) return [];
  const out: HeartbeatExcludeWindow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const e = asRecord(entry);
    const start = typeof e.start === "string" ? e.start.trim() : "";
    const end = typeof e.end === "string" ? e.end.trim() : "";
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) continue;

    const rawDays = Array.isArray(e.days) ? e.days : [];
    const parsedDays = rawDays
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    const uniqueDays = Array.from(new Set<number>(parsedDays)).sort((a, b) => a - b);

    out.push({
      start,
      end,
      days: uniqueDays.length > 0 ? uniqueDays : [...ALL_DAYS],
    });
  }
  return out;
}

function parseTimezoneOffsetMinutes(value: unknown, timezoneFallback?: string): number {
  return resolveTimezoneOffsetMinutes(value, timezoneFallback);
}

/**
 * Extract discord.allowedUserIds as raw strings from the JSON text.
 * JSON.parse destroys precision on large numeric snowflakes (>2^53),
 * so we regex them out of the raw text first.
 */
function extractDiscordUserIds(rawText: string): string[] {
  // Match the "discord" object's "allowedUserIds" array values
  const discordBlock = /"discord"\s*:\s*\{[\s\S]*?\}/.exec(rawText);
  if (!discordBlock) return [];
  const arrayMatch = /"allowedUserIds"\s*:\s*\[([\s\S]*?)\]/.exec(discordBlock[0]);
  if (!arrayMatch) return [];
  const items: string[] = [];
  // Match both quoted strings and bare numbers
  for (const m of arrayMatch[1].matchAll(/("(\d+)"|(\d+))/g)) {
    items.push(m[2] ?? m[3]);
  }
  return items;
}

/** Clamp an env-overridden security level back to a valid value. */
function validateSecurityLevel(settings: Settings): Settings {
  if (!VALID_LEVELS.has(settings.security.level)) {
    console.warn(`[config] Invalid security level "${settings.security.level}" — falling back to "moderate"`);
    settings.security.level = "moderate";
  }
  return settings;
}

export async function loadSettings(): Promise<Settings> {
  if (cached) return cached;
  const rawText = await Bun.file(SETTINGS_FILE).text();
  const raw = JSON.parse(rawText) as Record<string, unknown>;
  cached = validateSecurityLevel(applyEnvOverrides(parseSettings(raw, extractDiscordUserIds(rawText))));
  return cached;
}

/** Re-read settings from disk, bypassing cache. */
export async function reloadSettings(): Promise<Settings> {
  const rawText = await Bun.file(SETTINGS_FILE).text();
  const raw = JSON.parse(rawText) as Record<string, unknown>;
  cached = validateSecurityLevel(applyEnvOverrides(parseSettings(raw, extractDiscordUserIds(rawText))));
  return cached;
}

export function getSettings(): Settings {
  if (!cached) throw new Error("Settings not loaded. Call loadSettings() first.");
  return cached;
}

const PROMPT_EXTENSIONS = [".md", ".txt", ".prompt"];

/**
 * If the prompt string looks like a file path (ends with .md, .txt, or .prompt),
 * read and return the file contents. Otherwise return the string as-is.
 * Relative paths are resolved from the project root (cwd).
 */
export async function resolvePrompt(prompt: string): Promise<string> {
  const trimmed = prompt.trim();
  if (!trimmed) return trimmed;

  const isPath = PROMPT_EXTENSIONS.some((ext) => trimmed.endsWith(ext));
  if (!isPath) return trimmed;

  const resolved = isAbsolute(trimmed) ? trimmed : join(process.cwd(), trimmed);
  try {
    const content = await Bun.file(resolved).text();
    return content.trim();
  } catch {
    console.warn(`[config] Prompt path "${trimmed}" not found, using as literal string`);
    return trimmed;
  }
}
