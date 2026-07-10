import type { Settings, JobsRepoConfig } from "./config";
import { resolveTimezoneOffsetMinutes } from "./timezone";

type Kind = "string" | "number" | "boolean" | "stringList";

interface EnvOverride {
  env: string;
  path: string[];
  kind: Kind;
  alias?: string;
}

export const ENV_OVERRIDES: EnvOverride[] = [
  { env: "ERRANDD_RUNTIME", path: ["runtime"], kind: "string" },
  { env: "ERRANDD_MODEL", path: ["model"], kind: "string" },
  { env: "ERRANDD_API", path: ["api"], kind: "string" },
  { env: "ERRANDD_FALLBACK_MODEL", path: ["fallback", "model"], kind: "string" },
  { env: "ERRANDD_FALLBACK_API", path: ["fallback", "api"], kind: "string" },
  { env: "ERRANDD_TIMEZONE", path: ["timezone"], kind: "string" },
  { env: "ERRANDD_API_TOKEN", path: ["apiToken"], kind: "string" },
  { env: "ERRANDD_WEB_ENABLED", path: ["web", "enabled"], kind: "boolean" },
  { env: "ERRANDD_WEB_HOST", path: ["web", "host"], kind: "string" },
  { env: "ERRANDD_WEB_PORT", path: ["web", "port"], kind: "number" },
  { env: "ERRANDD_HEARTBEAT_ENABLED", path: ["heartbeat", "enabled"], kind: "boolean" },
  { env: "ERRANDD_HEARTBEAT_INTERVAL", path: ["heartbeat", "interval"], kind: "number" },
  { env: "ERRANDD_SECURITY_LEVEL", path: ["security", "level"], kind: "string" },
  { env: "ERRANDD_TELEGRAM_TOKEN", path: ["telegram", "token"], kind: "string", alias: "TELEGRAM_TOKEN" },
  { env: "ERRANDD_DISCORD_TOKEN", path: ["discord", "token"], kind: "string", alias: "DISCORD_TOKEN" },
  { env: "ERRANDD_SLACK_BOT_TOKEN", path: ["slack", "botToken"], kind: "string", alias: "SLACK_BOT_TOKEN" },
  { env: "ERRANDD_SLACK_APP_TOKEN", path: ["slack", "appToken"], kind: "string", alias: "SLACK_APP_TOKEN" },
  { env: "ERRANDD_STT_BASE_URL", path: ["stt", "baseUrl"], kind: "string" },
  { env: "ERRANDD_STT_MODEL", path: ["stt", "model"], kind: "string" },
  { env: "ERRANDD_JOBSREPO_URL", path: ["jobsRepo", "url"], kind: "string" },
  { env: "ERRANDD_JOBSREPO_BRANCH", path: ["jobsRepo", "branch"], kind: "string" },
  { env: "ERRANDD_JOBSREPO_INTERVAL", path: ["jobsRepo", "intervalSeconds"], kind: "number" },
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
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (typeof cur[path[i]] !== "object" || cur[path[i]] === null) cur[path[i]] = {};
    cur = cur[path[i]] as Record<string, unknown>;
  }
  cur[path[path.length - 1]] = value;
}

/** Apply ERRANDD_* (and back-compat alias) environment variables on top of file settings. */
export function applyEnvOverrides(settings: Settings): Settings {
  for (const o of ENV_OVERRIDES) {
    const raw = process.env[o.env] ?? (o.alias ? process.env[o.alias] : undefined);
    if (raw == null || raw.trim() === "") continue;
    const value = coerce(o.kind, raw);
    if (value === undefined) {
      console.warn(`[config] Ignoring ${o.env}: invalid ${o.kind} value "${raw}"`);
      continue;
    }
    assignPath(settings, o.path, value);
  }

  // ERRANDD_TIMEZONE only overrode the `timezone` string above. The value
  // cron actually shifts by is `timezoneOffsetMinutes`, which config.ts derived
  // from the *file's* timezone before env overrides ran — so without this the
  // env tz would change the displayed zone but leave schedules on the old
  // offset (UTC by default). Re-derive the offset from the overridden zone.
  if ((process.env.ERRANDD_TIMEZONE ?? "").trim()) {
    settings.timezoneOffsetMinutes = resolveTimezoneOffsetMinutes(
      settings.timezone,
      settings.timezone,
    );
  }

  // Back-compat: if ERRANDD_JOBSREPO_* env vars modified `settings.jobsRepo`,
  // propagate the change into `settings.jobsRepos[0]` to keep the array canonical.
  if (!Array.isArray(settings.jobsRepos)) settings.jobsRepos = [];
  const jobsRepoEnvSet =
    process.env.ERRANDD_JOBSREPO_URL ||
    process.env.ERRANDD_JOBSREPO_BRANCH ||
    process.env.ERRANDD_JOBSREPO_INTERVAL;
  if (jobsRepoEnvSet && settings.jobsRepo.url) {
    if (settings.jobsRepos.length === 0) {
      settings.jobsRepos = [{ ...settings.jobsRepo }];
    } else {
      // Update the first repo's fields that were env-overridden
      settings.jobsRepos[0] = { ...settings.jobsRepos[0], ...settings.jobsRepo };
    }
  }

  // ERRANDD_JOBSREPOS: comma-separated git URLs replace the entire list
  const multiEnv = process.env.ERRANDD_JOBSREPOS;
  if (multiEnv?.trim()) {
    const urls = multiEnv.split(",").map((u) => u.trim()).filter(Boolean);
    if (urls.length > 0) {
      settings.jobsRepos = urls.map((url) => ({
        url,
        branch: "main",
        intervalSeconds: 300,
      } as JobsRepoConfig));
    }
  }

  return settings;
}
