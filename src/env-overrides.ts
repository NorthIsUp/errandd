import type { Settings } from "./config";

type Kind = "string" | "number" | "boolean" | "stringList";

interface EnvOverride {
  env: string;
  path: string[];
  kind: Kind;
  alias?: string;
}

export const ENV_OVERRIDES: EnvOverride[] = [
  { env: "CLAUDECLAW_MODEL", path: ["model"], kind: "string" },
  { env: "CLAUDECLAW_API", path: ["api"], kind: "string" },
  { env: "CLAUDECLAW_FALLBACK_MODEL", path: ["fallback", "model"], kind: "string" },
  { env: "CLAUDECLAW_FALLBACK_API", path: ["fallback", "api"], kind: "string" },
  { env: "CLAUDECLAW_TIMEZONE", path: ["timezone"], kind: "string" },
  { env: "CLAUDECLAW_API_TOKEN", path: ["apiToken"], kind: "string" },
  { env: "CLAUDECLAW_WEB_ENABLED", path: ["web", "enabled"], kind: "boolean" },
  { env: "CLAUDECLAW_WEB_HOST", path: ["web", "host"], kind: "string" },
  { env: "CLAUDECLAW_WEB_PORT", path: ["web", "port"], kind: "number" },
  { env: "CLAUDECLAW_HEARTBEAT_ENABLED", path: ["heartbeat", "enabled"], kind: "boolean" },
  { env: "CLAUDECLAW_HEARTBEAT_INTERVAL", path: ["heartbeat", "interval"], kind: "number" },
  { env: "CLAUDECLAW_SECURITY_LEVEL", path: ["security", "level"], kind: "string" },
  { env: "CLAUDECLAW_TELEGRAM_TOKEN", path: ["telegram", "token"], kind: "string", alias: "TELEGRAM_TOKEN" },
  { env: "CLAUDECLAW_DISCORD_TOKEN", path: ["discord", "token"], kind: "string", alias: "DISCORD_TOKEN" },
  { env: "CLAUDECLAW_SLACK_BOT_TOKEN", path: ["slack", "botToken"], kind: "string", alias: "SLACK_BOT_TOKEN" },
  { env: "CLAUDECLAW_SLACK_APP_TOKEN", path: ["slack", "appToken"], kind: "string", alias: "SLACK_APP_TOKEN" },
  { env: "CLAUDECLAW_STT_BASE_URL", path: ["stt", "baseUrl"], kind: "string" },
  { env: "CLAUDECLAW_STT_MODEL", path: ["stt", "model"], kind: "string" },
  { env: "CLAUDECLAW_JOBSREPO_URL", path: ["jobsRepo", "url"], kind: "string" },
  { env: "CLAUDECLAW_JOBSREPO_BRANCH", path: ["jobsRepo", "branch"], kind: "string" },
  { env: "CLAUDECLAW_JOBSREPO_INTERVAL", path: ["jobsRepo", "intervalSeconds"], kind: "number" },
];

function coerce(kind: Kind, raw: string): string | number | boolean | string[] | undefined {
  if (kind === "string") return raw;
  if (kind === "stringList") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (kind === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (kind === "boolean") {
    const v = raw.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(v)) return true;
    if (["false", "0", "no", "off"].includes(v)) return false;
    return undefined;
  }
  return undefined;
}

function assignPath(obj: Record<string, any>, path: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (typeof cur[path[i]] !== "object" || cur[path[i]] === null) cur[path[i]] = {};
    cur = cur[path[i]];
  }
  cur[path[path.length - 1]] = value;
}

/** Apply CLAUDECLAW_* (and back-compat alias) environment variables on top of file settings. */
export function applyEnvOverrides(settings: Settings): Settings {
  for (const o of ENV_OVERRIDES) {
    const raw = process.env[o.env] ?? (o.alias ? process.env[o.alias] : undefined);
    if (raw == null || raw.trim() === "") continue;
    const value = coerce(o.kind, raw);
    if (value === undefined) {
      console.warn(`[config] Ignoring ${o.env}: invalid ${o.kind} value "${raw}"`);
      continue;
    }
    assignPath(settings as unknown as Record<string, any>, o.path, value);
  }
  return settings;
}
