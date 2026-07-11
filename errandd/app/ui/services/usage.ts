import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectDir } from "../../../shared/claudeProjectDir";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shape of one line in a Claude session .jsonl transcript. */
interface JSONLEntry {
  type?: string;
  message?: {
    id?: string;
    /** Response model id on assistant turns (e.g. "claude-opus-4-…"). Absent on
     *  some entries; "<synthetic>" for injected messages that carry no real
     *  model. Drives per-model cost attribution. */
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

/** Shape of .claude/errandd/session.json for the global web session. */
interface SessionFileData {
  sessionId?: string;
  turnCount?: number;
  lastUsedAt?: string;
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// Pricing — per-model, keyed on the real model id the transcript carries.
// ---------------------------------------------------------------------------
// Rates are USD per million tokens (Claude API list pricing). Cache-read ≈ 0.1×
// input; cache-write (5-minute TTL) ≈ 1.25× input. The JSONL transcript reports
// per-message model + token usage but NOT a per-message cost, so we still derive
// cost here — but per the message's OWN model, not a flat Sonnet rate. Live runs
// use the CLI-reported total_cost_usd instead (see runner telemetry); this
// post-hoc parser is the fallback for figures the stream never carried.
interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const OPUS: Rates = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const SONNET: Rates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const HAIKU: Rates = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
const FABLE: Rates = { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 };

// When a transcript carries no usable model field, figures are estimates priced
// at this rate (Sonnet) and flagged `isEstimate` — never silently authoritative.
const ESTIMATE_RATES = SONNET;

/** Resolve pricing from a real model id. Unknown/empty ids fall back to the
 *  estimate rate (used for the odd modelless message in a mixed session). */
function ratesForModel(model: string): Rates {
  const m = model.toLowerCase();
  if (m.includes("opus")) return OPUS;
  if (m.includes("haiku")) return HAIKU;
  if (m.includes("fable") || m.includes("mythos")) return FABLE;
  if (m.includes("sonnet")) return SONNET;
  return ESTIMATE_RATES;
}

// ---------------------------------------------------------------------------

interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Parsed transcript usage: aggregate token totals plus a per-model breakdown so
 *  cost can be summed against each message's own model. `hasModelField` is true
 *  iff at least one assistant message carried a real (non-synthetic) model id —
 *  when false, the figures are labeled estimates. */
export interface ParsedUsage extends TokenCounts {
  /** Real model id → tokens attributed to it. Modelless messages bucket under
   *  "" (priced at the estimate rate when the session is otherwise attributed). */
  perModel: Map<string, TokenCounts>;
  hasModelField: boolean;
}

export interface SessionUsage {
  sessionId: string;
  label: string;
  channel: "discord" | "web" | "unknown";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  /** True when no per-message model id was available and the cost is a
   *  Sonnet-rate approximation rather than a real per-model figure. */
  isEstimate: boolean;
  cacheHitPct: number;
  turnCount: number;
  lastUsedAt: string;
}

function emptyTokens(): TokenCounts {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function emptyParsed(): ParsedUsage {
  return { ...emptyTokens(), perModel: new Map(), hasModelField: false };
}

function costOf(r: Rates, t: TokenCounts): number {
  return (
    (t.inputTokens * r.input +
      t.outputTokens * r.output +
      t.cacheReadTokens * r.cacheRead +
      t.cacheWriteTokens * r.cacheWrite) /
    1_000_000
  );
}

/**
 * Cost for a parsed transcript.
 * - With a per-message model field: sum each model's tokens at that model's own
 *   rate (mixed-model sessions price correctly). `isEstimate: false`.
 * - Without any model field: apply the estimate (Sonnet) rate to the aggregate
 *   and flag `isEstimate: true` — do NOT present a guess as authoritative.
 *
 * Exported for the acceptance test (non-Sonnet sessions must price differently).
 */
export function calcSessionCost(parsed: ParsedUsage): { costUsd: number; isEstimate: boolean } {
  if (!parsed.hasModelField) {
    return { costUsd: costOf(ESTIMATE_RATES, parsed), isEstimate: true };
  }
  let costUsd = 0;
  for (const [model, tokens] of parsed.perModel) {
    costUsd += costOf(ratesForModel(model), tokens);
  }
  return { costUsd, isEstimate: false };
}

/**
 * Parse a Claude session transcript at `filePath` into aggregate + per-model
 * token usage. Exported for tests; production callers go through
 * {@link parseJSONLUsage}, which resolves the path from the session id.
 */
export async function parseTranscriptUsage(filePath: string): Promise<ParsedUsage> {
  const parsed = emptyParsed();
  const seenIds = new Set<string>();
  try {
    const content = await readFile(filePath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as JSONLEntry;
        if (entry.type !== "assistant") continue;
        const msgId: string | undefined = entry.message?.id;
        if (msgId) {
          if (seenIds.has(msgId)) continue;
          seenIds.add(msgId);
        }
        const u = entry.message?.usage;
        if (!u) continue;

        // "<synthetic>" is not a real priced model — treat as modelless.
        const rawModel = entry.message?.model;
        const model = rawModel && rawModel !== "<synthetic>" ? rawModel : "";
        if (model) parsed.hasModelField = true;

        const inputTokens = u.input_tokens ?? 0;
        const outputTokens = u.output_tokens ?? 0;
        const cacheReadTokens = u.cache_read_input_tokens ?? 0;
        const cacheWriteTokens = u.cache_creation_input_tokens ?? 0;

        parsed.inputTokens += inputTokens;
        parsed.outputTokens += outputTokens;
        parsed.cacheReadTokens += cacheReadTokens;
        parsed.cacheWriteTokens += cacheWriteTokens;

        const bucket = parsed.perModel.get(model) ?? emptyTokens();
        bucket.inputTokens += inputTokens;
        bucket.outputTokens += outputTokens;
        bucket.cacheReadTokens += cacheReadTokens;
        bucket.cacheWriteTokens += cacheWriteTokens;
        parsed.perModel.set(model, bucket);
      } catch {}
    }
  } catch {}

  return parsed;
}

async function parseJSONLUsage(sessionId: string): Promise<ParsedUsage> {
  if (!UUID_RE.test(sessionId)) return emptyParsed();
  const filePath = join(claudeProjectDir(), `${sessionId}.jsonl`);
  if (!existsSync(filePath)) return emptyParsed();
  return parseTranscriptUsage(filePath);
}

function buildEntry(
  sessionId: string,
  label: string,
  channel: SessionUsage["channel"],
  turnCount: number,
  lastUsedAt: string,
  parsed: ParsedUsage,
): SessionUsage {
  const totalIn = parsed.inputTokens + parsed.cacheReadTokens + parsed.cacheWriteTokens;
  const { costUsd, isEstimate } = calcSessionCost(parsed);
  return {
    sessionId,
    label,
    channel,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    cacheReadTokens: parsed.cacheReadTokens,
    cacheWriteTokens: parsed.cacheWriteTokens,
    estimatedCostUsd: costUsd,
    isEstimate,
    cacheHitPct: totalIn > 0 ? Math.round((parsed.cacheReadTokens / totalIn) * 100) : 0,
    turnCount,
    lastUsedAt,
  };
}

let usageCache: { data: SessionUsage[]; ts: number } | null = null;
const CACHE_TTL_MS = 60_000;

export async function getSessionUsage(channelNames?: Record<string, string>): Promise<SessionUsage[]> {
  if (usageCache && Date.now() - usageCache.ts < CACHE_TTL_MS) {
    return usageCache.data;
  }

  const cwd = process.cwd();
  const sessions: SessionUsage[] = [];

  // Global web session
  const sessionFile = join(cwd, ".claude", "errandd", "session.json");
  try {
    if (existsSync(sessionFile)) {
      const data = JSON.parse(await readFile(sessionFile, "utf-8")) as SessionFileData;
      if (data.sessionId && UUID_RE.test(data.sessionId)) {
        const parsed = await parseJSONLUsage(data.sessionId);
        sessions.push(buildEntry(
          data.sessionId, "global", "web",
          data.turnCount ?? 0,
          data.lastUsedAt ?? data.createdAt ?? "",
          parsed,
        ));
      }
    }
  } catch {}

  // Per-channel Discord sessions
  try {
    const { listThreadSessions } = await import("../../sessionManager");
    for (const t of await listThreadSessions()) {
      const threadId = t.threadId;
      if (!UUID_RE.test(t.sessionId)) continue;
      const label = channelNames?.[threadId] ?? `#${threadId}`;
      const parsed = await parseJSONLUsage(t.sessionId);
      sessions.push(buildEntry(
        t.sessionId, label, "discord",
        t.turnCount ?? 0,
        t.lastUsedAt || t.createdAt,
        parsed,
      ));
    }
  } catch {}

  sessions.sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);
  usageCache = { data: sessions, ts: Date.now() };
  return sessions;
}
