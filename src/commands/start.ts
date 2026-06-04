import { mkdir, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { fileURLToPath } from "url";
import {
  type HeartbeatConfig,
  initConfig,
  loadSettings,
  reloadSettings,
  resolvePrompt,
  type Settings,
} from "../config";
import { anyCronMatches, earliestCronMatch } from "../cron";
import { getHookQueue, nextQueueAction, type QueuedMessage } from "../hookQueue";
import { annotateSkip, initDeliveryStore } from "../hooks/deliveries";
import { extractHookFields, extractHookKeys } from "../hooks/evaluate";
import {
  buildHookTrigger,
  CLAW_IGNORE_SKIP_REASON,
  extractHookLabel,
  extractHookScope,
  renderHookSummaryMarkdown,
} from "../hooks/match";
import { writeStaticSkipSession } from "../hooks/skip";
import type { Job } from "../jobs";
import { buildJobThreadId, clearJobSchedule, loadJobs, snapshotJobFrontmatter } from "../jobs";
import { ensureAllRepos, pullRepo } from "../jobsRepo";
import { extractErrorDetail } from "../messaging";
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
 * Rename `.claude/claudeclaw/` → `.claude/clawdcode/` once, so installs that
 * pre-date the plugin rename find their existing jobs/sessions/web.token.
 * No-op if the new dir already exists or the legacy dir is missing.
 */
/**
 * Build the web bundle on daemon start when it's missing or stale.
 *
 * Resolves the "ui UI not built — run `bun run build:web`" 404 by running
 * the build automatically. We compare the mtime of `dist/web/ui/app.js`
 * against the newest source file under `web/`; if the build artifact is
 * missing or older than any source, we rebuild. The Dockerfile pre-builds
 * the bundle so this path is effectively a no-op there.
 */
async function ensureWebBundleBuilt(): Promise<void> {
  const { existsSync, statSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const repoRoot = join(import.meta.dir, "..", "..");
  const buildScript = join(repoRoot, "web", "build.ts");
  const builtMarker = join(repoRoot, "dist", "web", "ui", "app.js");
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

  // `ts()` is scoped inside the daemon closure, so use a local stamp here.
  const stamp = () => new Date().toLocaleTimeString();
  console.log(`[${stamp()}] Building web bundle…`);
  const start = Date.now();
  const proc = Bun.spawn(["bun", "run", buildScript], {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(
      `[${stamp()}] Web bundle build failed (exit ${exitCode}). The Web UI may serve a 404 until you run \`bun run build:web\` manually.`,
    );
    return;
  }
  console.log(`[${stamp()}] Web bundle built in ${Date.now() - start}ms`);
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
    if (SKIP.has(name)) continue;
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
 * Wait for a thread's claude session to be created, then stamp the given
 * display label as the session title. Polls the thread→session map
 * (`getThreadSession`) every 500 ms for up to 5 s — covers cold-start
 * spawn latency without holding the webhook receiver open.
 *
 * Used by `onHookFire` to surface e.g. `teamclara/Clara_V1#1424` in the
 * chat browser instead of the raw thread scope.
 */
/**
 * Persist a hook trigger / schedule trigger / session result on a
 * session that the runner will allocate asynchronously. Polls the
 * thread→session map the same way titleHookSession does. Best-effort —
 * failures don't break the job. */
async function recordSessionTrigger(
  threadId: string,
  trigger: import("../ui/services/session-meta").SessionTrigger,
): Promise<void> {
  const { getThreadSession } = await import("../sessionManager");
  const { setSessionTrigger } = await import("../ui/services/session-meta");
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const s = await getThreadSession(threadId);
      if (s) {
        await setSessionTrigger(s.sessionId, trigger);
        return;
      }
    } catch {
      // continue polling
    }
  }
}

/** Stamp the full webhook payload on a hook session once the runner has
 *  allocated it — powers the chat full-JSON disclosure, the copy button,
 *  and hook reprocessing. Polls the thread→session map like the others. */
async function recordSessionHookPayload(
  threadId: string,
  event: string,
  payload: unknown,
): Promise<void> {
  const { getThreadSession } = await import("../sessionManager");
  const { setSessionHookPayload } = await import("../ui/services/session-meta");
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const s = await getThreadSession(threadId);
      if (s) {
        await setSessionHookPayload(s.sessionId, event, payload);
        return;
      }
    } catch {
      // continue polling
    }
  }
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

/**
 * Map a finished run to a Runs-view status. A non-zero exit is an error; an
 * exit-0 run whose final output line is a `[skip] …` marker is a "pass" — the
 * agent RAN and chose to no-op (distinct from a "skipped", where the *system*
 * matcher decided not to spawn at all). Everything else is ok.
 */
function runOutcome(r: { exitCode: number; stdout: string }): "ok" | "error" | "pass" {
  if (r.exitCode !== 0) return "error";
  const lines = (r.stdout ?? "").trimEnd().split("\n");
  // Scan the last few non-empty lines — the marker is the agent's final text,
  // possibly trailed by whitespace/metadata.
  let seen = 0;
  for (let i = lines.length - 1; i >= 0 && seen < 5; i--) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;
    seen++;
    if (/^\[skip\]/i.test(line)) return "pass";
  }
  return "ok";
}

