/**
 * Outbound NOTIFIER registry — the send-out seam (overhaul 3/6).
 *
 * errandd fans messages OUT to chat/notification channels (Telegram, Discord,
 * Slack today; email / PagerDuty / SMS as plugins tomorrow). Before this seam
 * every outbound path was bespoke: divergent `sendMessage` signatures, a
 * hardcoded `switch (platform)` in the interactive-queue drain, three
 * copy-pasted init closures, and a second inlined `fetch()` path in
 * `commands/send.ts`. This module unifies all of that behind ONE `Notifier`
 * interface and a Map registry — the exact pattern used by the runtime registry
 * (app/runtime/registry.ts) and the inbound source registry (app/hooks/sources.ts).
 *
 * A `Notifier` is an OUTBOUND adapter only. It does NOT own an inbound event
 * loop — the Telegram/Discord/Slack bots keep their receive runtimes untouched;
 * the channel adapters (app/messaging/channelNotifiers.ts) merely wrap the bots'
 * already-present `sendMessage` functions.
 *
 * ── Capability-respecting dispatch ─────────────────────────────────────────
 * Every notifier declares a {@link NotifierCapabilities} descriptor. Callers
 * MUST route through {@link dispatchNotify} (never call `send` on a raw string
 * blindly) so the shared dispatcher honors the declared limits: it splits at
 * `maxMessageLength` rather than letting a channel silently truncate, and it
 * passes text through in the notifier's declared `formattingDialect` (no
 * cross-dialect mangling — the caller supplies text already in that dialect).
 *
 * ── Registration ───────────────────────────────────────────────────────────
 * The three built-in channel adapters register at daemon boot (start.ts); plugin
 * notifiers register through `PluginManager.registerNotifier` (app/plugins.ts).
 * Ids are matched case-insensitively and a re-register overrides.
 */

/**
 * A fully-normalized, all-string outbound destination. Deliberately free of any
 * platform-native numeric types: Telegram chat ids are numbers on the wire, but
 * that coercion lives INSIDE the telegram adapter (channelNotifiers.ts), never
 * in this shared shape. A destination is one of:
 *   - a channel/room/chat (`channelId`), optionally a thread within it
 *     (`threadId`); and/or
 *   - a direct user (`userId`) for DM-style notifiers.
 * A notifier reads whichever fields it supports and ignores the rest.
 */
export interface ChannelDestination {
  /** The channel / room / chat id (all-string; adapters coerce as needed). */
  channelId: string;
  /** Optional thread within the channel (forum topic, Slack `thread_ts`, …). */
  threadId?: string;
  /** Optional direct-recipient id, for DM-style sends. */
  userId?: string;
}

/**
 * The text dialect a notifier accepts. The caller is expected to hand
 * {@link dispatchNotify} text already in this dialect (pass-through — the
 * dispatcher does not transcode between dialects in this seam).
 */
export type FormattingDialect = "markdown" | "html" | "mrkdwn" | "plain";

/**
 * What a notifier can and cannot do. Dispatch respects these: `maxMessageLength`
 * bounds every outbound chunk (no silent truncation), `formattingDialect`
 * declares the expected input dialect, `threading` says whether `threadId` is
 * honored, and `interactiveReply` says whether the channel can carry a
 * back-and-forth reply (the durable interactive queue only drains to notifiers
 * where this is true).
 */
export interface NotifierCapabilities {
  /** Does the notifier route `dest.threadId` (forum topic / thread)? */
  threading: boolean;
  /** The text dialect the notifier expects its message body in. */
  formattingDialect: FormattingDialect;
  /** Hard upper bound on a single outbound message; dispatch splits past it. */
  maxMessageLength: number;
  /** Can this channel carry an interactive (queued) reply back to a user? */
  interactiveReply: boolean;
}

/**
 * One outbound notifier. `id` is its registry key (case-insensitive). `send`
 * delivers a single already-bounded message to a destination; multi-part
 * splitting is the dispatcher's job, so `send` may assume `msg.length <=
 * capabilities.maxMessageLength` when called via {@link dispatchNotify}. The
 * optional `start`/`stop` hooks are for notifiers that hold a connection
 * (SMTP pool, socket); the chat adapters leave them unset because the bots own
 * their own lifecycle.
 */
