/**
 * Email NOTIFIER — the existence proof for the open (plugin) tier of the
 * outbound notifier registry (overhaul 3/6), the outbound analogue of the
 * generic-webhook source plugin (app/hooks/genericWebhook.ts).
 *
 * It is deliberately minimal but real: config-driven sender/recipient, a
 * pluggable transport (default: an HTTP JSON email API — the shape Mailgun /
 * Postmark / SES-style endpoints accept), and a capability descriptor that is
 * honestly NOT chat-like — no threading, a plain- or html-text dialect, a large
 * `maxMessageLength`, and no interactive reply (email is fire-and-forget; the
 * interactive queue never drains to it). Register it via
 * `PluginManager.registerNotifier` (see app/plugins.ts) or the ready-made
 * {@link emailNotifierPlugin}.
 */

import type { PluginInitFn } from "../plugins";
import type {
  ChannelDestination,
  FormattingDialect,
  Notifier,
  NotifierCapabilities,
} from "./notifiers";

/** A single outbound email, handed to a {@link EmailTransport}. */
export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  body: string;
  /** MIME content type, derived from the notifier's declared dialect. */
  contentType: "text/plain" | "text/html";
}

/** Delivers one email. Inject a custom one (tests, an SMTP pool) or fall back to
 *  the built-in HTTP-API transport. */
export type EmailTransport = (mail: EmailMessage) => Promise<void>;

export interface EmailNotifierConfig {
  /** Envelope sender. Default: `EMAIL_FROM` env. */
  from?: string;
  /** Default recipient when a destination carries none. Default: `EMAIL_TO` env. */
  to?: string;
  /** Subject line for every notification. Default: `"errandd notification"`. */
  subject?: string;
  /** Body dialect: `plain` → text/plain, `html` → text/html. Default `plain`. */
  dialect?: "plain" | "html";
  /** Upper bound on a single message body. Default 5,000,000 (effectively
   *  unbounded for notifications; overridable to exercise dispatch splitting). */
  maxMessageLength?: number;
  /** HTTP JSON email API endpoint for the default transport. Default:
   *  `EMAIL_API_URL` env. */
  apiUrl?: string;
  /** Bearer token for the default transport. Default: `EMAIL_API_KEY` env. */
  apiKey?: string;
  /** Override the transport entirely (bypasses `apiUrl`/`apiKey`). */
  transport?: EmailTransport;
}

interface ResolvedEmailConfig {
  from: string;
  to: string;
  subject: string;
  dialect: "plain" | "html";
  maxMessageLength: number;
  apiUrl: string;
  apiKey: string;
  transport: EmailTransport;
}

/** The default transport: POST the message as JSON to a configured HTTP email
 *  API (`{ from, to, subject, text|html }`, Bearer-authed). Throws a clear
 *  config error when no endpoint is set — the notifier is registered but a send
 *  without configuration fails loudly rather than silently dropping mail. */
function httpApiTransport(apiUrl: string, apiKey: string): EmailTransport {
  return async (mail: EmailMessage): Promise<void> => {
    if (!apiUrl) {
      throw new Error(
        "email notifier: no transport configured (set apiUrl / EMAIL_API_URL, or inject a transport)",
      );
    }
    const bodyField = mail.contentType === "text/html" ? "html" : "text";
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        from: mail.from,
        to: mail.to,
        subject: mail.subject,
        [bodyField]: mail.body,
      }),
    });
    if (!res.ok) {
      throw new Error(`email notifier: transport returned ${res.status} ${res.statusText}`);
    }
  };
}

function resolveConfig(config: EmailNotifierConfig): ResolvedEmailConfig {
  const apiUrl = config.apiUrl ?? process.env.EMAIL_API_URL ?? "";
  const apiKey = config.apiKey ?? process.env.EMAIL_API_KEY ?? "";
  return {
    from: config.from ?? process.env.EMAIL_FROM ?? "errandd@localhost",
    to: config.to ?? process.env.EMAIL_TO ?? "",
    subject: config.subject ?? "errandd notification",
    dialect: config.dialect ?? "plain",
    maxMessageLength: config.maxMessageLength ?? 5_000_000,
    apiUrl,
    apiKey,
    transport: config.transport ?? httpApiTransport(apiUrl, apiKey),
  };
}

/**
 * Build the email {@link Notifier}. Its destination reading is permissive: the
 * recipient is `dest.userId` (a mailbox), else `dest.channelId`, else the
 * configured default `to`. It has no thread concept and cannot carry an
 * interactive reply.
 */
export function createEmailNotifier(config: EmailNotifierConfig = {}): Notifier {
  const c = resolveConfig(config);
  const dialect: FormattingDialect = c.dialect === "html" ? "html" : "plain";
  const capabilities: NotifierCapabilities = {
    threading: false,
    formattingDialect: dialect,
    maxMessageLength: c.maxMessageLength,
    interactiveReply: false,
  };
  return {
    id: "email",
    capabilities,
    async send(dest: ChannelDestination, msg: string): Promise<void> {
      const to = dest.userId || dest.channelId || c.to;
      if (!to) {
        throw new Error("email notifier: no recipient (destination carries none and no default `to`)");
      }
      await c.transport({
        from: c.from,
        to,
        subject: c.subject,
        body: msg,
        contentType: c.dialect === "html" ? "text/html" : "text/plain",
      });
    },
  };
}

/**
 * Ready-made plugin init that registers the default email notifier. Wire it via
 * settings.json `plugins` like any daemon plugin, or call it with a `PluginApi`
 * directly. Exists to prove `registerNotifier` end-to-end.
 */
export const emailNotifierPlugin: PluginInitFn = (api) => {
  api.registerNotifier(createEmailNotifier());
};
