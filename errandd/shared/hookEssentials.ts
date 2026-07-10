/**
 * Hook Context Diet — the single DRY "essentials" layer.
 *
 * Turns any `(event, payload)` webhook into a small, flat, render-ready
 * `HookEssentials` object, then renders it to compact markdown for the model
 * prompt. This is the ONE place truncation limits + bot-noise detection live;
 * `match.ts`, `receiver.ts` and `start.ts` all import from here so the
 * 500/2000/1000-char copy-paste (and per-event boilerplate) is gone.
 *
 * Pure types + pure functions, no node/bun imports. The webhook-field
 * extractors + glob engine live in `shared/hookPayload.ts` (they're also used
 * by filtering); this module imports and reuses them rather than re-walking the
 * payload or duplicating the matcher.
 */

import {
  type DatadogPayload,
  extractHookLabel,
  matchPatternList,
  readDatadogPayload,
  type SentryPayload,
  readSentryPayload,
} from "./hookPayload";

/** One knob per truncation concern — kills the old 500/2000/1000 spread. */
export const HOOK_LIMITS = {
  /** Any human free-text body (comment / review / message). */
  freeText: 280,
  /** Bot bodies (e.g. a Greptile/CodeRabbit review) — these ARE meaningful, so
   *  we keep them, just truncated (a bit more room than human comments since
   *  review write-ups run long). They were previously dropped entirely. */
  botFreeText: 600,
  /** Issue/PR/alert title. */
  title: 160,
  /** Max label/value facts rows surfaced. */
  maxTags: 6,
  /** Hard cap on the FULL multi-line body (the rich path that feeds both the
   *  agent prompt and the chat UI). Generous so code fences, lists, headings
   *  and multi-paragraph comments survive intact — bounded only to keep a
   *  pathological mega-comment from blowing the prompt budget. The one-line
   *  `text` field still uses the `freeText`/`botFreeText` caps above. */
  richBody: 4000,
} as const;

/** Suffix appended to a truncated body: ellipsis + count of dropped chars. */
export function truncMarker(droppedChars: number): string {
  return `…⟨+${droppedChars}⟩`;
}

/**
 * Bot logins we treat as "review-dump noise" by default. Matches the
 * `[bot]` / `-bot` GitHub App suffix plus the well-known review/CI bots whose
 * comment bodies are large and rarely worth feeding to the model verbatim.
 */
export const BOT_LOGIN_RE =
  /(\[bot\]|-bot)$|^(greptile|coderabbit|coderabbitai|dependabot|github-actions|codecov|sonarcloud|sonarqubecloud|vercel|netlify|renovate)\b/i;

/** True when a login looks like an automated/bot actor. */
export function isBotActor(login: string | undefined | null): boolean {
  if (!login) {
    return false;
  }
  return BOT_LOGIN_RE.test(login);
}

export interface HookFact {
  label: string;
  value: string;
}

export interface HookBody {
  /** Truncated, single-line free text. Use this where a one-liner is the point
   *  (coalesced list rows, source-bubble labels). */
  text: string;
  /** The FULL multi-line body, newlines + markdown structure preserved, capped
   *  at {@link HOOK_LIMITS.richBody} with a `… [truncated, N chars total]` tail.
   *  This is what reaches the agent prompt and the chat UI's markdown renderer
   *  so code fences / lists / headings survive. */
  richText: string;
  /** How many chars were dropped from the one-line `text` (0 = none). */
  truncatedChars: number;
  /** True when the body came from a bot (kept, just truncated longer). */
  fromBot: boolean;
}

/** Small, flat, render-ready. No nested webhook structure survives. */
export interface HookEssentials {
  source: "github" | "sentry" | "datadog" | "linear";
  /** e.g. "issue_comment", "sentry:issue", "datadog:alert". */
  event: string;
  action?: string;
  /** "org/repo#42 — Title" / "proj: Issue title". */
  headline: string;
  url?: string;
  /** Ordered label/value rows, already truncated. */
  facts: HookFact[];
  /** The one free-text block (comment/review/message), truncated or dropped. */
  body?: HookBody;
}