async function titleHookSession(threadId: string, label: string): Promise<void> {
  const { getThreadSession } = await import("../sessionManager");
  const { setSessionTitle } = await import("../ui/services/session-meta");
  const MAX_ATTEMPTS = 10;
  const INTERVAL_MS = 500;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
    try {
      const s = await getThreadSession(threadId);
      if (s) {
        await setSessionTitle(s.sessionId, label);
        return;
      }
    } catch (err) {
      console.warn(`[clawdcode] titleHookSession ${threadId} attempt ${i + 1} failed:`, err);
    }
  }
  console.log(
    `[clawdcode] titleHookSession ${threadId} timed out waiting for session creation (${label})`,
  );
}

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

const STATUSLINE_SCRIPT = `#!/usr/bin/env node
const { readFileSync } = require("fs");
const { join } = require("path");

const DIR = join(__dirname, "clawdcode");
const STATE_FILE = join(DIR, "state.json");
const PID_FILE = join(DIR, "daemon.pid");
const TOKEN_FILE = join(DIR, "web.token");

const R = "\\x1b[0m";
const DIM = "\\x1b[2m";
const RED = "\\x1b[31m";
const GREEN = "\\x1b[32m";

function stripAnsi(s) {
  return s
    .replace(/\\x1b\\]8;[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)/g, "")
    .replace(/\\x1b\\[[0-9;]*m/g, "");
}
function visibleLen(s) {
  var clean = stripAnsi(s);
  var len = 0;
  for (var i = 0; i < clean.length; i++) {
    var code = clean.codePointAt(i);
    if (code > 0xffff) { i++; len += 2; }
    else { len++; }
  }
  return len;
}

function fmt(ms) {
  if (ms <= 0) return GREEN + "now!" + R;
  var s = Math.floor(ms / 1000);
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m";
  return (s % 60) + "s";
}

function alive() {
  try {
    var pid = readFileSync(PID_FILE, "utf-8").trim();
    var parsedPid = Number(pid);
    if (!Number.isFinite(parsedPid) || !Number.isInteger(parsedPid) || parsedPid <= 0) {
      return false;
    }
    process.kill(parsedPid, 0);
    return true;
  } catch { return false; }
}

var B = DIM + "\\u2502" + R;
var TITLE = " \\ud83e\\udd9e ClawdCode \\ud83e\\udd9e ";
var PAD = 6;
var INNER_W = PAD + visibleLen(TITLE) + PAD;

function render(content) {
  var contentW = visibleLen(content);
  var w = Math.max(contentW, INNER_W);
  var titlePad = w - visibleLen(TITLE);
  var leftPad = Math.floor(titlePad / 2);
  var rightPad = titlePad - leftPad;
  var H = DIM + "\\u2500" + R;
  var header = DIM + "\\u256d" + R + H.repeat(leftPad) + TITLE + H.repeat(rightPad) + DIM + "\\u256e" + R;
  var footer = DIM + "\\u2570" + R + H.repeat(w) + DIM + "\\u256f" + R;
  var gap = w - contentW;
  var padded = gap > 0 ? content + " ".repeat(gap) : content;
  process.stdout.write(header + "\\n" + B + padded + B + "\\n" + footer);
}

if (!alive()) {
  render("        " + RED + "\\u25cb offline" + R);
  process.exit(0);
}

try {
  var state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  var now = Date.now();
  var info = [];

  if (state.heartbeat) {
    info.push("\\ud83d\\udc93 " + fmt(state.heartbeat.nextAt - now));
  }

  var jc = (state.jobs || []).length;
  info.push("\\ud83d\\udccb " + jc + " job" + (jc !== 1 ? "s" : ""));
  info.push(GREEN + "\\u25cf live" + R);

  if (state.web && state.web.enabled) {
    var webHost = state.web.host === "0.0.0.0" || state.web.host === "::" ? "localhost" : state.web.host;
    var webUrl = "http://" + webHost + ":" + state.web.port + "/ui/";
    try {
      var tok = readFileSync(TOKEN_FILE, "utf-8").trim();
      if (tok) {
        webUrl += "?token=" + encodeURIComponent(tok);
      }
    } catch {}
    info.push("\\x1b]8;;" + webUrl + "\\x1b\\\\\\ud83c\\udf10 " + state.web.port + "\\x1b]8;;\\x1b\\\\");
  }

  if (state.telegram) {
    info.push(GREEN + "\\ud83d\\udce1" + R);
  }

  if (state.discord) {
    info.push(GREEN + "\\ud83c\\udfae" + R);
  }

  render(" " + info.join(" " + B + " ") + " ");
} catch {
  render(DIM + "         waiting...         " + R);
}
`;

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function parseClockMinutes(value: string): number | null {
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
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
  if (!Array.isArray(config.excludeWindows) || config.excludeWindows.length === 0) return false;
  const local = getDayAndMinuteAtOffset(at, timezoneOffsetMinutes);

  for (const window of config.excludeWindows) {
    const start = parseClockMinutes(window.start);
    const end = parseClockMinutes(window.end);
    if (start == null || end == null) continue;
    const days = Array.isArray(window.days) && window.days.length > 0 ? window.days : ALL_DAYS;
    const sameDay = start < end;

    if (sameDay) {
      if (days.includes(local.day) && local.minute >= start && local.minute < end) return true;
      continue;
    }

    if (start === end) {
      if (days.includes(local.day)) return true;
      continue;
    }

    if (local.minute >= start && days.includes(local.day)) return true;
    const previousDay = (local.day + 6) % 7;
    if (local.minute < end && days.includes(previousDay)) return true;
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
  await writeFile(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
}

async function teardownStatusline() {
  try {
    const settings = await Bun.file(CLAUDE_SETTINGS_FILE).json();
    delete settings.statusLine;
    await writeFile(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
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
  let hasPromptFlag = false;
  let hasTriggerFlag = false;
  let telegramFlag = false;
  let discordFlag = false;
  let slackFlag = false;
  let debugFlag = false;
  let webFlag = false;
  let replaceExistingFlag = false;
  let webPortFlag: number | null = null;
  let webHostFlag: string | null = null;
  let webTrustTailnetFlag = false;
  const payloadParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--prompt") {
      hasPromptFlag = true;
    } else if (arg === "--trigger") {
      hasTriggerFlag = true;
    } else if (arg === "--telegram") {
      telegramFlag = true;
    } else if (arg === "--discord") {
      discordFlag = true;
    } else if (arg === "--slack") {
      slackFlag = true;
    } else if (arg === "--debug") {
      debugFlag = true;
    } else if (arg === "--web") {
      webFlag = true;
    } else if (arg === "--replace-existing") {
      replaceExistingFlag = true;
    } else if (arg === "--web-port") {
      const raw = args[i + 1];
      if (!raw) {
        console.error("`--web-port` requires a numeric value.");
        process.exit(1);
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
        console.error("`--web-port` must be a valid TCP port (1-65535).");
        process.exit(1);
      }
      webPortFlag = parsed;
      i++;
    } else if (arg === "--web-host") {
      const raw = args[i + 1];
      if (!raw) {
        console.error("`--web-host` requires a value (e.g. 127.0.0.1, 0.0.0.0).");
        process.exit(1);
      }
      webHostFlag = raw;
      i++;
    } else if (arg === "--web-trust-tailnet") {
      // Treat requests carrying a non-empty Tailscale-User-Login header as
      // authenticated. Safe only when the daemon is fronted by the Tailscale
      // operator's Ingress proxy and that proxy is the only upstream that
      // can reach the port (e.g. enforced by NetworkPolicy). Funnel-origin
      // requests do not carry this header.
      webTrustTailnetFlag = true;
    } else {
      payloadParts.push(arg);
    }
  }
  const payload = payloadParts.join(" ").trim();
  if (hasPromptFlag && !payload) {
    console.error(
      "Usage: clawdcode start --prompt <prompt> [--trigger] [--telegram] [--discord] [--slack] [--debug] [--web] [--web-port <port>] [--replace-existing]",
    );
    process.exit(1);
  }
  if (!hasPromptFlag && payload) {
    console.error("Prompt text requires `--prompt`.");
    process.exit(1);
  }
  if (telegramFlag && !hasTriggerFlag) {
    console.error("`--telegram` with `start` requires `--trigger`.");
    process.exit(1);
  }
  if (discordFlag && !hasTriggerFlag) {
    console.error("`--discord` with `start` requires `--trigger`.");
    process.exit(1);
  }
  if (slackFlag && !hasTriggerFlag) {
    console.error("`--slack` with `start` requires `--trigger`.");
    process.exit(1);
  }
  if (hasPromptFlag && !hasTriggerFlag && (webFlag || webPortFlag !== null)) {
    console.error("`--web` is daemon-only. Remove `--prompt`, or add `--trigger`.");
    process.exit(1);
  }

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
    console.log(result.stdout);
    if (result.exitCode !== 0) process.exit(result.exitCode);
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

    console.log(`Replacing existing daemon (PID ${existingPid})...`);
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

  await migrateLegacyStateDir();
  await initConfig();
  const settings = await loadSettings();
  await ensureAllRepos();
  await ensureProjectClaudeMd();
  // Upgrade any old-form routine frontmatter (top-level schedule:/recurring:
  // + on: mapping) to the unified on: triggers list before loading. Idempotent.
  const migrated = await migrateTriggers();
  if (migrated > 0) {
    console.log(`[${ts()}] Migrated ${migrated} routine file(s) to the on:-list trigger format`);
  }
  const jobs = await loadJobs();
  const webEnabled =
    webFlag || webPortFlag !== null || webHostFlag !== null || settings.web.enabled;
  const webPort = webPortFlag ?? settings.web.port;
  if (webHostFlag !== null) {
    // Apply the override now so the boot banner shows the correct address.
    settings.web.host = webHostFlag;
  }

  await setupStatusline();
  await writePidFile();
  let web: WebServerHandle | null = null;
  let discordStopGateway: (() => void) | null = null;
  let slackStopFn: (() => void) | null = null;

  // Plugin system — initialize before gateway start
  const pluginManager = new PluginManager(process.cwd());
  if (Object.keys(settings.plugins).length > 0) {
    await pluginManager.loadAll(settings.plugins);
    setPluginManager(pluginManager);
  }

  async function shutdown() {
    await pluginManager.stopServices();
    setPluginManager(null);
    if (discordStopGateway) discordStopGateway();
    if (slackStopFn) slackStopFn();
    if (web) web.stop();
    await teardownStatusline();
    await cleanupPidFile();
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log("ClawdCode daemon started");
  console.log(`  PID: ${process.pid}`);
  console.log(`  Security: ${settings.security.level}`);
  if (settings.security.allowedTools.length > 0)
    console.log(`    + allowed: ${settings.security.allowedTools.join(", ")}`);
  if (settings.security.disallowedTools.length > 0)
    console.log(`    - blocked: ${settings.security.disallowedTools.join(", ")}`);
  console.log(
    `  Heartbeat: ${settings.heartbeat.enabled ? `every ${settings.heartbeat.interval}m` : "disabled"}`,
  );
  console.log(`  Web UI: ${webEnabled ? `http://${settings.web.host}:${webPort}` : "disabled"}`);
  if (debugFlag) console.log("  Debug: enabled");
  console.log(`  Jobs loaded: ${jobs.length}`);
  jobs.forEach((j) => console.log(`    - ${j.name} [${j.schedules.join(", ")}]`));

  // --- Mutable state ---
  let currentSettings: Settings = settings;
  let currentJobs: Job[] = jobs;
  let nextHeartbeatAt = 0;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  const daemonStartedAt = Date.now();

  // --- Telegram ---
  let telegramSend: ((chatId: number, text: string) => Promise<void>) | null = null;
  let telegramToken = "";
  let telegramReceiveEnabled = true;

  async function initTelegram(token: string, receiveEnabled = true) {
    if (token && token !== telegramToken) {
      const { startPolling, sendMessage } = await import("./telegram");
      if (receiveEnabled) startPolling(debugFlag);
      telegramSend = (chatId, text) => sendMessage(token, chatId, text);
      telegramToken = token;
      telegramReceiveEnabled = receiveEnabled;
      console.log(`[${ts()}] Telegram: enabled${receiveEnabled ? "" : " (send-only)"}`);
    } else if (token && token === telegramToken && receiveEnabled !== telegramReceiveEnabled) {
      const { startPolling, stopPolling } = await import("./telegram");
      if (receiveEnabled) {
        startPolling(debugFlag);
        console.log(`[${ts()}] Telegram: receive enabled`);
      } else {
        stopPolling();
        console.log(`[${ts()}] Telegram: receive disabled (send-only)`);
      }
      telegramReceiveEnabled = receiveEnabled;
    } else if (!token && telegramToken) {
      telegramSend = null;
      telegramToken = "";
      console.log(`[${ts()}] Telegram: disabled`);
    }
  }

  await initTelegram(currentSettings.telegram.token, currentSettings.telegram.receiveEnabled);
  if (!telegramToken) console.log("  Telegram: not configured");

  // --- Discord ---
  let discordSendToUser: ((userId: string, text: string) => Promise<void>) | null = null;
  let discordToken = "";

  async function initDiscord(token: string) {
    if (token && token !== discordToken) {
      const { startGateway, sendMessageToUser, stopGateway } = await import("./discord");
      if (discordToken) stopGateway();
      startGateway(debugFlag);
      discordStopGateway = stopGateway;
      discordSendToUser = (userId, text) => sendMessageToUser(token, userId, text);
      discordToken = token;
      console.log(`[${ts()}] Discord: enabled`);
    } else if (!token && discordToken) {
      if (discordStopGateway) discordStopGateway();
      discordStopGateway = null;
      discordSendToUser = null;
      discordToken = "";
      console.log(`[${ts()}] Discord: disabled`);
    }
  }

  await initDiscord(currentSettings.discord.token);
  if (!discordToken) console.log("  Discord: not configured");

  // --- Slack ---
  let slackSendToUser: ((userId: string, text: string) => Promise<void>) | null = null;
  let slackBotToken = "";
  let slackAppToken = "";

  async function initSlack(botToken: string, appToken: string) {
    if (botToken && appToken && (botToken !== slackBotToken || appToken !== slackAppToken)) {
      const { startSlack, sendMessageToUser: slackSend, stopSlack } = await import("./slack");
      if (slackBotToken || slackAppToken) stopSlack();
      startSlack(debugFlag);
      slackStopFn = stopSlack;
      slackSendToUser = (userId, text) => slackSend(botToken, userId, text);
      slackBotToken = botToken;
      slackAppToken = appToken;
      console.log(`[${ts()}] Slack: enabled`);
    } else if (!(botToken && appToken) && (slackBotToken || slackAppToken)) {
      if (slackStopFn) slackStopFn();
      slackStopFn = null;
      slackSendToUser = null;
      slackBotToken = "";
      slackAppToken = "";
      console.log(`[${ts()}] Slack: disabled`);
    }
  }

  await initSlack(currentSettings.slack.botToken, currentSettings.slack.appToken);
  if (!slackBotToken) console.log("  Slack: not configured");

  // Wire channel senders into plugin runtime so plugins can send messages
  if (pluginManager.hasPlugins) {
    pluginManager.setChannelSenders({
      telegram: {
        sendMessageTelegram: telegramSend
          ? (chatId: number, text: string) => telegramSend!(chatId, text)
          : () => Promise.resolve(),
      },
      discord: {
        sendMessageDiscord: discordSendToUser
          ? (userId: string, text: string) => discordSendToUser!(userId, text)
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
    if (!err || typeof err !== "object") return false;
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
            activeJobs: [...currentActiveJobs],
            jobLastResult: Object.fromEntries(jobLastResult),
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
            if (currentSettings.heartbeat.enabled === enabled) return;
            currentSettings.heartbeat.enabled = enabled;
            scheduleHeartbeat();
            updateState();
            console.log(`[${ts()}] Heartbeat ${enabled ? "enabled" : "disabled"} from Web UI`);
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
            if (!changed) return;
            scheduleHeartbeat();
            updateState();
            console.log(`[${ts()}] Heartbeat settings updated from Web UI`);
          },
          onJobsChanged: async () => {
            currentJobs = await loadJobs();
            scheduleHeartbeat();
            updateState();
            console.log(`[${ts()}] Jobs reloaded from Web UI`);
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
          onHookFire: (jobName, event, deliveryId, payload) => {
            // A matched delivery is durably ENQUEUED (not run inline). The
            // per-thread drain worker (drainHookQueue) coalesces all pending
            // messages for a PR's session into one resumed turn, defers while
            // rate-limited, retries on failure, and replays after a restart.
            // The webhook returns 200 the instant the message is persisted, so
            // a crash (e.g. the ~10-min auto-update) loses nothing.
            const job = currentJobs.find((j) => j.name === jobName);
            if (!job) {
              console.log(`[${ts()}] hook fire: job not found name=${jobName}`);
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
              const fresh = getHookQueue().enqueue({
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
              });
              console.log(
                fresh
                  ? `[${ts()}] hook queued: ${jobName} ← ${event} ${deliveryId} scope=${hookScope}`
                  : `[${ts()}] hook dup ignored: ${event} ${deliveryId}`,
              );
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
          onHookSkip: async (jobName, event, deliveryId, payload, reason) => {
            const job = currentJobs.find((j) => j.name === jobName);
            if (!job) return;
            try {
              const hookScope = extractHookScope(event, payload) ?? `delivery-${deliveryId}`;
              const base = job.agent ? `agent:${job.agent}` : job.name;
              const threadId = `${base}:hook:${hookScope}`;
              const trig = buildHookTrigger(event, payload);
              const prNum = trig.pr?.number;
              // A `claw:ignore` skip is marked `[skip:ignore]` so it's visibly
              // distinct from config/self skips in the chat + runs surfaces.
              const marker = reason === CLAW_IGNORE_SKIP_REASON ? "skip:ignore" : "skip";
              const message = prNum
                ? `[${marker}] PR #${prNum}: ${reason}`
                : `[${marker}] ${reason}`;

              const sessionId = await writeStaticSkipSession({ assistantText: message });
              const { createThreadSession } = await import("../sessionManager");
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
              if (displayLabel) await setSessionTitle(sessionId, displayLabel);

              jobLastResult.set(job.name, { result: "skipped", ranAt: Date.now() });
              emitJobStatus();
              annotateSkip(deliveryId, job.name, reason);
              console.log(`[${ts()}] hook skip: ${jobName} ← ${event} ${deliveryId} (${reason})`);
            } catch (err) {
              console.error(`[${ts()}] hook skip error for ${jobName}:`, err);
            }
          },
        });
      } catch (err) {
        lastError = err;
        if (!isAddrInUse(err) || i === maxAttempts - 1) throw err;
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
    await ensureWebBundleBuilt();
    const webToken = await getOrCreateWebToken();
    web = startWebWithFallback(currentSettings.web.host, webPort, webToken, webTrustTailnetFlag);
    currentSettings.web.port = web.port;
    console.log(`[${ts()}] Web UI: http://${web.host}:${web.port}/?token=${webToken}`);
  }

  // --- Helpers ---
  function ts() {
    return new Date().toLocaleTimeString();
  }

  function startPreflightInBackground(projectPath: string): void {
    try {
      const proc = Bun.spawn([process.execPath, "run", PREFLIGHT_SCRIPT, projectPath], {
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      proc.unref();
      console.log(`[${ts()}] Plugin preflight started in background`);
    } catch (err) {
      console.error(`[${ts()}] Failed to start plugin preflight:`, err);
    }
  }

  function forwardToTelegram(
    label: string,
    result: { exitCode: number; stdout: string; stderr: string },
  ) {
    if (!telegramSend || currentSettings.telegram.allowedUserIds.length === 0) return;
    const text =
      result.exitCode === 0
        ? `${label ? `[${label}]\n` : ""}${result.stdout || "(empty)"}`
        : `${label ? `[${label}] ` : ""}error (exit ${result.exitCode}): ${extractErrorDetail(result) || "Unknown"}`;
    for (const userId of currentSettings.telegram.allowedUserIds) {
      telegramSend(userId, text).catch((err) =>
        console.error(`[Telegram] Failed to forward to ${userId}: ${err}`),
      );
    }
  }

  function forwardToDiscord(
    label: string,
    result: { exitCode: number; stdout: string; stderr: string },
  ) {
    if (!discordSendToUser || currentSettings.discord.allowedUserIds.length === 0) return;
    const text =
      result.exitCode === 0
        ? `${label ? `[${label}]\n` : ""}${result.stdout || "(empty)"}`
        : `${label ? `[${label}] ` : ""}error (exit ${result.exitCode}): ${extractErrorDetail(result) || "Unknown"}`;
    for (const userId of currentSettings.discord.allowedUserIds) {
      discordSendToUser(userId, text).catch((err) =>
        console.error(`[Discord] Failed to forward to ${userId}: ${err}`),
      );
    }
  }

  function forwardToSlack(
    label: string,
    result: { exitCode: number; stdout: string; stderr: string },
  ) {
    if (!slackSendToUser || currentSettings.slack.allowedUserIds.length === 0) return;
    const text =
      result.exitCode === 0
        ? `${label ? `[${label}]\n` : ""}${result.stdout || "(empty)"}`
        : `${label ? `[${label}] ` : ""}error (exit ${result.exitCode}): ${extractErrorDetail(result) || "Unknown"}`;
    for (const userId of currentSettings.slack.allowedUserIds) {
      slackSendToUser(userId, text).catch((err) =>
        console.error(`[Slack] Failed to forward to ${userId}: ${err}`),
      );
    }
  }

  // --- Heartbeat scheduling ---
  function scheduleHeartbeat() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
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
        console.log(`[${ts()}] Heartbeat skipped (rate limited until ${resetAt.toISOString()})`);
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
        console.log(`[${ts()}] Heartbeat skipped (excluded window)`);
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
          if (!mergedPrompt) return null;
          const clock = buildClockPromptPrefix(new Date(), currentSettings.timezoneOffsetMinutes);
          return run("heartbeat", `${clock}\n${mergedPrompt}`);
        })
        .then((r) => {
          if (!r) return;
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
    console.log(triggerResult.stdout);
    if (telegramFlag) forwardToTelegram("", triggerResult);
    if (discordFlag) forwardToDiscord("", triggerResult);
    if (slackFlag) forwardToSlack("", triggerResult);
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

  // Install plugins without blocking daemon startup.
  startPreflightInBackground(process.cwd());

  if (currentSettings.heartbeat.enabled) scheduleHeartbeat();

  // --- Hot-reload loop (every 30s) ---
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

      // Detect security config changes
      const secChanged =
        newSettings.security.level !== currentSettings.security.level ||
        newSettings.security.allowedTools.join(",") !==
          currentSettings.security.allowedTools.join(",") ||
        newSettings.security.disallowedTools.join(",") !==
          currentSettings.security.disallowedTools.join(",");

      if (secChanged) {
        console.log(`[${ts()}] Security level changed → ${newSettings.security.level}`);
      }

      if (hbChanged) {
        console.log(
          `[${ts()}] Config change detected — heartbeat: ${newSettings.heartbeat.enabled ? `every ${newSettings.heartbeat.interval}m` : "disabled"}`,
        );
        currentSettings = newSettings;
        scheduleHeartbeat();
      } else {
        currentSettings = newSettings;
      }
      if (web) {
        currentSettings.web.enabled = true;
        currentSettings.web.port = web.port;
      }

      // Detect job changes
      const jobNames = newJobs
        .map((j) => `${j.name}:${j.schedules.join(",")}:${j.prompt}`)
        .sort()
        .join("|");
      const oldJobNames = currentJobs
        .map((j) => `${j.name}:${j.schedules.join(",")}:${j.prompt}`)
        .sort()
        .join("|");
      if (jobNames !== oldJobNames) {
        console.log(`[${ts()}] Jobs reloaded: ${newJobs.length} job(s)`);
        newJobs.forEach((j) => console.log(`    - ${j.name} [${j.schedules.join(", ")}]`));
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
  }, 30_000);

  // --- Jobs repos periodic pull (one interval per repo) ---
  for (const repo of currentSettings.jobsRepos) {
    if (repo.url && repo.intervalSeconds > 0) {
      const repoUrl = repo.url;
      const intervalMs = repo.intervalSeconds * 1000;
      setInterval(async () => {
        try {
          const status = await pullRepo(repo);
          if (status.lastError) console.warn(`[${ts()}] jobsRepo[${repoUrl}]: ${status.lastError}`);
        } catch (e) {
          console.warn(`[${ts()}] jobsRepo[${repoUrl}] pull error: ${String(e)}`);
        }
      }, intervalMs);
    }
  }

  // --- Cron tick (every 60s) ---
  function updateState() {
    const now = new Date();
    const state: StateData = {
      heartbeat: currentSettings.heartbeat.enabled ? { nextAt: nextHeartbeatAt } : undefined,
      jobs: currentJobs.map((job) => {
        const last = jobLastResult.get(job.name);
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

  // Track each job's most recent outcome so state.json can expose lastResult/lastRanAt
  // for crash-recovery + status displays. Resets on daemon restart (in-memory only).
  const jobLastResult = new Map<
    string,
    { result: "ok" | "error" | "skipped" | "pass"; ranAt: number }
  >();

  // Jobs currently being executed. Populated on runJob entry, drained in
  // .finally. The web /api/state endpoint surfaces this so the Schedule tab
  // can show a real "Running" badge instead of guessing.
  const currentActiveJobs = new Set<string>();

  // Live status pub/sub for the /api/jobs/events SSE stream. Anything that
  // mutates currentActiveJobs or jobLastResult should call emitJobStatus()
  // so subscribed UI clients see the change without polling.
  type JobStatusSnapshot = {
    active: string[];
    results: Record<string, { result: "ok" | "error" | "skipped" | "pass"; ranAt: number }>;
  };
  const jobStatusSubscribers = new Set<(s: JobStatusSnapshot) => void>();
  function jobStatusSnapshot(): JobStatusSnapshot {
    return {
      active: [...currentActiveJobs],
      results: Object.fromEntries(jobLastResult),
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

  function runJob(job: (typeof currentJobs)[0], opts: { hookScope?: string } = {}) {
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
    currentActiveJobs.add(job.name);
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
          const restored = await restoreFrontmatter();
          if (restored) console.log(`[${ts()}] Restored frontmatter for job: ${job.name}`);
          // exit 0 normally → "ok", but a routine that decides to no-op prints
          // a final `[skip] …` line (see the agent convention); surface that as
          // "skipped" so the Runs badge matches the transcript instead of a
          // misleading "ok".
          const outcome = runOutcome(r);
          jobLastResult.set(job.name, { result: outcome, ranAt: Date.now() });
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
              console.log(
                `[${ts()}] Job ${job.name} failed (attempt ${state.failCount}/${job.retry}), retrying in ${job.retryDelay ?? 300}s`,
              );
            } else {
              jobRetryState.delete(job.name);
              console.log(`[${ts()}] Job ${job.name} exhausted ${job.retry} retries`);
            }
          }
          if (!reuse) {
            pruneJobSessions(job.name).catch(() => {
              /* best-effort */
            });
          }
          if (job.notify === false) return r;
          if (job.notify === "error" && r.exitCode === 0) return r;
          forwardToTelegram(job.name, r);
          forwardToDiscord(job.name, r);
          return r;
        })
        .finally(async () => {
          currentActiveJobs.delete(job.name);
          emitJobStatus();
          if (job.recurring) return;
          // Only clear one-shot schedule when no retry is pending.
          if (jobRetryState.has(job.name)) return;
          // Event-driven jobs (those with an `on:` hookConfig) are not
          // one-shot — they fire every time a matching webhook arrives, so
          // don't clear their schedule triggers. (clearJobSchedule only
          // removes `- schedule:` entries; the hook triggers would survive,
          // but skipping entirely avoids a needless frontmatter rewrite.)
          if (job.hookConfig) return;
          try {
            await clearJobSchedule(job.name);
            console.log(`[${ts()}] Cleared schedule for one-time job: ${job.name}`);
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

  function buildCoalescedHookPrompt(prompt: string, scope: string, msgs: QueuedMessage[]): string {
    const blocks = msgs.map((m, i) => {
      const source = m.event.startsWith("sentry:")
        ? "Sentry"
        : m.event.startsWith("datadog:")
          ? "Datadog"
          : "GitHub";
      const n = msgs.length > 1 ? `${i + 1}. ` : "";
      return `${n}Triggered by ${source} ${m.event} (delivery ${m.id}):\n\n${renderHookSummaryMarkdown(m.event, m.payload)}`;
    });
    const header =
      msgs.length > 1
        ? `${msgs.length} new events on scope \`${scope}\` since you last ran — handle them together:\n\n`
        : "";
    return `${header}${blocks.join("\n\n")}\n\n${prompt}`;
  }

  async function runQueuedBatch(threadId: string, msgs: QueuedMessage[]): Promise<void> {
    const queue = getHookQueue();
    const ids = msgs.map((m) => m.id);
    const { jobName, scope } = msgs[0];
    const job = currentJobs.find((j) => j.name === jobName);
    if (!job) {
      console.log(`[${ts()}] hook drain: job ${jobName} gone — failing ${ids.length} msg(s)`);
      queue.complete(ids, "failed", "job not found");
      return;
    }
    // The newest delivery drives the session title / trigger / payload shown
    // in the UI; the prompt coalesces all of them.
    const newest = msgs[msgs.length - 1];
    // Strip `retry` so runJob's cron-style jobRetryState never engages — the
    // queue is the single retry authority for hook runs.
    const augmented = {
      ...job,
      retry: 0,
      prompt: buildCoalescedHookPrompt(job.prompt, scope, msgs),
    } as (typeof currentJobs)[0];
    const label = extractHookLabel(newest.event, newest.payload);
    if (label) void titleHookSession(threadId, label);
    void recordSessionTrigger(threadId, {
      kind: "hook",
      ...buildHookTrigger(newest.event, newest.payload),
    });
    void recordSessionHookPayload(threadId, newest.event, newest.payload);
    console.log(`[${ts()}] hook drain: ${jobName} scope=${scope} (${msgs.length} msg)`);
    try {
      const r = await runJob(augmented, { hookScope: scope });
      const action = nextQueueAction({
        exitCode: r?.exitCode ?? null,
        rateLimited: isRateLimited(),
        rateLimitResetAt: getRateLimitResetAt(),
        priorAttempts: Math.max(...msgs.map((m) => m.attempts)),
        cap: HOOK_RETRY_CAP,
        now: Date.now(),
      });
      if (action.action === "done") {
        // Record the AGENT outcome (ok / pass / error), not just "done", so the
        // PR/queue views show whether it addressed work or chose to no-op.
        queue.complete(ids, "done", null, r ? runOutcome(r) : null);
      } else if (action.action === "fail") {
        queue.complete(ids, "failed", action.error ?? null, "error");
        console.log(`[${ts()}] hook drain: ${jobName} ${action.error}`);
      } else {
        queue.defer(ids, action.notBefore ?? Date.now(), action.error ?? null);
        console.log(
          `[${ts()}] hook drain: ${jobName} deferred (${action.error}) → ${new Date(action.notBefore ?? 0).toISOString()}`,
        );
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
    if (isRateLimited()) return;
    const queue = getHookQueue();
    for (const threadId of queue.readyThreadIds()) {
      if (drainingThreads.has(threadId)) continue;
      const msgs = queue.claimThread(threadId);
      if (msgs.length === 0) continue;
      drainingThreads.add(threadId);
      void runQueuedBatch(threadId, msgs).finally(() => drainingThreads.delete(threadId));
    }
  }

  // Hydrate the durable deliveries store so the Deliveries tab shows the recent
  // deliveries across restarts (the ring is otherwise empty on boot).
  try {
    initDeliveryStore();
  } catch (err) {
    console.error(`[${ts()}] delivery store init failed:`, err);
  }

  // Replay the durable queue on boot: any message left `running` by a killed
  // worker (e.g. the auto-update restart) is reset to pending, then drained.
  try {
    const requeued = getHookQueue().requeueStuckRunning();
    if (requeued > 0) {
      console.log(`[${ts()}] hook queue: replayed ${requeued} in-flight message(s) after restart`);
    }
  } catch (err) {
    console.error(`[${ts()}] hook queue replay failed:`, err);
  }
  // Drain tick (covers rate-limit reset, retry backoff, replay) + hourly prune.
  setInterval(drainHookQueue, 3000);
  setInterval(
    () => {
      try {
        getHookQueue().prune(7 * 24 * 60 * 60 * 1000);
      } catch {
        // best-effort housekeeping
      }
    },
    60 * 60 * 1000,
  );
  void drainHookQueue();

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
          jobLastResult.set(job.name, { result: "skipped", ranAt: skippedAt });
          touched = true;
        }
      }
      if (touched) emitJobStatus();
    } else {
      for (const job of currentJobs) {
        // Fire pending retries before checking the cron schedule.
        const retryState = jobRetryState.get(job.name);
        if (retryState && retryState.retryAt <= Date.now()) {
          // Push retryAt to sentinel so subsequent cron ticks don't re-fire while in flight.
          // runJob's .then() handler overwrites this with the real next-retry time (or deletes it).
          retryState.retryAt = Number.MAX_SAFE_INTEGER;
          console.log(
            `[${ts()}] Retrying job: ${job.name} (attempt ${retryState.failCount + 1}/${job.retry})`,
          );
          runJob(job);
          continue;
        }
        if (anyCronMatches(job.schedules, now, currentSettings.timezoneOffsetMinutes)) {
          runJob(job);
        }
      }
    }
    updateState();
  }, 60_000);
}
