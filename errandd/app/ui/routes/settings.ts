import { json } from "../http";
import { readHeartbeatSettings, updateHeartbeatSettings } from "../services/settings";
import { buildTechnicalInfo, sanitizeSettings } from "../services/state";
import { getSessionUsage } from "../services/usage";
import type { RouteHandler } from "./types";

/** GET /api/settings — sanitized settings. */
export const settingsGet: RouteHandler = ({ opts }) =>
  json(sanitizeSettings(opts.getSnapshot().settings));

/** PUT /api/settings — shallow/deep merge of an allowlist of keys. */
export const settingsPut: RouteHandler = async ({ req }) => {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const { readFile, writeFile } = await import("node:fs/promises");
    const { SETTINGS_FILE } = await import("../constants");
    const raw = await readFile(SETTINGS_FILE, "utf-8").catch(() => "{}");
    const data = JSON.parse(raw) as Record<string, unknown>;
    // Allow shallow-merge of these top-level keys
    const allowed = ["model", "fallback", "security", "timezone", "jobsRepo", "git"] as const;
    for (const key of allowed) {
      if (key in body && body[key] !== undefined) {
        if (typeof body[key] === "object" && body[key] !== null && !Array.isArray(body[key])) {
          // Deep merge objects one level
          data[key] = Object.assign({}, typeof data[key] === "object" ? data[key] : {}, body[key]);
        } else if (typeof body[key] === "string") {
          data[key] = body[key];
        }
      }
    }
    // jobsRepos: accept an array directly, drop rows with empty URLs
    if ("jobsRepos" in body && Array.isArray(body.jobsRepos)) {
      data.jobsRepos = (body.jobsRepos as unknown[])
        .filter(
          (r: unknown) =>
            r &&
            typeof r === "object" &&
            typeof (r as Record<string, unknown>).url === "string" &&
            String((r as Record<string, unknown>).url).trim(),
        )
        .map((r: unknown) => {
          const row = r as Record<string, unknown>;
          return {
            kind: row.kind === "plugin" ? "plugin" : "git",
            url: String(row.url).trim(),
            branch:
              typeof row.branch === "string" && row.branch.trim() ? row.branch.trim() : "main",
            intervalSeconds:
              Number.isFinite(Number(row.intervalSeconds)) && Number(row.intervalSeconds) >= 0
                ? Number(row.intervalSeconds)
                : 300,
          };
        });
    }
    await writeFile(SETTINGS_FILE, `${JSON.stringify(data, null, 2)}\n`);
    // Refresh the in-memory settings cache so the next /api/state read is current.
    const { reloadSettings } = await import("../../config");
    await reloadSettings();
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 500);
  }
};

/** POST /api/settings/heartbeat — patch heartbeat config. */
export const heartbeatPost: RouteHandler = async ({ req, opts }) => {
  try {
    const payload = await req.json() as {
      enabled?: unknown;
      interval?: unknown;
      prompt?: unknown;
      excludeWindows?: unknown;
    };
    const patch: {
      enabled?: boolean;
      interval?: number;
      prompt?: string;
      excludeWindows?: { days?: number[]; start: string; end: string }[];
    } = {};

    if ("enabled" in payload) {
      patch.enabled = Boolean(payload.enabled);
    }
    if ("interval" in payload) {
      const iv = Number(payload.interval);
      if (!Number.isFinite(iv)) {
        throw new Error("interval must be numeric");
      }
      patch.interval = iv;
    }
    if ("prompt" in payload) {
      patch.prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    }
    if ("excludeWindows" in payload) {
      if (!Array.isArray(payload.excludeWindows)) {
        throw new Error("excludeWindows must be an array");
      }
      patch.excludeWindows = payload.excludeWindows
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => {
          const row = entry as Record<string, unknown>;
          const start = (typeof row.start === "string" ? row.start : "").trim();
          const end = (typeof row.end === "string" ? row.end : "").trim();
          const days = Array.isArray(row.days)
            ? row.days.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
            : undefined;
          return {
            start,
            end,
            ...(days && days.length > 0 ? { days } : {}),
          };
        });
    }

    if (
      !("enabled" in patch || "interval" in patch || "prompt" in patch || "excludeWindows" in patch)
    ) {
      throw new Error("no heartbeat fields provided");
    }

    const next = await updateHeartbeatSettings(patch);
    if (opts.onHeartbeatEnabledChanged && "enabled" in patch) {
      await opts.onHeartbeatEnabledChanged(Boolean(patch.enabled));
    }
    if (opts.onHeartbeatSettingsChanged) {
      await opts.onHeartbeatSettingsChanged(patch);
    }
    return json({ ok: true, heartbeat: next });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
};

/** GET /api/settings/heartbeat — current heartbeat config. */
export const heartbeatGet: RouteHandler = async () => {
  try {
    return json({ ok: true, heartbeat: await readHeartbeatSettings() });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
};

/** GET /api/technical-info — build + runtime diagnostics. */
export const technicalInfo: RouteHandler = async ({ opts }) =>
  json(await buildTechnicalInfo(opts.getSnapshot()));

/** GET /api/usage — per-session token/cost usage. */
export const usage: RouteHandler = async ({ opts }) => {
  try {
    const channelNames = opts.getSnapshot().settings.discord?.channelNames;
    return json(await getSessionUsage(channelNames));
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
};

/** GET /api/usage-timeline — usage bucketed over a time range. */
export const usageTimeline: RouteHandler = async ({ url, opts }) => {
  try {
    const channelNames = opts.getSnapshot().settings.discord?.channelNames;
    const range = url.searchParams.get("range") ?? "24h";
    const sessions = await getSessionUsage(channelNames);
    const now = Date.now();
    const rangeMs: Record<string, number> = {
      "1h": 3_600_000,
      "24h": 86_400_000,
      "7d": 604_800_000,
      "30d": 2_592_000_000,
    };
    const windowMs = rangeMs[range] ?? rangeMs["24h"];
    const bucketCount = range === "1h" ? 12 : range === "24h" ? 24 : range === "7d" ? 7 : 30;
    const bucketMs = windowMs / bucketCount;
    const cutoff = now - windowMs;
    interface Bucket {
      ts: string;
      totalCostUsd: number;
      totalTokens: number;
      byJob: Record<string, number>;
    }
    const buckets: Bucket[] = Array.from({ length: bucketCount }, (_, i) => ({
      ts: new Date(cutoff + i * bucketMs + bucketMs / 2).toISOString(),
      totalCostUsd: 0,
      totalTokens: 0,
      byJob: {},
    }));
    for (const s of sessions) {
      const t = s.lastUsedAt ? new Date(s.lastUsedAt).getTime() : 0;
      if (t < cutoff || t > now) {
        continue;
      }
      const idx = Math.min(bucketCount - 1, Math.floor((t - cutoff) / bucketMs));
      const bucket = buckets[idx];
      if (!bucket) {
        continue;
      }
      bucket.totalCostUsd += s.estimatedCostUsd;
      // Excludes cache read/write — those are discounted context re-sends, not new work.
      bucket.totalTokens += s.inputTokens + s.outputTokens;
      if (s.label) {
        bucket.byJob[s.label] = (bucket.byJob[s.label] ?? 0) + s.estimatedCostUsd;
      }
    }
    return json({ buckets });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
};