/** Collapse whitespace to single spaces + trim. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Truncate a free-text body to `max` chars, single-lined, with a `…⟨+N⟩`
 * marker counting the dropped characters. `max === 0` drops the body entirely
 * (returns `{ text: "", truncatedChars: <full length> }`).
 *
 * This collapses ALL newlines — use it only where a one-liner is the point
 * (table summaries, coalesced delivery rows, source-bubble labels). For a body
 * whose markdown structure must survive, use {@link truncateRichText}.
 */
export function truncateText(
  raw: string | null | undefined,
  max: number,
): { text: string; truncatedChars: number } {
  if (typeof raw !== "string") {
    return { text: "", truncatedChars: 0 };
  }
  const collapsed = oneLine(raw);
  if (!collapsed) {
    return { text: "", truncatedChars: 0 };
  }
  if (max <= 0) {
    return { text: "", truncatedChars: collapsed.length };
  }
  if (collapsed.length <= max) {
    return { text: collapsed, truncatedChars: 0 };
  }
  const dropped = collapsed.length - max;
  return { text: `${collapsed.slice(0, max)}${truncMarker(dropped)}`, truncatedChars: dropped };
}

/**
 * Truncate a free-text body to `max` chars while PRESERVING newlines + markdown
 * structure (code fences, lists, headings, paragraphs). Trailing whitespace is
 * trimmed; interior structure is left intact. When the body overflows, the cut
 * text gets a `\n\n… [truncated, N chars total]` tail (on its own paragraph so
 * it never lands inside a code fence or list item). Returns `""` for
 * empty/whitespace bodies.
 */
export function truncateRichText(raw: string | null | undefined, max: number): string {
  if (typeof raw !== "string") {
    return "";
  }
  // Normalize CRLF and trim only the outer edges; keep interior blank lines.
  const body = raw.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
  if (!body) {
    return "";
  }
  if (max <= 0 || body.length <= max) {
    return body;
  }
  const total = body.length;
  return `${body.slice(0, max).trimEnd()}\n\n… [truncated, ${total} chars total]`;
}

function readPath(obj: unknown, path: string[]): string | null {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) {
      return null;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" ? cur : null;
}

function readNum(obj: unknown, path: string[]): number | null {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) {
      return null;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "number" ? cur : null;
}

const COMMENT_EVENTS = new Set([
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
]);

/**
 * Build the compact essentials for any webhook. One `switch (source)`
 * produces `facts` + `body`; every provider shares `truncateText` +
 * `HOOK_LIMITS`. The webhook-field extractors are imported from `match.ts`.
 */
export function buildHookEssentials(event: string, payload: unknown): HookEssentials {
  if (event.startsWith("sentry:")) {
    return sentryEssentials(event, payload);
  }
  if (event.startsWith("datadog:")) {
    return datadogEssentials(event, payload);
  }
  if (event.startsWith("linear:") || event === "linear") {
    return linearEssentials(event, payload);
  }
  return githubEssentials(event, payload);
}

