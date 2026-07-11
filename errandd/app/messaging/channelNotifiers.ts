/**
 * Thin OUTBOUND adapters for the three built-in chat channels (overhaul 3/6).
 *
 * Each factory wraps the EXISTING bot `sendMessage` function — it does NOT
 * re-implement any bot logic. The inbound event loops in
 * `commands/{telegram,discord,slack}.ts` are untouched by this seam; these
 * adapters only give the outbound send a uniform {@link Notifier} shape so the
 * registry can dispatch to it.
 *
 * The bot send functions still do their own platform-native work (Telegram
 * markdown→HTML conversion + 4096 chunking, Discord 2000 chunking, Slack
 * `[react:]` stripping + 3800 mrkdwn chunking). The adapter's job is purely to
 * translate a normalized {@link ChannelDestination} into that function's
 * arguments — including, for Telegram, the numeric coercion of chat/thread ids,
 * which lives HERE and nowhere in the shared destination type.
 *
 * `start.ts` builds these with the freshly-imported, token-bound bot functions
 * at boot (and on settings reload) and registers them in the notifier registry.
 */

import type { ChannelDestination, Notifier, NotifierCapabilities } from "./notifiers";

/** Telegram: threaded (forum topics), markdown input (bot converts to HTML),
 *  4096-char API limit, carries interactive replies. */
export const TELEGRAM_CAPABILITIES: NotifierCapabilities = {
  threading: true,
  formattingDialect: "markdown",
  maxMessageLength: 4096,
  interactiveReply: true,
};

/** Discord: no thread routing on the outbound channel send, markdown input,
 *  2000-char message limit, carries interactive replies. */
export const DISCORD_CAPABILITIES: NotifierCapabilities = {
  threading: false,
  formattingDialect: "markdown",
  maxMessageLength: 2000,
  interactiveReply: true,
};

/** Slack: threaded (`thread_ts`), mrkdwn input, 40000-char limit (the bot
 *  further chunks at 3800 for block limits), carries interactive replies. */
export const SLACK_CAPABILITIES: NotifierCapabilities = {
  threading: true,
  formattingDialect: "mrkdwn",
  maxMessageLength: 40000,
  interactiveReply: true,
};

/** The bot's Telegram send, already bound to a token. */
export type TelegramRawSend = (chatId: number, text: string, threadId?: number) => Promise<void>;
/** The bot's Discord channel send, already bound to a token. */
export type DiscordRawSend = (channelId: string, text: string) => Promise<void>;
/** The bot's Slack channel send, already bound to a token. */
export type SlackRawSend = (channelId: string, text: string, threadTs?: string) => Promise<void>;

/**
 * Wrap the Telegram bot send as a Notifier. The numeric coercion of the
 * all-string `channelId`/`threadId` into Telegram's native `number` chat/thread
 * ids is contained ENTIRELY here — the shared {@link ChannelDestination} stays
 * string-typed. A non-finite thread id is dropped (sent to the channel root).
 */
export function createTelegramNotifier(send: TelegramRawSend): Notifier {
  return {
    id: "telegram",
    capabilities: TELEGRAM_CAPABILITIES,
    async send(dest: ChannelDestination, msg: string): Promise<void> {
      const chatId = Number(dest.channelId);
      const threadId = dest.threadId != null ? Number(dest.threadId) : undefined;
      await send(chatId, msg, threadId != null && Number.isFinite(threadId) ? threadId : undefined);
    },
  };
}

/** Wrap the Discord bot channel send as a Notifier (channel ids are strings). */
export function createDiscordNotifier(send: DiscordRawSend): Notifier {
  return {
    id: "discord",
    capabilities: DISCORD_CAPABILITIES,
    async send(dest: ChannelDestination, msg: string): Promise<void> {
      await send(dest.channelId, msg);
    },
  };
}

/** Wrap the Slack bot channel send as a Notifier, forwarding the optional
 *  thread (`thread_ts`) from the normalized destination. */
export function createSlackNotifier(send: SlackRawSend): Notifier {
  return {
    id: "slack",
    capabilities: SLACK_CAPABILITIES,
    async send(dest: ChannelDestination, msg: string): Promise<void> {
      await send(dest.channelId, msg, dest.threadId ?? undefined);
    },
  };
}
