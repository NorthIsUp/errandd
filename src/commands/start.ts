import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHookEssentials, renderHookEssentialsMarkdown } from "../../shared/hookEssentials";
import {
  type HeartbeatConfig,
  initConfig,
  loadSettings,
  reloadSettings,
  resolvePrompt,
  type Settings,
} from "../config";
import { anyCronMatches, earliestCronMatch } from "../cron";
import { formatForwardText } from "../daemon/forward";
import { parseStartArgs } from "../daemon/parseStartArgs";
import { STATUSLINE_SCRIPT } from "../daemon/statusline";
import { getHookQueue, nextQueueAction, type QueuedMessage } from "../hookQueue";
import { ts } from "../logTime";
import {
  getInteractiveQueue,
  type InteractiveMessage,
} from "../messaging/interactiveQueue";
import { annotateSkip, initDeliveryStore } from "../hooks/deliveries";
import { initSentrySeenStore } from "../hooks/sentrySeen";
import { extractHookFields, extractHookKeys } from "../hooks/evaluate";
import {
  buildHookTrigger,
  CLAW_IGNORE_SKIP_REASON,
  extractHookLabel,
  extractHookScope,
} from "../hooks/match";
import { writeStaticSkipSession } from "../hooks/skip";
import type { Job } from "../jobs";
import { buildJobThreadId, clearJobSchedule, loadJobs, snapshotJobFrontmatter } from "../jobs";
import { ensureAllRepos, pullRepo } from "../jobsRepo";
import { migrateTriggers } from "../migrateTriggers";
import { checkExistingDaemon, cleanupPidFile, writePidFile } from "../pid";
import { PluginManager, setPluginManager } from "../plugins";
import {
  bootstrap,
  ensureProjectClaudeMd,
  getRateLimitResetAt,
  isRateLimited,
  loadHeartbeatPromptTemplate,
  markRateLimitNotified,
  run,
  runUserMessage,
  streamUserMessage,
  wasRateLimitNotified,
} from "../runner";
import { pruneJobSessions } from "../sessionManager";
import { runCleanups, runMaintenance } from "../maintenance";
import { setReady } from "../health";
import { type StateData, writeState } from "../statusline";
import { buildClockPromptPrefix, getDayAndMinuteAtOffset } from "../timezone";
import { getOrCreateWebToken } from "../ui/auth";
import { startWebUi, type WebServerHandle } from "../web";
import { handleWizardInput, hasActiveWizard, isWizardTrigger } from "./plugin-wizard";

const CLAUDE_DIR = join(process.cwd(), ".claude");
const HEARTBEAT_DIR = join(CLAUDE_DIR, "clawdcode");
const LEGACY_HEARTBEAT_DIR = join(CLAUDE_DIR, "claudeclaw");
const STATUSLINE_FILE = join(CLAUDE_DIR, "statusline.cjs");
const CLAUDE_SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");
const PREFLIGHT_SCRIPT = fileURLToPath(new URL("../preflight.ts", import.meta.url));

/**
 * Render one coalesced prompt for a batch of queued hook messages. A normal
 * hook message renders a "Triggered by …" summary; a `web:message` (the v3
 * composer reply, spec §8) renders its raw `payload.text` as a plain user turn.
 *
 * `isNewSession` controls whether the routine's instruction body (`prompt`) is
 * included. On the FIRST run of a thread the agent needs the full routine
 * prompt. On a RESUME it already has those instructions in its context, so we
 * send only the new-event details (the real "Triggered by … + payload summary"
 * blocks) plus a short nudge — never re-dumping the whole prompt. This keeps
 * the chat clean and avoids re-paying for the prompt every delivery.
 *
 * Module-level + exported so it's unit-testable.
 */
export function buildCoalescedHookPrompt(
  prompt: string,
  scope: string,
  msgs: QueuedMessage[],
  isNewSession = true,
): string {
  const body = formatIncomingHooks(scope, msgs);

  if (!isNewSession) {
    // Resume: routine instructions are already in context — send only the
    // compact event block + a one-line nudge. NOT the full prompt.
    return `${body}\n\nHandle with the context you already have.`;
  }

  // New session: the compact block + the full routine prompt. (A pure
  // web:message new session has no hook block; just send the text + prompt.)
  return `${body}\n\n${prompt}`;
}

/**
 * Render the `## Incoming hook(s)` block for a coalesced batch. Compact,
 * minimal-token: a single headline + `·`-joined facts + one truncated body
 * line per event (via the DRY essentials layer). Web composer replies pass
 * through as raw text. No `Triggered by`, no `(delivery <id>)`, no per-event
 * `**repo**:`/`**sender**:` boilerplate.
 */
function formatIncomingHooks(scope: string, msgs: QueuedMessage[]): string {
  const single = msgs.length === 1;

  if (single) {
    const m = msgs[0];
    const text = webMessageText(m);
    if (text !== null) {
      return text;
    }
    const e = buildHookEssentials(m.event, m.payload);
    return `## Incoming hook · ${e.source} ${e.event}\n${renderHookEssentialsMarkdown(e)}`;
  }

  // Coalesced (N>1): one numbered one-liner per event under a single header.
  // The header already carries the scope/repo, so each line leads with the
  // event · action + actor + the one body/state snippet — not the full repo
  // headline (which would just repeat the scope).
  const lines = msgs.map((m, i) => {
    const n = `${i + 1}. `;
    const text = webMessageText(m);
    if (text !== null) {
      return `${n}message — ${oneLineClamp(text, 160)}`;
    }
    const e = buildHookEssentials(m.event, m.payload);
    const lead = e.action ? `${e.event} · ${e.action}` : e.event;
    return `${n}${lead}${eventOneLiner(e)}`;
  });
  return `## Incoming hooks (${msgs.length}) · ${scope}\n${lines.join("\n")}`;
}

/** The actor + body snippet (or suppression note) suffix for a coalesced
 *  one-liner. The scope header already shows the repo, so this leads with the
 *  author/review-state rather than repeating the headline. */
function eventOneLiner(e: ReturnType<typeof buildHookEssentials>): string {
  const author = e.facts.find((f) => f.label === "author")?.value;
  const state = e.facts.find((f) => f.label === "review")?.value;
  const who = author ? ` by ${author}` : state ? ` (${state})` : "";
  if (e.body) {
    if (e.body.fromBot && !e.body.text) {
      return `${who} — (bot body suppressed)`;
    }
    if (e.body.text) {
      return `${who} — "${e.body.text}"`;
    }
  }
  // No body — fall back to the headline so the line still identifies the event.
  return `${who} — ${e.headline}`;
}

/**
 * A `web:message` (spec §8 composer reply) renders as raw user text, not a hook
 * block. Returns the message's `payload.text` (empty string when absent) for a
 * web:message, or `null` for any other event — the single source of the
 * `payload as { text }` cast.
 */
function webMessageText(m: QueuedMessage): string | null {
  if (m.event !== "web:message") {
    return null;
  }
  const p = m.payload as { text?: unknown } | null | undefined;
  return typeof p?.text === "string" ? p.text : "";
}