function githubEssentials(event: string, payload: unknown): HookEssentials {
  const root =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  const action = typeof root.action === "string" ? root.action : undefined;
  const repo = readPath(root, ["repository", "full_name"]) ?? undefined;
  const sender = readPath(root, ["sender", "login"]) ?? undefined;
  const label = extractHookLabel(event, payload);

  const prNum =
    readNum(root, ["pull_request", "number"]) ?? readNum(root, ["issue", "number"]) ?? null;
  const prTitle =
    readPath(root, ["pull_request", "title"]) ?? readPath(root, ["issue", "title"]) ?? null;
  const prUrl =
    readPath(root, ["pull_request", "html_url"]) ?? readPath(root, ["issue", "html_url"]) ?? undefined;

  // `extractHookLabel` gives the bare `org/repo#42`; append the PR/issue title
  // (truncated) so the headline reads "org/repo#42 — Fix the flaky test".
  const titleSuffix = prTitle ? ` — ${truncateText(prTitle, HOOK_LIMITS.title).text}` : "";
  const baseHeadline =
    label ?? (repo && prNum !== null ? `${repo}#${prNum}` : repo ? repo : `github ${event}`);
  const headline =
    titleSuffix && !baseHeadline.includes(" — ") ? `${baseHeadline}${titleSuffix}` : baseHeadline;

  const facts: HookFact[] = [];
  if (sender) {
    facts.push({ label: "author", value: sender });
  }

  let body: HookBody | undefined;
  // Prefer a link to the SPECIFIC comment/review (the "source" of the trigger)
  // over the generic PR url, so the chat can jump straight to the original.
  let sourceUrl: string | undefined;

  if (event === "pull_request_review" && typeof root.review === "object" && root.review !== null) {
    const review = root.review as Record<string, unknown>;
    const state = readPath(review, ["state"]) ?? undefined;
    if (state) {
      facts.unshift({ label: "review", value: state });
    }
    body = bodyFor(readPath(review, ["body"]), sender);
    sourceUrl = readPath(review, ["html_url"]) ?? undefined;
  }

  if (COMMENT_EVENTS.has(event) && typeof root.comment === "object" && root.comment !== null) {
    const comment = root.comment as Record<string, unknown>;
    const cAuthor = readPath(comment, ["user", "login"]) ?? sender;
    const path = readPath(comment, ["path"]);
    const line =
      readNum(comment, ["line"]) ?? readNum(comment, ["original_line"]) ?? null;
    if (path) {
      facts.push({ label: "at", value: line !== null ? `${path}:${line}` : path });
    }
    body = bodyFor(readPath(comment, ["body"]), cAuthor);
    sourceUrl = readPath(comment, ["html_url"]) ?? undefined;
  }

  return prune({
    source: "github",
    event,
    action,
    headline,
    url: sourceUrl ?? prUrl,
    facts: facts.slice(0, HOOK_LIMITS.maxTags),
    body,
  });
}

/**
 * Build the truncated free-text body for an actor — the ONE place body limits
 * live. Bot authors get `botFreeText` (review write-ups run long but ARE
 * meaningful, so they're kept, just truncated a bit longer); everyone else gets
 * `freeText`. Returns undefined for empty/whitespace bodies.
 */
function bodyFor(raw: string | null | undefined, actor: string | undefined): HookBody | undefined {
  if (typeof raw !== "string" || !oneLine(raw)) {
    return undefined;
  }
  const fromBot = isBotActor(actor);
  const max = fromBot ? HOOK_LIMITS.botFreeText : HOOK_LIMITS.freeText;
  const { text, truncatedChars } = truncateText(raw, max);
  // The rich body keeps the full multi-line structure (markdown survives); the
  // one-line `text` above is only for table/list/label call sites.
  const richText = truncateRichText(raw, HOOK_LIMITS.richBody);
  return { text, richText, truncatedChars, fromBot };
}

function sentryEssentials(event: string, payload: unknown): HookEssentials {
  const root =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  const s: SentryPayload | null = readSentryPayload(root);
  const issue =
    typeof root.data === "object" && root.data !== null
      ? ((root.data as Record<string, unknown>).issue as Record<string, unknown> | undefined)
      : undefined;
  const title =
    readPath(issue ?? {}, ["title"]) ?? readPath(root, ["data", "event", "title"]) ?? null;
  const url =
    readPath(issue ?? {}, ["web_url"]) ??
    readPath(issue ?? {}, ["permalink"]) ??
    readPath(root, ["data", "event", "web_url"]) ??
    undefined;
  const project = s?.project || undefined;
  const headline =
    extractHookLabel(event, payload) ??
    (project && title ? `${project}: ${title}` : title || (project ?? `sentry ${event}`));

  const facts: HookFact[] = [];
  if (project) {
    facts.push({ label: "project", value: project });
  }
  if (s?.level) {
    facts.push({ label: "level", value: s.level });
  }
  const culprit = readPath(issue ?? {}, ["culprit"]);
  if (culprit) {
    facts.push({ label: "culprit", value: culprit });
  }
  const rawCount = issue?.count;
  const count = typeof rawCount === "number" || typeof rawCount === "string" ? String(rawCount) : null;
  if (count) {
    facts.push({ label: "count", value: count });
  }

  return prune({
    source: "sentry",
    event,
    action: s?.action || undefined,
    headline: truncateText(headline, HOOK_LIMITS.title * 2).text || headline,
    url,
    facts: facts.slice(0, HOOK_LIMITS.maxTags),
  });
}