export interface Notifier {
  id: string;
  capabilities: NotifierCapabilities;
  send(dest: ChannelDestination, msg: string): Promise<void>;
  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;
}

// ── Registry ─────────────────────────────────────────────────────────────────

/** id (lowercased) → Notifier. */
const registry = new Map<string, Notifier>();

/** Register (or override) a notifier. Its `id` is matched case-insensitively. */
export function registerNotifier(notifier: Notifier): void {
  registry.set(notifier.id.toLowerCase(), notifier);
}

/** Remove a registration. Returns whether one existed. */
export function unregisterNotifier(id: string): boolean {
  return registry.delete(id.toLowerCase());
}

/** Look up a notifier by id (case-insensitive), or undefined. */
export function getNotifier(id: string): Notifier | undefined {
  return registry.get(id.toLowerCase());
}

/** Is `id` a registered notifier? */
export function hasNotifier(id: string): boolean {
  return registry.has(id.toLowerCase());
}

/** All registered notifier ids (lowercased), in registration order. */
export function registeredNotifierIds(): string[] {
  return Array.from(registry.keys());
}

/** All registered notifiers, in registration order. */
export function allNotifiers(): Notifier[] {
  return Array.from(registry.values());
}

/** Test-only: drop every registration so a suite starts clean. */
export function __resetNotifiersForTests(): void {
  registry.clear();
}

// ── Capability-respecting dispatch ───────────────────────────────────────────

/**
 * Split `text` into pieces no longer than `max`, preferring to break on a
 * newline (then a space) near the boundary so words/lines aren't torn mid-token.
 * Falls back to a hard slice when no whitespace break exists. Never truncates:
 * the concatenation of the returned pieces preserves every character except a
 * single whitespace char consumed at each chosen break point.
 */
export function splitForLength(text: string, max: number): string[] {
  if (max <= 0 || text.length <= max) {
    return text.length === 0 ? [] : [text];
  }
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    // Prefer a newline break, then a space; only within the last ~20% so we
    // don't produce tiny fragments. Otherwise hard-split at `max`.
    const minBreak = Math.floor(max * 0.8);
    let cut = window.lastIndexOf("\n");
    if (cut < minBreak) {
      cut = window.lastIndexOf(" ");
    }
    if (cut < minBreak) {
      cut = max; // hard split; no good whitespace boundary
    }
    out.push(rest.slice(0, cut));
    // Drop the single break char when we split on whitespace.
    rest = cut === max ? rest.slice(cut) : rest.slice(cut + 1);
  }
  if (rest.length > 0) {
    out.push(rest);
  }
  return out;
}

/**
 * Deliver `msg` to `dest` through `notifier`, respecting its capabilities:
 * the message is split into `maxMessageLength`-bounded chunks (no silent
 * truncation) and each chunk is sent in order. Text is passed through in the
 * notifier's declared dialect — the dispatcher does not transcode. This is the
 * ONLY sanctioned outbound path; call sites must not invoke `notifier.send`
 * directly with an unbounded string.
 */
export async function dispatchNotify(
  notifier: Notifier,
  dest: ChannelDestination,
  msg: string,
): Promise<void> {
  const chunks = splitForLength(msg, notifier.capabilities.maxMessageLength);
  for (const chunk of chunks) {
    await notifier.send(dest, chunk);
  }
}

/**
 * Convenience: look up `id` and dispatch. Returns false when no notifier is
 * registered for `id` (e.g. its token was removed, or it's a historical/unknown
 * platform string from a durable row) so the caller can retry or skip — it
 * never throws on an unknown id.
 */
export async function notify(
  id: string,
  dest: ChannelDestination,
  msg: string,
): Promise<boolean> {
  const notifier = getNotifier(id);
  if (!notifier) {
    return false;
  }
  await dispatchNotify(notifier, dest, msg);
  return true;
}
