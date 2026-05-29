import { test, expect, afterEach } from "bun:test";
import { applyEnvOverrides } from "../env-overrides";
import type { Settings } from "../config";

function base(): Settings {
  return JSON.parse(JSON.stringify({
    model: "", api: "", fallback: { model: "", api: "" },
    agentic: { enabled: false, defaultMode: "implementation", modes: [] },
    timezone: "UTC", timezoneOffsetMinutes: 0,
    heartbeat: { enabled: false, interval: 15, prompt: "", excludeWindows: [], forwardToTelegram: true },
    telegram: { token: "", allowedUserIds: [], listenChats: [], receiveEnabled: true, dmIsolation: "shared" },
    discord: { token: "", allowedUserIds: [], listenChannels: [], listenGuilds: [], allowedGuilds: [], imageOutputRoots: [], streaming: false },
    slack: { botToken: "", appToken: "", allowedUserIds: [], listenChannels: [], allowBots: [], allowBotIds: [] },
    security: { level: "moderate", allowedTools: [], disallowedTools: [] },
    web: { enabled: false, host: "127.0.0.1", port: 4632 },
    stt: { baseUrl: "", model: "" },
    sessionTimeoutMs: 1, timeouts: { telegram: 5, heartbeat: 15, job: 30, default: 5 },
    watchdog: { maxConsecutiveTimeouts: null, maxRuntimeSeconds: null },
    session: { autoRotate: false, maxMessages: 50, maxAgeHours: 24, summaryPath: "" },
    plugins: {}, jobsRepo: { url: "", branch: "main", intervalSeconds: 300 },
  })) as Settings;
}

const touched: string[] = [];
function setEnv(k: string, v: string) { touched.push(k); process.env[k] = v; }
afterEach(() => { for (const k of touched) delete process.env[k]; touched.length = 0; });

test("string override applies", () => {
  setEnv("CLAWDCODE_MODEL", "opus");
  expect(applyEnvOverrides(base()).model).toBe("opus");
});

test("number override parses", () => {
  setEnv("CLAWDCODE_WEB_PORT", "8080");
  expect(applyEnvOverrides(base()).web.port).toBe(8080);
});

test("boolean override parses true/false", () => {
  setEnv("CLAWDCODE_WEB_ENABLED", "true");
  expect(applyEnvOverrides(base()).web.enabled).toBe(true);
});

test("invalid number is ignored", () => {
  setEnv("CLAWDCODE_WEB_PORT", "not-a-number");
  expect(applyEnvOverrides(base()).web.port).toBe(4632);
});

test("alias env var is honored", () => {
  setEnv("DISCORD_TOKEN", "abc");
  expect(applyEnvOverrides(base()).discord.token).toBe("abc");
});

test("primary name wins over alias", () => {
  setEnv("DISCORD_TOKEN", "alias");
  setEnv("CLAWDCODE_DISCORD_TOKEN", "primary");
  expect(applyEnvOverrides(base()).discord.token).toBe("primary");
});

test("jobsRepo fields override", () => {
  setEnv("CLAWDCODE_JOBSREPO_URL", "git@example.com:x.git");
  setEnv("CLAWDCODE_JOBSREPO_INTERVAL", "600");
  const s = applyEnvOverrides(base());
  expect(s.jobsRepo.url).toBe("git@example.com:x.git");
  expect(s.jobsRepo.intervalSeconds).toBe(600);
});

test("unset env leaves settings untouched", () => {
  expect(applyEnvOverrides(base()).model).toBe("");
});

test("CLAWDCODE_TIMEZONE re-derives the offset cron uses (not just the label)", () => {
  // base() is UTC/0. An IANA zone must update BOTH the display string and the
  // offset minutes, or scheduled routines keep firing on UTC.
  setEnv("CLAWDCODE_TIMEZONE", "America/Los_Angeles");
  const s = applyEnvOverrides(base());
  expect(s.timezone).toBe("America/Los_Angeles");
  // LA is UTC-8 (PST) or UTC-7 (PDT); either way a large negative offset, never 0.
  expect(s.timezoneOffsetMinutes).toBeLessThanOrEqual(-420);
  expect(s.timezoneOffsetMinutes).toBeGreaterThanOrEqual(-480);
});

test("CLAWDCODE_TIMEZONE accepts a numeric UTC-offset string", () => {
  setEnv("CLAWDCODE_TIMEZONE", "-420");
  const s = applyEnvOverrides(base());
  expect(s.timezoneOffsetMinutes).toBe(-420);
});