function datadogEssentials(event: string, payload: unknown): HookEssentials {
  const root =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  const d: DatadogPayload | null = readDatadogPayload(root);
  const title = readPath(root, ["title"]) ?? readPath(root, ["event_title"]) ?? null;
  const url = readPath(root, ["link"]) ?? undefined;
  const headline =
    extractHookLabel(event, payload) ??
    title ??
    (d?.monitor ? `Datadog monitor ${d.monitor}` : `datadog ${event}`);

  const facts: HookFact[] = [];
  if (d?.priority) {
    facts.push({ label: "priority", value: d.priority });
  }
  const status = readPath(root, ["status"]) ?? readPath(root, ["alert_status"]) ?? null;
  if (status) {
    facts.push({ label: "status", value: status });
  }
  if (d && d.tags.length > 0) {
    facts.push({ label: "tags", value: d.tags.slice(0, HOOK_LIMITS.maxTags).join(", ") });
  }
  const host = readPath(root, ["hostname"]);
  if (host) {
    facts.push({ label: "host", value: host });
  }

  const message = readPath(root, ["message"]) ?? readPath(root, ["event_msg"]);
  // Datadog alerts have no human/bot actor, so the body is never bot-suppressed.
  const body = bodyFor(message, undefined);

  return prune({
    source: "datadog",
    event,
    action: d?.type || undefined,
    headline: truncateText(headline, HOOK_LIMITS.title * 2).text || headline,
    url,
    facts: facts.slice(0, HOOK_LIMITS.maxTags),
    body,
  });
}

function linearEssentials(event: string, payload: unknown): HookEssentials {
  const root =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  const identifier =
    readPath(root, ["data", "identifier"]) ?? readPath(root, ["data", "issue", "identifier"]);
  const title =
    readPath(root, ["data", "title"]) ?? readPath(root, ["data", "issue", "title"]) ?? null;
  const url = readPath(root, ["url"]) ?? readPath(root, ["data", "url"]) ?? undefined;
  const headline =
    extractHookLabel(event, payload) ??
    (identifier && title
      ? `${identifier}: ${truncateText(title, HOOK_LIMITS.title).text}`
      : identifier || title || `linear ${event}`);
  const actor = readPath(root, ["data", "user", "name"]) ?? readPath(root, ["actor", "name"]);
  const facts: HookFact[] = [];
  if (actor) {
    facts.push({ label: "actor", value: actor });
  }
  const body = bodyFor(readPath(root, ["data", "body"]), actor ?? undefined);

  return prune({
    source: "linear",
    event,
    headline,
    url,
    facts: facts.slice(0, HOOK_LIMITS.maxTags),
    body,
  });
}

/** Drop undefined keys so the rendered essentials are tight. */
function prune(e: HookEssentials): HookEssentials {
  const out = { ...e };
  if (out.action === undefined) {
    delete out.action;
  }
  if (out.url === undefined) {
    delete out.url;
  }
  if (out.body === undefined) {
    delete out.body;
  }
  return out;
}

/**
 * Render `HookEssentials` to the markdown handed to the agent AND the chat UI.
 * One headline line, one `·`-joined facts line, then the FULL comment body. A
 * plain/markdown body is rendered as a blockquote so its structure (code fences,
 * lists, headings, paragraphs) survives — `> `-prefixed line-by-line so a nested
 * ``` fence can't break out of the wrapper. A body that looks like block-level
 * HTML (e.g. Greptile's `<details><summary>…`) is emitted RAW (un-quoted): block
 * HTML doesn't parse inside a markdown blockquote, and the chat UI's renderer
 * parses + sanitizes the HTML instead (the InfoCard frame still reads as "the
 * comment"). See {@link looksLikeBlockHtml}.
 */
