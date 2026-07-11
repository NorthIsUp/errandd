import { runUserMessage, ensureProjectClaudeMd } from "../runner";
import { getSession } from "../sessions";
import { loadSettings, initConfig } from "../config";
import {
  createDiscordNotifier,
  createSlackNotifier,
  createTelegramNotifier,
} from "../messaging/channelNotifiers";
import { notify, registerNotifier } from "../messaging/notifiers";

/**
 * `errandd send <message> [--telegram] [--discord] [--slack]` — run a one-shot
 * agent message and optionally fan the result out to configured chat channels.
 *
 * The outbound send goes through the shared notifier registry, exactly like the
 * daemon's interactive-queue drain — the previous inlined `fetch()` paths (which
 * had no Slack support and duplicated the chunking/error handling) are gone. We
 * register a per-channel notifier bound to the bot's DM-to-user send function,
 * then dispatch to each allowed user id through capability-respecting dispatch.
 */
export async function send(args: string[]) {
  const flags = {
    telegram: args.includes("--telegram"),
    discord: args.includes("--discord"),
    slack: args.includes("--slack"),
  };
  const CHANNEL_FLAGS = new Set(["--telegram", "--discord", "--slack"]);
  const message = args.filter((a) => !CHANNEL_FLAGS.has(a)).join(" ");

  if (!message) {
    console.error("Usage: errandd send <message> [--telegram] [--discord] [--slack]");
    process.exit(1);
  }

  await initConfig();
  await loadSettings();
  await ensureProjectClaudeMd();

  const session = await getSession();
  if (!session) {
    console.error("No active session. Start the daemon first.");
    process.exit(1);
  }

  const result = await runUserMessage("send", message);
  console.log(result.stdout);

  const text =
    result.exitCode === 0
      ? result.stdout || "(empty)"
      : `error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;

  const settings = await loadSettings();

  /** Dispatch `text` to each recipient through the notifier `id`, logging (but
   *  not aborting on) a per-recipient failure — preserving the old resilience. */
  async function fanOut(id: string, recipients: string[]): Promise<void> {
    for (const to of recipients) {
      try {
        await notify(id, { channelId: to, userId: to }, text);
      } catch (err) {
        console.error(`Failed to send to ${id} user ${to}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (flags.telegram) {
    const token = settings.telegram.token;
    const userIds = settings.telegram.allowedUserIds;
    if (!token || userIds.length === 0) {
      console.error("Telegram is not configured in settings.");
      process.exit(1);
    }
    const { sendMessage } = await import("./telegram");
    registerNotifier(
      createTelegramNotifier((chatId, t, threadId) => sendMessage(token, chatId, t, threadId)),
    );
    await fanOut("telegram", userIds.map((u) => String(u)));
    console.log("Sent to Telegram.");
  }

  if (flags.discord) {
    const dToken = settings.discord.token;
    const dUserIds = settings.discord.allowedUserIds;
    if (!dToken || dUserIds.length === 0) {
      console.error("Discord is not configured in settings.");
      process.exit(1);
    }
    const { sendMessageToUser } = await import("./discord");
    // The Discord notifier here DMs by user id (sendMessageToUser opens a DM),
    // so the destination's channelId carries the user id.
    registerNotifier(createDiscordNotifier((userId, t) => sendMessageToUser(dToken, userId, t)));
    await fanOut("discord", dUserIds);
    console.log("Sent to Discord.");
  }

  if (flags.slack) {
    const botToken = settings.slack.botToken;
    const sUserIds = settings.slack.allowedUserIds;
    if (!botToken || sUserIds.length === 0) {
      console.error("Slack is not configured in settings.");
      process.exit(1);
    }
    const { sendMessageToUser } = await import("./slack");
    registerNotifier(createSlackNotifier((userId, t) => sendMessageToUser(botToken, userId, t)));
    await fanOut("slack", sUserIds);
    console.log("Sent to Slack.");
  }

  if (result.exitCode !== 0) process.exit(result.exitCode);
}