function oneLineClamp(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/**
 * Build the web bundle on daemon start when it's missing or stale.
 *
 * Resolves the "ui UI not built — run `bun run build:web`" 404 by running
 * the build automatically. We compare the mtime of `dist/web/v3/app.js`
 * against the newest source file under `web/`; if the build artifact is
 * missing or older than any source, we rebuild. The Dockerfile pre-builds
 * the bundle so this path is effectively a no-op there.
 */
async function ensureWebBundleBuilt(): Promise<void> {
  const { existsSync, statSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const repoRoot = join(import.meta.dir, "..", "..");
  const buildScript = join(repoRoot, "web", "build.ts");
  const builtMarker = join(repoRoot, "dist", "web", "v3", "app.js");
  const webSourceDir = join(repoRoot, "web");

  // No build script in this checkout (e.g. installed as a binary) — skip
  // silently rather than fail; the server will surface its own 404.
  if (!existsSync(buildScript)) {
    return;
  }

  let needsBuild = !existsSync(builtMarker);
  let builtMtimeMs = 0;
  if (!needsBuild) {
    builtMtimeMs = statSync(builtMarker).mtimeMs;
    needsBuild = isSourceNewer(webSourceDir, builtMtimeMs, readdirSync, statSync, join);
  }

  if (!needsBuild) {
    return;
  }

  const proc = Bun.spawn(["bun", "run", buildScript], {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(
      `[${ts()}] Web bundle build failed (exit ${exitCode}). The Web UI may serve a 404 until you run \`bun run build:web\` manually.`,
    );
    return;
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: shallow tree walk with early-exit; splitting per-condition would obscure the short-circuit.
function isSourceNewer(
  dir: string,
  threshold: number,
  readdirSync: (p: string) => string[],
  statSync: (p: string) => { mtimeMs: number; isDirectory: () => boolean },
  join: (...p: string[]) => string,
): boolean {
  // Skip generated output and dependency vendoring so we don't recurse into
  // node_modules or compare against the bundle we just wrote.
  const SKIP = new Set(["node_modules", "dist", "styles.gen.css"]);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (SKIP.has(name)) {
      continue;
    }
    const full = join(dir, name);
    let s: { mtimeMs: number; isDirectory: () => boolean };
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      if (isSourceNewer(full, threshold, readdirSync, statSync, join)) {
        return true;
      }
    } else if (s.mtimeMs > threshold) {
      return true;
    }
  }
  return false;
}

/**
 * Poll the thread→session map (every 500 ms, up to 10 attempts ≈ 5 s) until the
 * runner has allocated a Claude session for `threadId`, then invoke `apply`
 * with the session id and stop. Covers cold-start spawn latency without holding
 * the webhook receiver open. Best-effort: a missing session after all attempts
 * is a silent no-op. `onError` (optional) is called per failed attempt — used
 * by titleHookSession to log; the recorders swallow errors silently.
 *
 * This is the single source of the poll loop that recordSessionTrigger,
 * recordSessionHookPayload, and titleHookSession formerly each inlined
 * (codebase-audit P1). recordSessionResult deliberately does NOT use it: it
 * does a single lookup with no polling.
 */
async function withThreadSession(
  threadId: string,
  apply: (sessionId: string) => Promise<void>,
  onError?: (err: unknown, attempt: number) => void,
): Promise<void> {
  const { getThreadSession } = await import("../sessionManager");
  const MAX_ATTEMPTS = 10;
  const INTERVAL_MS = 500;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
    try {
      const s = await getThreadSession(threadId);
      if (s) {
        await apply(s.sessionId);
        return;
      }
    } catch (err) {
      onError?.(err, i + 1);
    }
  }
}

/**
 * Persist a hook trigger / schedule trigger / session result on a
 * session that the runner will allocate asynchronously. Polls the
 * thread→session map the same way titleHookSession does. Best-effort —
 * failures don't break the job. */
async function recordSessionTrigger(
  threadId: string,
  trigger: import("../ui/services/session-meta").SessionTrigger,
): Promise<void> {
  const { setSessionTrigger } = await import("../ui/services/session-meta");
  await withThreadSession(threadId, (sessionId) => setSessionTrigger(sessionId, trigger));
}

/** Stamp the full webhook payload on a hook session once the runner has
 *  allocated it — powers the chat full-JSON disclosure, the copy button,
 *  and hook reprocessing. Polls the thread→session map like the others. */
async function recordSessionHookPayload(
  threadId: string,
  event: string,
  payload: unknown,
): Promise<void> {
  const { setSessionHookPayload } = await import("../ui/services/session-meta");
  await withThreadSession(threadId, (sessionId) =>
    setSessionHookPayload(sessionId, event, payload),
  );
}

async function recordSessionResult(
  threadId: string,
  result: import("../ui/services/session-meta").SessionResult,
): Promise<void> {
  try {
    const { getThreadSession } = await import("../sessionManager");
    const { setSessionResult } = await import("../ui/services/session-meta");
    const s = await getThreadSession(threadId);
    if (s) {
      await setSessionResult(s.sessionId, result);
    }
  } catch {
    // best-effort
  }
}

/** Anchored status-line marker: `[skip]` / `[ok]` / `[pass]` / `[done]` at the
 *  start of a (trimmed) line, with an optional `:suffix`. Mirrors
 *  ui/services/threadParts STATUS_LINE_RE so the Runs badge and the transcript
 *  pane agree on what the agent's terminal status line was. */
const RUN_STATUS_LINE_RE = /^\[(skip|ok|pass|done)(?::[a-z]+)?\]/i;

/**
 * Map a finished run to a Runs-view status. A non-zero exit is an error; an
 * exit-0 run that emitted a `[skip] …` status line is a "pass" — the agent RAN
 * and chose to no-op (distinct from a "skipped", where the *system* matcher
 * decided not to spawn at all). Everything else is ok.
 *
 * The marker is matched anchored (`^\[skip\]`) over the FULL trimmed output —
 * both stdout and stderr — scanning newest line first. The old "last 5 stdout
 * lines" window mislabeled a run as "ok" whenever the agent printed trailing
 * tool metadata/JSON after the marker, or emitted it on stderr (P0-7).
 */
export function runOutcome(r: {
  exitCode: number;
  stdout: string;
  stderr?: string;
}): "ok" | "error" | "pass" {
  if (r.exitCode !== 0) {
    return "error";
  }
  const combined = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const lines = combined.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = RUN_STATUS_LINE_RE.exec((lines[i] ?? "").trim());
    if (m) {
      // First (newest) status line wins: `[skip]` → the agent no-op'd → "pass";
      // any other explicit marker (`[ok]`/`[pass]`/`[done]`) → "ok".
      return m[1]?.toLowerCase() === "skip" ? "pass" : "ok";
    }
  }
  return "ok";
}

async function titleHookSession(threadId: string, label: string): Promise<void> {
  const { setSessionTitle } = await import("../ui/services/session-meta");
  await withThreadSession(
    threadId,
    (sessionId) => setSessionTitle(sessionId, label),
    (err, attempt) =>
      console.warn(`[clawdcode] titleHookSession ${threadId} attempt ${attempt} failed:`, err),
  );
}

/**
 * Rename `.claude/claudeclaw/` → `.claude/clawdcode/` once, so installs that
 * pre-date the plugin rename find their existing jobs/sessions/web.token.
 * No-op if the new dir already exists or the legacy dir is missing.
 */
async function migrateLegacyStateDir(): Promise<void> {
  const { existsSync, renameSync } = await import("node:fs");
  if (existsSync(HEARTBEAT_DIR) || !existsSync(LEGACY_HEARTBEAT_DIR)) {
    return;
  }
  try {
    renameSync(LEGACY_HEARTBEAT_DIR, HEARTBEAT_DIR);
  } catch (e) {
    console.warn(
      `[clawdcode] could not migrate ${LEGACY_HEARTBEAT_DIR} → ${HEARTBEAT_DIR}: ${(e as Error).message}`,
    );
  }
}

// --- Statusline setup/teardown ---

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function parseClockMinutes(value: string): number | null {
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function isHeartbeatExcludedNow(config: HeartbeatConfig, timezoneOffsetMinutes: number): boolean {
  return isHeartbeatExcludedAt(config, timezoneOffsetMinutes, new Date());
}

function isHeartbeatExcludedAt(
  config: HeartbeatConfig,
  timezoneOffsetMinutes: number,
  at: Date,
): boolean {
  if (!Array.isArray(config.excludeWindows) || config.excludeWindows.length === 0) {
    return false;
  }
  const local = getDayAndMinuteAtOffset(at, timezoneOffsetMinutes);

  for (const window of config.excludeWindows) {
    const start = parseClockMinutes(window.start);
    const end = parseClockMinutes(window.end);
    if (start == null || end == null) {
      continue;
    }
    const days = Array.isArray(window.days) && window.days.length > 0 ? window.days : ALL_DAYS;
    const sameDay = start < end;

    if (sameDay) {
      if (days.includes(local.day) && local.minute >= start && local.minute < end) {
        return true;
      }
      continue;
    }

    if (start === end) {
      if (days.includes(local.day)) {
        return true;
      }
      continue;
    }

    if (local.minute >= start && days.includes(local.day)) {
      return true;
    }
    const previousDay = (local.day + 6) % 7;
    if (local.minute < end && days.includes(previousDay)) {
      return true;
    }
  }

  return false;
}

function nextAllowedHeartbeatAt(
  config: HeartbeatConfig,
  timezoneOffsetMinutes: number,
  intervalMs: number,
  fromMs: number,
): number {
  const interval = Math.max(60_000, Math.round(intervalMs));
  let candidate = fromMs + interval;
  let guard = 0;

  while (
    isHeartbeatExcludedAt(config, timezoneOffsetMinutes, new Date(candidate)) &&
    guard < 20_000
  ) {
    candidate += interval;
    guard++;
  }

  return candidate;
}

async function setupStatusline() {
  await mkdir(CLAUDE_DIR, { recursive: true });
  await writeFile(STATUSLINE_FILE, STATUSLINE_SCRIPT);

  let settings: Record<string, unknown> = {};
  try {
    settings = await Bun.file(CLAUDE_SETTINGS_FILE).json();
  } catch {
    // file doesn't exist or isn't valid JSON
  }
  settings.statusLine = {
    type: "command",
    command: "node .claude/statusline.cjs",
  };
  await writeFile(CLAUDE_SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
}

async function teardownStatusline() {
  try {
    const settings = await Bun.file(CLAUDE_SETTINGS_FILE).json();
    delete settings.statusLine;
    await writeFile(CLAUDE_SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
  } catch {
    // file doesn't exist, nothing to clean up
  }

  try {
    await unlink(STATUSLINE_FILE);
  } catch {
    // already gone
  }
}

// --- Main ---

export async function start(args: string[] = []) {
  const parsed = parseStartArgs(args);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(1);
  }
  const {
    hasPromptFlag,
    hasTriggerFlag,
    telegramFlag,
    discordFlag,
    slackFlag,
    debugFlag,
    webFlag,
    replaceExistingFlag,
    webPortFlag,
    webHostFlag,
    webTrustTailnetFlag,
    payload,
  } = parsed.value;

  // One-shot mode: explicit prompt without trigger.
  if (hasPromptFlag && !hasTriggerFlag) {
    const existingPid = await checkExistingDaemon();
    if (existingPid) {
      console.error(
        `\x1b[31mAborted: daemon already running in this directory (PID ${existingPid})\x1b[0m`,
      );
      console.error(
        "Use `clawdcode send <message> [--telegram] [--discord]` while daemon is running.",
      );
      process.exit(1);
    }

    await initConfig();
    await loadSettings();
    await ensureProjectClaudeMd();
    const result = await runUserMessage("prompt", payload);
    if (result.exitCode !== 0) {
      process.exit(result.exitCode);
    }
    return;
  }

  const existingPid = await checkExistingDaemon();
  if (existingPid) {
    if (!replaceExistingFlag) {
      console.error(
        `\x1b[31mAborted: daemon already running in this directory (PID ${existingPid})\x1b[0m`,
      );
      console.error(`Use --stop first, or kill PID ${existingPid} manually.`);
      process.exit(1);
    }
    try {
      process.kill(existingPid, "SIGTERM");
    } catch {
      // ignore if process is already dead
    }

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      try {
        process.kill(existingPid, 0);
        await Bun.sleep(100);
      } catch {
        break;
      }
    }

    await cleanupPidFile();
  }

  // Boot-phase timing — logged once at ready so a slow prod boot pinpoints
  // its own cost instead of needing a profiler in the pod.
  const bootStart = Date.now();
  const bootMarks: string[] = [];
  const markBoot = (label: string) => bootMarks.push(`${label}+${Date.now() - bootStart}ms`);

  await migrateLegacyStateDir();
  await initConfig();
  const settings = await loadSettings();
  markBoot("settings");
  // NOTE: ensureAllRepos() (network git clone / claude CLI for plugin repos) is
  // deliberately NOT awaited here — it runs in the background after setReady()
  // below. On a warm state dir the clones already exist on disk, so jobs load
  // fine without it; blocking boot on the network stalled /readyz (and webhook
  // intake) for the whole sync on every restart. Fresh clones land a beat
  // later; the post-sync reload (or the 30s hot-reload) picks them up.
  await ensureProjectClaudeMd();
  // Upgrade any old-form routine frontmatter (top-level schedule:/recurring:
  // + on: mapping) to the unified on: triggers list before loading. Idempotent.
  await migrateTriggers();
  const jobs = await loadJobs();
  markBoot("jobs");
  const webEnabled =
    webFlag || webPortFlag !== null || webHostFlag !== null || settings.web.enabled;
  const webPort = webPortFlag ?? settings.web.port;
  if (webHostFlag !== null) {
    // Apply the override now so the boot banner shows the correct address.
    settings.web.host = webHostFlag;
  }

  await setupStatusline();
  markBoot("statusline");
  await writePidFile();
  let web: WebServerHandle | null = null;
  let discordStopGateway: (() => void) | null = null;
  let slackStopFn: (() => void) | null = null;
  // All long-lived setInterval handles (hot-reload, per-repo pulls, hook drain,
  // queue prune, cron tick) — collected so shutdown() can clear them before the
  // process exits, rather than leaving timers dangling.
  const intervals: ReturnType<typeof setInterval>[] = [];

  // Plugin system — initialize before gateway start
  const pluginManager = new PluginManager(process.cwd());
  if (Object.keys(settings.plugins).length > 0) {
    await pluginManager.loadAll(settings.plugins);
    setPluginManager(pluginManager);
  }

  async function shutdown() {
    // Flip /readyz to 503 first so the orchestrator stops routing new traffic
    // here and drains in-flight requests before we tear anything down.
    setReady(false);
    for (const handle of intervals) {
      clearInterval(handle);
    }
    await pluginManager.stopServices();
    setPluginManager(null);
    if (discordStopGateway) {
      discordStopGateway();
    }
    if (slackStopFn) {
      slackStopFn();
    }
    if (web) {
      web.stop();
    }
    await teardownStatusline();
    await cleanupPidFile();
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // --- Mutable state ---
  let currentSettings: Settings = settings;
  let currentJobs: Job[] = jobs;
  let nextHeartbeatAt = 0;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  const daemonStartedAt = Date.now();

  // --- Telegram ---
  let telegramSend: ((chatId: number, text: string) => Promise<void>) | null = null;
  // Thread-aware reply sender for the interactive queue (forum-topic threadId).
  let telegramSendToChat:
    | ((chatId: number, text: string, threadId?: number) => Promise<void>)
    | null = null;
  let telegramToken = "";
  let telegramReceiveEnabled = true;

  async function initTelegram(token: string, receiveEnabled = true) {
    if (token && token !== telegramToken) {
      const { startPolling, sendMessage } = await import("./telegram");
      if (receiveEnabled) {
        startPolling(debugFlag);
      }
      telegramSend = (chatId, text) => sendMessage(token, chatId, text);
      telegramSendToChat = (chatId, text, threadId) => sendMessage(token, chatId, text, threadId);
      telegramToken = token;
      telegramReceiveEnabled = receiveEnabled;
    } else if (token && token === telegramToken && receiveEnabled !== telegramReceiveEnabled) {
      const { startPolling, stopPolling } = await import("./telegram");
      if (receiveEnabled) {
        startPolling(debugFlag);
      } else {
        stopPolling();
      }
      telegramReceiveEnabled = receiveEnabled;
    } else if (!token && telegramToken) {
      telegramSend = null;
      telegramSendToChat = null;
      telegramToken = "";
    }
  }

  await initTelegram(currentSettings.telegram.token, currentSettings.telegram.receiveEnabled);

  // --- Discord ---
  let discordSendToUser: ((userId: string, text: string) => Promise<void>) | null = null;
  // Routes an interactive-queue reply back to its origin channel id (works for
  // both guild channels and DM channels, unlike sendToUser which expects a user
  // id and opens a fresh DM).
  let discordSendToChannel: ((channelId: string, text: string) => Promise<void>) | null = null;
  let discordToken = "";

  async function initDiscord(token: string) {
    if (token && token !== discordToken) {
      const { startGateway, sendMessageToUser, sendMessage, stopGateway } = await import("./discord");
      if (discordToken) {
        stopGateway();
      }
      startGateway(debugFlag);
      discordStopGateway = stopGateway;
      discordSendToUser = (userId, text) => sendMessageToUser(token, userId, text);
      discordSendToChannel = (channelId, text) => sendMessage(token, channelId, text);
      discordToken = token;
    } else if (!token && discordToken) {
      if (discordStopGateway) {
        discordStopGateway();
      }
      discordStopGateway = null;
      discordSendToUser = null;
      discordSendToChannel = null;
      discordToken = "";
    }
  }

  await initDiscord(currentSettings.discord.token);

  // --- Slack ---
  let slackSendToUser: ((userId: string, text: string) => Promise<void>) | null = null;
  // Routes an interactive-queue reply back to its origin channel + thread.
  let slackSendToChannel:
    | ((channelId: string, text: string, threadTs?: string) => Promise<void>)
    | null = null;
  let slackBotToken = "";
  let slackAppToken = "";

  async function initSlack(botToken: string, appToken: string) {
    if (botToken && appToken && (botToken !== slackBotToken || appToken !== slackAppToken)) {
      const { startSlack, sendMessageToUser: slackSend, sendMessage: slackChannelSend, stopSlack } =
        await import("./slack");
      if (slackBotToken || slackAppToken) {
        stopSlack();
      }
      startSlack(debugFlag);
      slackStopFn = stopSlack;
      slackSendToUser = (userId, text) => slackSend(botToken, userId, text);
      slackSendToChannel = (channelId, text, threadTs) =>
        slackChannelSend(botToken, channelId, text, threadTs);
      slackBotToken = botToken;
      slackAppToken = appToken;
    } else if (!(botToken && appToken) && (slackBotToken || slackAppToken)) {
      if (slackStopFn) {
        slackStopFn();
      }
      slackStopFn = null;
      slackSendToUser = null;
      slackSendToChannel = null;
      slackBotToken = "";
      slackAppToken = "";
    }
  }

  await initSlack(currentSettings.slack.botToken, currentSettings.slack.appToken);
  markBoot("messaging");

  // Wire channel senders into plugin runtime so plugins can send messages
  if (pluginManager.hasPlugins) {
    pluginManager.setChannelSenders({
      telegram: {
        sendMessageTelegram: telegramSend
          ? (chatId: number, text: string) => telegramSend?.(chatId, text)
          : () => Promise.resolve(),
      },
      discord: {
        sendMessageDiscord: discordSendToUser
          ? (userId: string, text: string) => discordSendToUser?.(userId, text)
          : () => Promise.resolve(),
      },
      slack: {
        sendMessageSlack: (userId: string, text: string) =>
          slackSendToUser ? slackSendToUser(userId, text) : Promise.resolve(),
      },
    });
    await pluginManager.startServices();
    await pluginManager.emit("gateway_start", {}, { workspaceDir: process.cwd() });
  }

  function isAddrInUse(err: unknown): boolean {
    if (!err || typeof err !== "object") {
      return false;
    }
    const code = "code" in err ? String((err as { code?: unknown }).code) : "";
    const message = "message" in err ? String((err as { message?: unknown }).message) : "";
    return code === "EADDRINUSE" || message.includes("EADDRINUSE");
  }

  function startWebWithFallback(
    host: string,
    preferredPort: number,
    token: string,
    trustTailnet: boolean,
  ): WebServerHandle {
    const maxAttempts = 10;
    let lastError: unknown;
    for (let i = 0; i < maxAttempts; i++) {
      const candidatePort = preferredPort + i;
      try {
        return startWebUi({
          host,
          port: candidatePort,
          token,
          trustTailnet,
          getSnapshot: () => ({
            pid: process.pid,
            startedAt: daemonStartedAt,
            heartbeatNextAt: nextHeartbeatAt,
            settings: currentSettings,
            jobs: currentJobs,
            activeJobs: activeJobNames(),
            jobLastResult: lastResultByJob(),
          }),
          subscribeJobStatus: (cb) => {
            // Push the current snapshot immediately so new subscribers don't
            // have to wait for the next event to populate.
            cb(jobStatusSnapshot());
            jobStatusSubscribers.add(cb);
            return () => {
              jobStatusSubscribers.delete(cb);
            };
          },
          onHeartbeatEnabledChanged: (enabled) => {
            if (currentSettings.heartbeat.enabled === enabled) {
              return;
            }
            currentSettings.heartbeat.enabled = enabled;
            scheduleHeartbeat();
            updateState();
          },
          onHeartbeatSettingsChanged: (patch) => {
            let changed = false;
            if (
              typeof patch.enabled === "boolean" &&
              currentSettings.heartbeat.enabled !== patch.enabled
            ) {
              currentSettings.heartbeat.enabled = patch.enabled;
              changed = true;
            }
            if (typeof patch.interval === "number" && Number.isFinite(patch.interval)) {
              const interval = Math.max(1, Math.min(1440, Math.round(patch.interval)));
              if (currentSettings.heartbeat.interval !== interval) {
                currentSettings.heartbeat.interval = interval;
                changed = true;
              }
            }
            if (
              typeof patch.prompt === "string" &&
              currentSettings.heartbeat.prompt !== patch.prompt
            ) {
              currentSettings.heartbeat.prompt = patch.prompt;
              changed = true;
            }
            if (Array.isArray(patch.excludeWindows)) {
              const prev = JSON.stringify(currentSettings.heartbeat.excludeWindows);
              const next = JSON.stringify(patch.excludeWindows);
              if (prev !== next) {
                currentSettings.heartbeat.excludeWindows = patch.excludeWindows;
                changed = true;
              }
            }
            if (!changed) {
              return;
            }
            scheduleHeartbeat();
            updateState();
          },
          onJobsChanged: async () => {
            currentJobs = await loadJobs();
            scheduleHeartbeat();
            updateState();
          },
          onChat: async (message, onChunk, onUnblock, onAgentEvent, opts) => {
            const wizardCtx = { iface: "web" as const, scopeId: "default" };
            if (isWizardTrigger(message) || hasActiveWizard(wizardCtx)) {
              onChunk(await handleWizardInput(wizardCtx, message));
              return;
            }
            await streamUserMessage(
              "chat",
              message,
              onChunk,
              onUnblock,
              onAgentEvent,
              opts?.modelOverride,
              opts?.effortOverride,
            );
          },
          onHookFire: (jobName, event, deliveryId, payload, opts) => {
            // A matched delivery is durably ENQUEUED (not run inline). The
            // per-thread drain worker (drainHookQueue) coalesces all pending
            // messages for a PR's session into one resumed turn, defers while
            // rate-limited, retries on failure, and replays after a restart.
            // The webhook returns 200 the instant the message is persisted, so
            // a crash (e.g. the ~10-min auto-update) loses nothing.
            const job = currentJobs.find((j) => j.name === jobName);
            if (!job) {
              return;
            }
            try {
              // Stable per-scope thread (e.g. pr-42-feature-foo). Deliveries to
              // the same PR route into the same Claude session — same context +
              // cache. Falls back to the delivery id so an unscoped event still
              // gets its own thread (never undefined — see runJob threadId).
              const hookScope = extractHookScope(event, payload) ?? `delivery-${deliveryId}`;
              const base = job.agent ? `agent:${job.agent}` : job.name;
              const threadId = `${base}:hook:${hookScope}`;
              const trig = buildHookTrigger(event, payload);
              getHookQueue().enqueue({
                id: deliveryId,
                threadId,
                jobName,
                event,
                scope: hookScope,
                payload,
                prRepo: trig.repo ?? null,
                prNumber: trig.pr?.number ?? null,
                keys: extractHookKeys(event, payload),
                fields: extractHookFields(event, payload),
                ...(opts?.notBefore ? { notBefore: opts.notBefore } : {}),
              });
              // Kick the drain immediately for low latency; the periodic tick
              // is the safety net (rate-limit reset, retry backoff, replay).
              void drainHookQueue();
            } catch (err) {
              console.error(`[${ts()}] hook fire error for ${jobName}:`, err);
            }
          },
          // Config-driven skip: the matcher decided this delivery shouldn't
          // run (self-skip, user/branch/etc.). Record a skip session — no
          // Claude spawned — with the reason, trigger, and full payload so
          // it's visible (and reprocessable) in the Runs view.
          onHookSkip: async (jobName, event, deliveryId, payload, reason, prefilter) => {
            const job = currentJobs.find((j) => j.name === jobName);
            if (!job) {
              return;
            }
            try {
              const hookScope = extractHookScope(event, payload) ?? `delivery-${deliveryId}`;
              const base = job.agent ? `agent:${job.agent}` : job.name;
              const threadId = `${base}:hook:${hookScope}`;
              const trig = buildHookTrigger(event, payload);
              const prNum = trig.pr?.number;
              // Marker drives the chat treatment. ALL of these are config-driven
              // skips — the delivery never reached the model — so each renders in
              // the blue "not sent to the agent (FYI)" box (notInContext):
              //   - `[skip:fyi]`    → prefilter drop (bot-noise / non-actionable).
              //   - `[skip:ignore]` → `claw:ignore` label; visibly distinct.
              //   - `[skip:rule]`   → ordinary config/self filter (the matcher's
              //                       rule didn't match). FYI; "skipped by a rule".
              // (A plain `[skip]` is reserved for the AGENT'S OWN skip — emitted by
              // a real run that chose to pass — which stays in-context.)
              const marker = prefilter
                ? "skip:fyi"
                : reason === CLAW_IGNORE_SKIP_REASON
                  ? "skip:ignore"
                  : "skip:rule";
              const head = prNum
                ? `[${marker}] PR #${prNum}: ${reason}`
                : `[${marker}] ${reason}`;
              // For prefilter (bot-noise) FYI drops, surface the actual comment
              // body + a source link in the blue box — that content IS meaningful
              // even when we don't run the agent on it (e.g. a Greptile summary:
              // worth reading, not worth acting on). The essentials carry the
              // truncated body and the comment's own html_url as the source.
              const message = prefilter
                ? `${head}\n\n${renderHookEssentialsMarkdown(buildHookEssentials(event, payload))}`
                : head;

              // CRITICAL: never clobber a thread that already has a session. A
              // skip event arriving AFTER real activity on the same thread — e.g.
              // a `labeled` event on a PR that pr-comments already conversed on —
              // must NOT replace the real session with an empty skip placeholder;
              // that wipes the visible chat history (the real transcript is
              // orphaned and the thread shows only the skip notice). Only
              // materialize a skip session when the thread has NONE yet, so a
              // thread whose first-ever event is a skip still shows the notice,
              // while an active conversation is preserved. The skip is still
              // recorded in the Deliveries tab via annotateSkip below.
              const { createThreadSession, peekThreadSession } = await import("../sessionManager");
              const existing = await peekThreadSession(threadId);
              if (!existing) {
                const sessionId = await writeStaticSkipSession({ assistantText: message });
                const {
                  setSessionTrigger,
                  setSessionResult,
                  setSessionTitle,
                  setSessionHookPayload,
                } = await import("../ui/services/session-meta");
                await createThreadSession(threadId, sessionId);
                await setSessionTrigger(sessionId, { kind: "hook", ...trig });
                await setSessionHookPayload(sessionId, event, payload);
                await setSessionResult(sessionId, "skipped");
                const displayLabel = extractHookLabel(event, payload);
                if (displayLabel) {
                  await setSessionTitle(sessionId, displayLabel);
                }
                setThreadResult(threadId, job.name, { result: "skipped", ranAt: Date.now() });
                emitJobStatus();
              }
              annotateSkip(deliveryId, job.name, reason);
            } catch (err) {
              console.error(`[${ts()}] hook skip error for ${jobName}:`, err);
            }
          },
        });
      } catch (err) {
        lastError = err;
        if (!isAddrInUse(err) || i === maxAttempts - 1) {
          throw err;
        }
      }
    }

    throw lastError;
  }

  // Allowlists are now fail-closed: an empty list blocks all users rather than allowing all.
  // Deployments that previously relied on an empty allowedUserIds meaning "allow everyone"
  // must add explicit IDs to continue working.
  if (currentSettings.telegram.token && currentSettings.telegram.allowedUserIds.length === 0) {
    console.error("Refusing to start: telegram.token is set but telegram.allowedUserIds is empty.");
    console.error("The allowlist is now fail-closed; an empty list blocks all users.");
    console.error(
      "Add your Telegram user ID(s) to telegram.allowedUserIds in .claude/clawdcode/settings.json.",
    );
    console.error(
      "Run `clawdcode config` for guided setup, or see the README for migration steps.",
    );
    process.exit(1);
  }

  if (currentSettings.discord.token && currentSettings.discord.allowedUserIds.length === 0) {
    console.error("Refusing to start: discord.token is set but discord.allowedUserIds is empty.");
    console.error("The allowlist is now fail-closed; an empty list blocks all users.");
    console.error(
      "Add your Discord user ID(s) to discord.allowedUserIds in .claude/clawdcode/settings.json.",
    );
    console.error(
      "Run `clawdcode config` for guided setup, or see the README for migration steps.",
    );
    process.exit(1);
  }

  if (webEnabled) {
    currentSettings.web.enabled = true;
    if (webHostFlag !== null) {
      currentSettings.web.host = webHostFlag;
    }
    const webToken = await getOrCreateWebToken();
    web = startWebWithFallback(currentSettings.web.host, webPort, webToken, webTrustTailnetFlag);
    currentSettings.web.port = web.port;
    markBoot("web-listen");
    // Bundle (re)build runs AFTER the server is listening, in the background.
    // Every plugin auto-update extracts a fresh checkout (fresh mtimes), so
    // isSourceNewer() triggers a full web rebuild on the first boot of each
    // new version — previously awaited BEFORE listen, stalling /readyz and
    // webhook intake for the whole build on every update restart. A
    // present-but-stale dist serves fine meanwhile; a missing dist 404s /ui
    // only until the build lands.
    void ensureWebBundleBuilt()
      .then(() => markBoot("web-bundle"))
      .catch((err) => console.error(`[${ts()}] web bundle build failed:`, err));
  }

  // --- Helpers ---
  function startPreflightInBackground(projectPath: string): void {
    try {
      const proc = Bun.spawn([process.execPath, "run", PREFLIGHT_SCRIPT, projectPath], {
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      proc.unref();
    } catch (err) {
      console.error(`[${ts()}] Failed to start plugin preflight:`, err);
    }
  }

  /**
   * One forwarder for all three channels (was forwardToTelegram /
   * forwardToDiscord / forwardToSlack, line-for-line identical bar the sender,
   * allowlist, and log tag). The `send`/`allowedUserIds` are read lazily at call
   * time so hot-reloaded tokens/allowlists are picked up — identical to the old
   * closures capturing the live `let` bindings.
   */
  function forwardTo<U extends number | string>(
    channel: string,
    send: ((userId: U, text: string) => Promise<void>) | null,
    allowedUserIds: U[],
    label: string,
    result: { exitCode: number; stdout: string; stderr: string },
  ) {
    if (!send || allowedUserIds.length === 0) {
      return;
    }
    const text = formatForwardText(label, result);
    for (const userId of allowedUserIds) {
      send(userId, text).catch((err) =>
        console.error(`[${channel}] Failed to forward to ${userId}: ${err}`),
      );
    }
  }

  const forwardToTelegram = (
    label: string,
    result: { exitCode: number; stdout: string; stderr: string },
  ) => forwardTo("Telegram", telegramSend, currentSettings.telegram.allowedUserIds, label, result);

  const forwardToDiscord = (
    label: string,
    result: { exitCode: number; stdout: string; stderr: string },
  ) =>
    forwardTo("Discord", discordSendToUser, currentSettings.discord.allowedUserIds, label, result);

  const forwardToSlack = (
    label: string,
    result: { exitCode: number; stdout: string; stderr: string },
  ) => forwardTo("Slack", slackSendToUser, currentSettings.slack.allowedUserIds, label, result);

  // --- Heartbeat scheduling ---
  function scheduleHeartbeat() {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
    }
    heartbeatTimer = null;

    if (!currentSettings.heartbeat.enabled) {
      nextHeartbeatAt = 0;
      return;
    }

    const ms = currentSettings.heartbeat.interval * 60_000;
    nextHeartbeatAt = nextAllowedHeartbeatAt(
      currentSettings.heartbeat,
      currentSettings.timezoneOffsetMinutes,
      ms,
      Date.now(),
    );

    function tick() {
      if (isRateLimited()) {
        const resetAt = new Date(getRateLimitResetAt());
        if (!wasRateLimitNotified()) {
          markRateLimitNotified();
          const msg = `Usage limit hit. Pausing until ${resetAt.toUTCString()}. Heartbeats and jobs suspended.`;
          forwardToTelegram("", { exitCode: 1, stdout: msg, stderr: "" });
          forwardToDiscord("", { exitCode: 1, stdout: msg, stderr: "" });
        }
        return;
      }
      if (
        isHeartbeatExcludedNow(currentSettings.heartbeat, currentSettings.timezoneOffsetMinutes)
      ) {
        nextHeartbeatAt = nextAllowedHeartbeatAt(
          currentSettings.heartbeat,
          currentSettings.timezoneOffsetMinutes,
          ms,
          Date.now(),
        );
        return;
      }
      Promise.all([resolvePrompt(currentSettings.heartbeat.prompt), loadHeartbeatPromptTemplate()])
        .then(([prompt, template]) => {
          const userPromptSection = prompt.trim()
            ? `User custom heartbeat prompt:\n${prompt.trim()}`
            : "";
          const mergedPrompt = [template.trim(), userPromptSection]
            .filter((part) => part.length > 0)
            .join("\n\n");
          if (!mergedPrompt) {
            return null;
          }
          const clock = buildClockPromptPrefix(new Date(), currentSettings.timezoneOffsetMinutes);
          return run("heartbeat", `${clock}\n${mergedPrompt}`);
        })
        .then((r) => {
          if (!r) {
            return;
          }
          const normalized = r.stdout.trim();
          const shouldSuppress =
            normalized.startsWith("HEARTBEAT_OK") || normalized.endsWith("HEARTBEAT_OK");
          const shouldForward = currentSettings.heartbeat.forwardToTelegram || !shouldSuppress;
          if (shouldForward) {
            forwardToTelegram("", r);
            forwardToDiscord("", r);
          }
        });
      nextHeartbeatAt = nextAllowedHeartbeatAt(
        currentSettings.heartbeat,
        currentSettings.timezoneOffsetMinutes,
        ms,
        Date.now(),
      );
    }

    heartbeatTimer = setTimeout(function runAndReschedule() {
      tick();
      heartbeatTimer = setTimeout(runAndReschedule, ms);
    }, ms);
  }

  // Startup init:
  // - trigger mode: run exactly one trigger prompt (no separate bootstrap)
  // - normal mode: bootstrap to initialize session context
  if (hasTriggerFlag) {
    const triggerPrompt = hasPromptFlag ? payload : "Wake up, my friend!";
    const triggerResult = await run("trigger", triggerPrompt);
    if (telegramFlag) {
      forwardToTelegram("", triggerResult);
    }
    if (discordFlag) {
      forwardToDiscord("", triggerResult);
    }
    if (slackFlag) {
      forwardToSlack("", triggerResult);
    }
    if (triggerResult.exitCode !== 0) {
      console.error(
        `[${ts()}] Startup trigger failed (exit ${triggerResult.exitCode}). Daemon will continue running.`,
      );
    }
  } else {
    // Bootstrap the session first so system prompt is initial context
    // and session.json is created immediately.
    await bootstrap();
  }
  markBoot("bootstrap");

  // Install plugins without blocking daemon startup.
  startPreflightInBackground(process.cwd());

  if (currentSettings.heartbeat.enabled) {
    scheduleHeartbeat();
  }

  // --- Hot-reload loop (every 30s) ---
  intervals.push(
    setInterval(async () => {
      try {
        const newSettings = await reloadSettings();
        const newJobs = await loadJobs();

        // Detect heartbeat config changes
        const hbChanged =
          newSettings.heartbeat.enabled !== currentSettings.heartbeat.enabled ||
          newSettings.heartbeat.interval !== currentSettings.heartbeat.interval ||
          newSettings.heartbeat.prompt !== currentSettings.heartbeat.prompt ||
          newSettings.timezoneOffsetMinutes !== currentSettings.timezoneOffsetMinutes ||
          newSettings.timezone !== currentSettings.timezone ||
          JSON.stringify(newSettings.heartbeat.excludeWindows) !==
            JSON.stringify(currentSettings.heartbeat.excludeWindows);

        if (hbChanged) {
          currentSettings = newSettings;
          scheduleHeartbeat();
        } else {
          currentSettings = newSettings;
        }
        if (web) {
          currentSettings.web.enabled = true;
          currentSettings.web.port = web.port;
        }

        currentJobs = newJobs;

        // Telegram changes
        await initTelegram(newSettings.telegram.token, newSettings.telegram.receiveEnabled);

        // Discord changes
        await initDiscord(newSettings.discord.token);

        // Slack changes
        await initSlack(newSettings.slack.botToken, newSettings.slack.appToken);
      } catch (err) {
        console.error(`[${ts()}] Hot-reload error:`, err);
      }
    }, 30_000),
  );

  // --- Routines auto-sync: pull every jobs repo on a schedule (default 5m) ---
  // One scheduler tick (60s) that re-reads `currentSettings.jobsRepos` fresh —
  // so it reacts to repos added/changed after boot — and pulls each git repo
  // once its interval has elapsed. The interval defaults to 5 minutes (a repo
  // may configure a faster one); the prior loop skipped any repo with
  // intervalSeconds ≤ 0 entirely, so unconfigured routines never synced. The
  // 30s hot-reload then picks up the freshly-pulled .md files.
  const lastRepoPull = new Map<string, number>();
  const ROUTINE_SYNC_DEFAULT_MS = 5 * 60 * 1000;
  intervals.push(
    setInterval(() => {
      const now = Date.now();
      for (const repo of currentSettings.jobsRepos) {
        if (repo.kind === "plugin" || !repo.url) {
          continue;
        }
        const intervalMs =
          repo.intervalSeconds && repo.intervalSeconds > 0
            ? repo.intervalSeconds * 1000
            : ROUTINE_SYNC_DEFAULT_MS;
        if (now - (lastRepoPull.get(repo.url) ?? 0) < intervalMs) {
          continue;
        }
        lastRepoPull.set(repo.url, now);
        void (async () => {
          try {
            const status = await pullRepo(repo);
            if (status.lastError) {
              console.warn(`[${ts()}] jobsRepo[${repo.url}]: ${status.lastError}`);
            }
          } catch (e) {
            console.warn(`[${ts()}] jobsRepo[${repo.url}] pull error: ${String(e)}`);
          }
        })();
      }
    }, 60_000),
  );

  // --- Cron tick (every 60s) ---
  function updateState() {
    const now = new Date();
    const lastByJob = lastResultByJob();
    const state: StateData = {
      heartbeat: currentSettings.heartbeat.enabled ? { nextAt: nextHeartbeatAt } : undefined,
      jobs: currentJobs.map((job) => {
        const last = lastByJob[job.name];
        const retryState = jobRetryState.get(job.name);
        const next = earliestCronMatch(job.schedules, now, currentSettings.timezoneOffsetMinutes);
        return {
          name: job.name,
          ...(next ? { nextAt: next.getTime() } : {}),
          ...(last ? { lastResult: last.result, lastRanAt: last.ranAt } : {}),
          ...(retryState ? { failCount: retryState.failCount, retryAt: retryState.retryAt } : {}),
        };
      }),
      security: currentSettings.security.level,
      telegram: !!currentSettings.telegram.token,
      discord: !!currentSettings.discord.token,
      startedAt: daemonStartedAt,
      web: {
        enabled: !!web,
        host: currentSettings.web.host,
        port: currentSettings.web.port,
      },
    };
    writeState(state);
  }

  // In-memory retry state: resets on daemon restart (no stale debt across restarts).
  const jobRetryState = new Map<string, { failCount: number; retryAt: number }>();

  type JobResult = { result: "ok" | "error" | "skipped" | "pass"; ranAt: number };

  // Track each RUN's most recent outcome, keyed on the unique threadId (not
  // job.name). Two concurrent hook threads for one job (e.g. two PRs handled by
  // the same routine) must not collapse onto one entry — that was last-writer-
  // wins (P0-6). The Schedule view projects these per job.name (most recent
  // wins) via lastResultByJob(). Resets on daemon restart (in-memory only).
  const threadLastResult = new Map<string, { jobName: string } & JobResult>();

  // Threads currently being executed, keyed on the unique threadId → jobName.
  // Populated on runJob entry, drained in .finally. Keyed per-thread so two
  // concurrent runs of the same job don't let the first's .finally clear the
  // active marker while the second is still live (P0-6). The web /api/state
  // endpoint surfaces the projected job names so the Schedule tab can show a
  // real "Running" badge.
  const activeThreads = new Map<string, string>();

  /** Distinct job names with at least one thread in flight (Schedule view). */
  function activeJobNames(): string[] {
    return [...new Set(activeThreads.values())];
  }

  /** Project the per-thread last-result map down to one entry per job name,
   *  most-recent (max ranAt) wins — what the Schedule/Runs status views read. */
  function lastResultByJob(): Record<string, JobResult> {
    const out: Record<string, JobResult> = {};
    for (const { jobName, result, ranAt } of threadLastResult.values()) {
      const prev = out[jobName];
      if (!prev || ranAt >= prev.ranAt) {
        out[jobName] = { result, ranAt };
      }
    }
    return out;
  }

  /** Record a run outcome under its unique threadId (projected per-job later).
   *  Bounds memory: for this job, keep only entries whose thread is still active
   *  plus the single newest finished entry (this one). Stale per-scope results
   *  from earlier finished runs of the same job are dropped. */
  function setThreadResult(threadId: string, jobName: string, r: JobResult): void {
    threadLastResult.set(threadId, { jobName, ...r });
    for (const [tid, v] of threadLastResult) {
      if (v.jobName === jobName && tid !== threadId && !activeThreads.has(tid)) {
        threadLastResult.delete(tid);
      }
    }
  }

  // Live status pub/sub for the /api/jobs/events SSE stream. Anything that
  // mutates activeThreads or threadLastResult should call emitJobStatus()
  // so subscribed UI clients see the change without polling.
  type JobStatusSnapshot = {
    active: string[];
    results: Record<string, { result: "ok" | "error" | "skipped" | "pass"; ranAt: number }>;
  };
  const jobStatusSubscribers = new Set<(s: JobStatusSnapshot) => void>();
  function jobStatusSnapshot(): JobStatusSnapshot {
    return {
      active: activeJobNames(),
      results: lastResultByJob(),
    };
  }
  function emitJobStatus(): void {
    const snap = jobStatusSnapshot();
    for (const cb of jobStatusSubscribers) {
      try {
        cb(snap);
      } catch (err) {
        console.error(`[${ts()}] job status subscriber error:`, err);
      }
    }
  }

  updateState();

  function runJob(job: Job, opts: { hookScope?: string } = {}) {
    const timeoutMs = job.timeoutSeconds ? job.timeoutSeconds * 1000 : undefined;
    const base = job.agent ? `agent:${job.agent}` : job.name;
    const reuse = job.agent ? true : job.reuseSession;
    const now = new Date();
    const runId = [
      now.getUTCFullYear(),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      String(now.getUTCDate()).padStart(2, "0"),
      String(now.getUTCHours()).padStart(2, "0"),
      String(now.getUTCMinutes()).padStart(2, "0"),
      String(now.getUTCSeconds()).padStart(2, "0"),
      String(now.getUTCMilliseconds()).padStart(3, "0"),
    ].join("");
    // Hook-scoped invocation: a stable per-scope thread so consecutive
    // webhook deliveries with the same scope (e.g. all comments on PR #42)
    // resume the same claude session via the per-thread session map in
    // sessionManager.ts. enqueue(fn, threadId) in runner.ts naturally
    // serializes the runs so a second delivery waits for the first to
    // finish before sending its message into the same conversation.
    const threadId = opts.hookScope
      ? `${base}:hook:${opts.hookScope}`
      : buildJobThreadId(base, reuse, runId);
    // Cron-triggered runs (no hookScope) get a schedule trigger so the
    // Runs view can distinguish hook vs. schedule on jobs with both.
    if (!opts.hookScope && job.schedules.length > 0) {
      void recordSessionTrigger(threadId, { kind: "schedule", cron: job.schedules.join(", ") });
    }
    activeThreads.set(threadId, job.name);
    emitJobStatus();
    return snapshotJobFrontmatter(job.name).then((restoreFrontmatter) =>
      resolvePrompt(job.prompt)
        .then((prompt) => {
          const clock = buildClockPromptPrefix(new Date(), currentSettings.timezoneOffsetMinutes);
          return run(
            job.name,
            `${clock}\n${prompt}`,
            threadId,
            job.model,
            timeoutMs,
            job.agent,
            "job",
          );
        })
        .then(async (r) => {
          await restoreFrontmatter();
          // exit 0 normally → "ok", but a routine that decides to no-op prints
          // a final `[skip] …` line (see the agent convention); surface that as
          // "skipped" so the Runs badge matches the transcript instead of a
          // misleading "ok".
          const outcome = runOutcome(r);
          setThreadResult(threadId, job.name, { result: outcome, ranAt: Date.now() });
          // Per-session result — historical Runs view rows keep their own
          // status instead of all flipping together when the current run
          // finishes.
          void recordSessionResult(threadId, outcome);
          emitJobStatus();
          if (r.exitCode === 0) {
            jobRetryState.delete(job.name);
          } else if (job.retry && job.retry > 0) {
            // Preserve existing state so failCount accumulates correctly across retries.
            const state = jobRetryState.get(job.name) ?? { failCount: 0, retryAt: 0 };
            state.failCount += 1;
            if (state.failCount <= job.retry) {
              const delayMs = (job.retryDelay ?? 300) * 1000;
              state.retryAt = Date.now() + delayMs;
              jobRetryState.set(job.name, state);
            } else {
              jobRetryState.delete(job.name);
            }
          }
          if (!reuse) {
            pruneJobSessions(job.name).catch(() => {
              /* best-effort */
            });
          }
          if (job.notify === false) {
            return r;
          }
          if (job.notify === "error" && r.exitCode === 0) {
            return r;
          }
          forwardToTelegram(job.name, r);
          forwardToDiscord(job.name, r);
          return r;
        })
        .finally(async () => {
          activeThreads.delete(threadId);
          emitJobStatus();
          if (job.recurring) {
            return;
          }
          // Only clear one-shot schedule when no retry is pending.
          if (jobRetryState.has(job.name)) {
            return;
          }
          // Event-driven jobs (those with an `on:` hookConfig) are not
          // one-shot — they fire every time a matching webhook arrives, so
          // don't clear their schedule triggers. (clearJobSchedule only
          // removes `- schedule:` entries; the hook triggers would survive,
          // but skipping entirely avoids a needless frontmatter rewrite.)
          if (job.hookConfig) {
            return;
          }
          try {
            await clearJobSchedule(job.name);
          } catch (err) {
            console.error(`[${ts()}] Failed to clear schedule for ${job.name}:`, err);
          }
        }),
    );
  }

  // ---- Durable hook queue drain ------------------------------------------
  // The receiver enqueues matched deliveries; this drains them per thread.
  const HOOK_RETRY_CAP = 5;
  // Threads with a batch currently in flight — so a delivery that lands mid-run
  // is left pending and coalesced into the NEXT batch instead of racing.
  const drainingThreads = new Set<string>();

  async function runQueuedBatch(threadId: string, msgs: QueuedMessage[]): Promise<void> {
    const queue = getHookQueue();
    const ids = msgs.map((m) => m.id);
    const { jobName, scope } = msgs[0];
    const job = currentJobs.find((j) => j.name === jobName);
    if (!job) {
      queue.complete(ids, "failed", "job not found");
      return;
    }
    // The newest delivery drives the session title / trigger / payload shown
    // in the UI; the prompt coalesces all of them.
    const newest = msgs[msgs.length - 1];
    // Resume detection: if a Claude session already exists for this thread, the
    // routine instructions are already in context — send only the new events,
    // not the full prompt again (cleaner chat + cheaper).
    const { peekThreadSession } = await import("../sessionManager");
    const isNewSession = !(await peekThreadSession(threadId));
    // Strip `retry` so runJob's cron-style jobRetryState never engages — the
    // queue is the single retry authority for hook runs.
    const augmented: Job = {
      ...job,
      retry: 0,
      prompt: buildCoalescedHookPrompt(job.prompt, scope, msgs, isNewSession),
    };
    const label = extractHookLabel(newest.event, newest.payload);
    if (label) {
      void titleHookSession(threadId, label);
    }
    void recordSessionTrigger(threadId, {
      kind: "hook",
      ...buildHookTrigger(newest.event, newest.payload),
    });
    void recordSessionHookPayload(threadId, newest.event, newest.payload);
    try {
      const r = await runJob(augmented, { hookScope: scope });
      const attempts = msgs.map((m) => m.attempts);
      const action = nextQueueAction({
        exitCode: r?.exitCode ?? null,
        rateLimited: isRateLimited(),
        rateLimitResetAt: getRateLimitResetAt(),
        // Backoff on the most-tried message, but cap on the freshest so a
        // coalesced brand-new delivery isn't failed by an old one's burned
        // attempts (P0-14).
        priorAttempts: Math.max(...attempts),
        capAttempts: Math.min(...attempts),
        cap: HOOK_RETRY_CAP,
        now: Date.now(),
      });
      if (action.action === "done") {
        // Record the AGENT outcome (ok / pass / error), not just "done", so the
        // PR/queue views show whether it addressed work or chose to no-op.
        queue.complete(ids, "done", null, r ? runOutcome(r) : null);
      } else if (action.action === "fail") {
        queue.complete(ids, "failed", action.error ?? null, "error");
      } else {
        queue.defer(ids, action.notBefore ?? Date.now(), action.error ?? null);
      }
    } catch (err) {
      // Unexpected throw (not a normal non-zero exit) — back off and retry.
      queue.defer(ids, Date.now() + 60_000, String(err));
      console.error(`[${ts()}] hook drain error for ${jobName}:`, err);
    }
  }

  function drainHookQueue(): void {
    // While Claude is rate-limited, leave everything pending — the periodic
    // tick re-checks and drains once the limit resets.
    if (isRateLimited()) {
      return;
    }
    const queue = getHookQueue();
    for (const threadId of queue.readyThreadIds()) {
      if (drainingThreads.has(threadId)) {
        continue;
      }
      const msgs = queue.claimThread(threadId);
      if (msgs.length === 0) {
        continue;
      }
      drainingThreads.add(threadId);
      void runQueuedBatch(threadId, msgs).finally(() => drainingThreads.delete(threadId));
    }
  }

  // ---- Durable interactive-message queue drain ---------------------------
  // Telegram/Discord/Slack messages received while rate-limited are enqueued
  // (durably) by the platform handlers instead of being dropped. Once the limit
  // clears we re-run each via runUserMessage on its stored session and send the
  // reply back to the origin chat/thread on the right platform.
  const INTERACTIVE_RETRY_CAP = 5;
  let draining = false;

  /** Route a drained reply back to the platform/chat the message came from.
   *  Returns false when the sender for that platform isn't currently wired
   *  (e.g. the token was removed) so the caller can retry later. */
  async function sendInteractiveReply(m: InteractiveMessage, text: string): Promise<boolean> {
    switch (m.platform) {
      case "telegram": {
        if (!telegramSendToChat) return false;
        const chatId = Number(m.chatId);
        const threadId = m.threadTs != null ? Number(m.threadTs) : undefined;
        await telegramSendToChat(chatId, text, Number.isFinite(threadId) ? threadId : undefined);
        return true;
      }
      case "discord": {
        if (!discordSendToChannel) return false;
        await discordSendToChannel(m.chatId, text);
        return true;
      }
      case "slack": {
        if (!slackSendToChannel) return false;
        await slackSendToChannel(m.chatId, text, m.threadTs ?? undefined);
        return true;
      }
    }
  }

  async function drainInteractiveQueue(): Promise<void> {
    // Defer while rate-limited (the tick re-checks) and guard against overlap.
    if (draining || isRateLimited()) {
      return;
    }
    const queue = getInteractiveQueue();
    if (queue.pendingCount() === 0) {
      return;
    }
    draining = true;
    try {
      const msgs = queue.claimReady();
      for (const m of msgs) {
        // A reset that landed mid-drain: stop and leave the rest pending.
        if (isRateLimited()) {
          queue.defer(m.id, getRateLimitResetAt(), "rate limited again");
          continue;
        }
        try {
          const result = await runUserMessage(
            m.platform,
            m.text,
            m.sessionKey ?? undefined,
            m.agentName ?? undefined,
          );
          if (result.exitCode !== 0) {
            // Transient failure — back off and retry up to the cap.
            if (m.attempts + 1 >= INTERACTIVE_RETRY_CAP) {
              const failNote = "Sorry — I couldn't process your earlier message after the limit reset.";
              await sendInteractiveReply(m, failNote).catch(() => {});
              queue.complete(m.id, "failed", `exit ${result.exitCode}`);
            } else {
              const backoff = Math.min(60_000 * 2 ** m.attempts, 30 * 60_000);
              queue.defer(m.id, Date.now() + backoff, `exit ${result.exitCode}`);
            }
            continue;
          }
          const reply = (result.stdout || "").trim() || "(empty response)";
          const sent = await sendInteractiveReply(m, reply);
          // Mark done only once the reply actually went out — otherwise leave it
          // pending so a later tick (with the sender re-wired) retries. Don't
          // double-send: completed rows are never re-claimed.
          if (sent) {
            queue.complete(m.id, "done");
          } else {
            queue.defer(m.id, Date.now() + 30_000, "no sender wired");
          }
        } catch (err) {
          queue.defer(m.id, Date.now() + 60_000, String(err));
          console.error(`[${ts()}] interactive drain error (${m.platform}):`, err);
        }
      }
    } finally {
      draining = false;
    }
  }

  // Hydrate the durable deliveries store so the Deliveries tab shows the recent
  // deliveries across restarts (the ring is otherwise empty on boot).
  try {
    initDeliveryStore();
  } catch (err) {
    console.error(`[${ts()}] delivery store init failed:`, err);
  }

  // Open the persistent Sentry first-seen ledger (gates the first-occurrence
  // triage filter). Best-effort: a failure here just means the gate fails open.
  try {
    initSentrySeenStore();
  } catch (err) {
    console.error(`[${ts()}] sentry-seen store init failed:`, err);
  }

  // Replay the durable queue on boot: any message left `running` by a killed
  // worker (e.g. the auto-update restart) is reset to pending, then drained.
  try {
    getHookQueue().requeueStuckRunning();
  } catch (err) {
    console.error(`[${ts()}] hook queue replay failed:`, err);
  }
  // Same replay for the interactive queue (messages enqueued while rate-limited).
  try {
    getInteractiveQueue().requeueStuckRunning();
  } catch (err) {
    console.error(`[${ts()}] interactive queue replay failed:`, err);
  }
  // Drain tick (rate-limit reset, retry backoff, replay) + hourly housekeeping.
  // All recurring maintenance (queue prunes, stale-session compaction, clobbered-
  // thread recovery) lives in the maintenance harness (src/maintenance) — one
  // registry — rather than inline here. The hourly tick runs the cleanups; the
  // one-time data migrations run once at boot via runMaintenance() below.
  intervals.push(setInterval(drainHookQueue, 3000));
  intervals.push(setInterval(() => void drainInteractiveQueue(), 3000));
  intervals.push(
    setInterval(() => void runCleanups().catch(() => {}), 60 * 60 * 1000),
  );
  void drainHookQueue();
  void drainInteractiveQueue();
  // Run pending migrations + all cleanups once on boot (the hourly tick first
  // fires an hour in, and a long-running daemon may already need housekeeping).
  void runMaintenance().catch((err) => console.error(`[${ts()}] maintenance failed:`, err));

  intervals.push(
    setInterval(() => {
      const now = new Date();
      if (isRateLimited()) {
        const skippedAt = Date.now();
        let touched = false;
        for (const job of currentJobs) {
          const retryState = jobRetryState.get(job.name);
          const retryDue = !!retryState && retryState.retryAt <= skippedAt;
          const scheduleDue = anyCronMatches(
            job.schedules,
            now,
            currentSettings.timezoneOffsetMinutes,
          );
          if (retryDue || scheduleDue) {
            // Cron skip has no per-run threadId; key on a synthetic cron thread so
            // the projection still surfaces it under job.name.
            setThreadResult(`cron:${job.name}`, job.name, { result: "skipped", ranAt: skippedAt });
            touched = true;
          }
        }
        if (touched) {
          emitJobStatus();
        }
      } else {
        for (const job of currentJobs) {
          // Fire pending retries before checking the cron schedule.
          const retryState = jobRetryState.get(job.name);
          if (retryState && retryState.retryAt <= Date.now()) {
            // Push retryAt to sentinel so subsequent cron ticks don't re-fire while in flight.
            // runJob's .then() handler overwrites this with the real next-retry time (or deletes it).
            retryState.retryAt = Number.MAX_SAFE_INTEGER;
            runJob(job);
            continue;
          }
          if (anyCronMatches(job.schedules, now, currentSettings.timezoneOffsetMinutes)) {
            runJob(job);
          }
        }
      }
      updateState();
    }, 60_000),
  );

  // Startup fully initialized — server listening, jobs loaded, queues open,
  // maintenance kicked off. Flip /readyz to 200 so a deploy orchestrator can cut
  // traffic over to this instance (and stop sending to the draining old one).
  setReady(true);
  markBoot("ready");
  console.log(`[${ts()}] boot: ${bootMarks.join(" ")}`);

  // Background jobs-repo sync (see the boot note up top): clone/refresh every
  // configured repo now that serving traffic no longer depends on it, then
  // reload jobs so a fresh clone goes live immediately rather than waiting for
  // the next 30s hot-reload tick. Warm repos no-op, so this is cheap on every
  // restart and only does real work on a blank state dir or a new repo entry.
  void (async () => {
    try {
      await ensureAllRepos();
      currentJobs = await loadJobs();
      emitJobStatus();
      console.log(`[${ts()}] boot: jobs repos synced (+${Date.now() - bootStart}ms)`);
    } catch (err) {
      console.error(`[${ts()}] boot: background jobs-repo sync failed:`, err);
    }
  })();
}