export function renderHookEssentialsMarkdown(e: HookEssentials): string {
  const lines: string[] = [];
  // Headline (linkified when a url is present).
  lines.push(e.url ? `[${e.headline}](${e.url})` : e.headline);

  // Facts: compact "· label: value · label: value" on one line.
  const factParts: string[] = [];
  if (e.action) {
    factParts.push(`action: ${e.action}`);
  }
  for (const f of e.facts) {
    factParts.push(`${f.label}: ${f.value}`);
  }
  if (factParts.length > 0) {
    lines.push(`· ${factParts.join(" · ")}`);
  }

  // Body: the full multi-line body (bot bodies are kept — just capped longer).
  // Falls back to the one-line `text` if `richText` is somehow absent (defensive
  // — `bodyFor` always sets it).
  const rich = e.body?.richText || e.body?.text;
  if (rich) {
    // Plain/markdown bodies are `> `-blockquoted so a nested ``` code fence can't
    // escape the wrapper. But block-level HTML (Greptile's `<details><summary>…`,
    // tables, `<img>`) does NOT parse inside a markdown blockquote — CommonMark's
    // HTML-block rule is unreliable under `> `, so a quoted `<details>` renders as
    // literal text. For HTML bodies we emit the raw body un-quoted so the renderer's
    // rehype-raw pipeline parses it; the InfoCard's border + indent still frames it
    // visually as "the comment". The code-fence-escape concern doesn't apply to HTML.
    lines.push(looksLikeBlockHtml(rich) ? rich : blockquote(rich));
  }

  return lines.join("\n");
}

/** True when the body opens with (or contains) a block-level HTML tag that won't
 *  render cleanly inside a markdown blockquote. Covers the GitHub-comment patterns
 *  bots emit: `<details>`/`<summary>` collapsibles, tables, headings, images,
 *  block quotes and bare `<div>`/`<p>` wrappers. Inline tags (`<b>`, `<code>`,
 *  `<a>`) are fine inside a blockquote, so they don't trip this. */
function looksLikeBlockHtml(body: string): boolean {
  return /<(details|summary|table|thead|tbody|tr|th|td|div|h[1-6]|blockquote|img|p|ul|ol|li|pre)\b/im.test(
    body,
  );
}

/** Prefix every line of `body` with `> ` so multi-line markdown renders inside
 *  one blockquote and a nested code fence can't escape the wrapper. Blank lines
 *  become a bare `>` to keep the quote contiguous across paragraphs. */
function blockquote(body: string): string {
  return body
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * Returns a skip reason when this event should be DROPPED before prompting
 * (recorded as a `prefilter` skip, never fed to the model), else null.
 *
 *   - bot-authored comment/review whose body is suppressible noise
 *     → "bot noise: <login>" (unless the bot is allowlisted by `commentsUser`)
 *
 * Own-bot (self) skips stay in `receiver.ts` (it already knows the self login),
 * and non-actionable action churn is left to the existing per-rule matchers,
 * so this fires only for the bot-noise case the diet targets (Greptile/
 * CodeRabbit/dependabot review dumps).
 *
 * `commentsUser` is the job's `comments.user` glob list (when configured) — an
 * allowlisted bot (e.g. Greptile-as-trigger) is never prefiltered.
 */
export function prefilterReason(
  event: string,
  payload: unknown,
  commentsUser?: string[],
): string | null {
  if (!COMMENT_EVENTS.has(event)) {
    return null;
  }
  const root =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  // The actor is the sender (who the action is on behalf of), matching the
  // receiver's comment-matching identity.
  const actor = readPath(root, ["sender", "login"]) ?? readPath(root, ["comment", "user", "login"]);
  if (!isBotActor(actor)) {
    return null;
  }
  // A bot explicitly allowlisted as a comment trigger is NOT prefiltered —
  // don't break Greptile-as-trigger setups.
  if (commentsUser && actor && matchPatternList(commentsUser, actor)) {
    return null;
  }
  return `bot noise: ${actor ?? "bot"}`;
}
