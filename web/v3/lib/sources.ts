/**
 * Derive `SourceLink[]` for a thread (spec §6).
 *
 * Two inputs feed the Source rail under an assistant turn:
 *   1. The hook origin URL — pulled from the thread's first queue-row `payload`
 *      (GitHub PR `html_url`, Sentry issue url, Datadog monitor url).
 *   2. `file_path` inputs from the transcript's tool calls → `file:line` links.
 *
 * The backend (`threadParts.ts`) attaches `sources` parts directly, but this
 * module is the shared, framework-free derivation so the client can recompute
 * or augment sources from raw queue payloads + tool parts without a round-trip.
 */

import type { SourceLink, ToolPart } from "./transcriptParts";

/** A loose payload bag — webhook JSON is provider-specific and untyped here. */
type Payload = Record<string, unknown> | null | undefined;

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** First defined string at any of the given dot-paths within `obj`. */
function pick(obj: Record<string, unknown>, paths: string[]): string | undefined {
  for (const path of paths) {
    let cur: unknown = obj;
    for (const seg of path.split(".")) {
      const rec = asRecord(cur);
      if (!rec) {
        cur = undefined;
        break;
      }
      cur = rec[seg];
    }
    const s = asString(cur);
    if (s) {
      return s;
    }
  }
  return undefined;
}

/** Build a SourceLink, omitting `title` entirely when undefined (exact-optional). */
function link(href: string, label: string, title?: string): SourceLink {
  return title ? { href, label, title } : { href, label };
}

function hostLabel(href: string, fallback: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return fallback;
  }
}

/**
 * Pull the hook origin link out of a raw queue-row payload. Probes the common
 * URL fields across GitHub / Sentry / Datadog webhook shapes; returns null when
 * none is present (e.g. a plain cron run with no origin).
 */
export function originSource(payload: Payload): SourceLink | null {
  const p = asRecord(payload);
  if (!p) {
    return null;
  }

  // GitHub: pull_request.html_url / issue.html_url / top-level html_url.
  const gh = pick(p, [
    "pull_request.html_url",
    "issue.html_url",
    "review.html_url",
    "comment.html_url",
    "html_url",
  ]);
  if (gh) {
    const num =
      pick(p, ["pull_request.number", "issue.number", "number"]) ??
      asString((asRecord(p.pull_request) ?? asRecord(p.issue))?.number);
    const repo = pick(p, ["repository.full_name", "repo"]);
    const label = num ? `${repo ? `${repo}#` : "#"}${num}` : (repo ?? "GitHub");
    return link(gh, label, pick(p, ["pull_request.title", "issue.title"]));
  }

  // Sentry: issue url / web_url / permalink.
  const sentry = pick(p, [
    "issue.web_url",
    "issue.url",
    "data.issue.web_url",
    "url",
    "web_url",
    "permalink",
  ]);
  if (sentry && /sentry/i.test(sentry)) {
    return link(
      sentry,
      pick(p, ["issue.shortId", "issue.id", "data.issue.shortId"]) ?? "Sentry",
      pick(p, ["issue.title", "data.issue.title", "message"]),
    );
  }

  // Datadog: monitor / event link.
  const dd = pick(p, ["monitor.url", "alert.url", "link", "event_url", "url"]);
  if (dd) {
    return link(
      dd,
      pick(p, ["monitor.name", "alert.title", "title"]) ?? hostLabel(dd, "Datadog"),
      pick(p, ["alert.body", "body", "message"]),
    );
  }

  // Generic fallback: any top-level absolute URL field.
  const any = pick(p, ["url", "web_url", "link", "html_url"]);
  if (any) {
    return { href: any, label: hostLabel(any, any) };
  }

  return null;
}

/** Tool inputs that carry a file path under various Claude tools. */
const FILE_PATH_KEYS = ["file_path", "filePath", "path", "notebook_path"] as const;

/**
 * Extract `file:line` source links from a tool call's input. Reads the file
 * path plus an optional `offset`/line so the label reads e.g. `server.ts:210`.
 */
export function fileSourceFromTool(tool: ToolPart): SourceLink | null {
  const input = tool.input;
  if (!input) {
    return null;
  }

  let file: string | undefined;
  for (const k of FILE_PATH_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.length > 0) {
      file = v;
      break;
    }
  }
  if (!file) {
    return null;
  }

  const line =
    typeof input.offset === "number"
      ? input.offset
      : typeof input.line === "number"
        ? input.line
        : undefined;

  const base = file.split("/").pop() || file;
  const label = line == null ? base : `${base}:${line}`;
  // file:// href so it's a real anchor; editors/IDEs can intercept it.
  const href = `file://${file.startsWith("/") ? "" : "/"}${file}`;
  return { href, label, title: file };
}

/**
 * Build the full ordered, de-duplicated `SourceLink[]` for a thread: the hook
 * origin first, then each distinct `file:line` touched by a tool call.
 */
export function deriveSources(payload: Payload, tools: ToolPart[]): SourceLink[] {
  const out: SourceLink[] = [];
  const seen = new Set<string>();

  const push = (s: SourceLink | null) => {
    if (!s || seen.has(s.href)) {
      return;
    }
    seen.add(s.href);
    out.push(s);
  };

  push(originSource(payload));
  for (const t of tools) {
    push(fileSourceFromTool(t));
  }

  return out;
}
