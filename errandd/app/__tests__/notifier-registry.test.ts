// Existence proof for the outbound NOTIFIER registry (overhaul 3/6).
//
// Proves, end-to-end:
//   1. the Map registry + capability-respecting dispatch (split at
//      maxMessageLength, no silent truncation);
//   2. ChannelDestination is all-string — the telegram adapter, and only it,
//      coerces chat/thread ids to numbers;
//   3. the three chat adapters wrap the bots' send fns with honest capabilities;
//   4. PluginManager.registerNotifier routes a plugin notifier into the shared
//      registry (both via a PluginApi stub and a real loadAll of a temp plugin);
//   5. the email notifier — the plugin-tier existence proof — sends through an
//      injected transport and its capabilities are respected by dispatch.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDiscordNotifier,
  createSlackNotifier,
  createTelegramNotifier,
  DISCORD_CAPABILITIES,
  SLACK_CAPABILITIES,
  TELEGRAM_CAPABILITIES,
} from "../messaging/channelNotifiers";
import { createEmailNotifier, type EmailMessage, emailNotifierPlugin } from "../messaging/email";
import {
  __resetNotifiersForTests,
  type ChannelDestination,
  dispatchNotify,
  getNotifier,
  hasNotifier,
  type Notifier,
  notify,
  registeredNotifierIds,
  registerNotifier,
  splitForLength,
  unregisterNotifier,
} from "../messaging/notifiers";
import { PluginManager } from "../plugins";
import type { PluginApi } from "../plugins";

afterEach(() => {
  __resetNotifiersForTests();
});

/** A capturing notifier: records every (dest, msg) it is sent. */
function makeCapture(id: string, maxMessageLength = 1000): {
  notifier: Notifier;
  sent: { dest: ChannelDestination; msg: string }[];
} {
  const sent: { dest: ChannelDestination; msg: string }[] = [];
  const notifier: Notifier = {
    id,
    capabilities: {
      threading: false,
      formattingDialect: "plain",
      maxMessageLength,
      interactiveReply: false,
    },
    async send(dest, msg) {
      sent.push({ dest, msg });
    },
  };
  return { notifier, sent };
}

describe("notifier registry", () => {
  test("register / get / has / ids / unregister (case-insensitive)", () => {
    const { notifier } = makeCapture("Email");
    registerNotifier(notifier);
    expect(hasNotifier("email")).toBe(true);
    expect(hasNotifier("EMAIL")).toBe(true);
    expect(getNotifier("email")).toBe(notifier);
    expect(registeredNotifierIds()).toContain("email");
    expect(unregisterNotifier("email")).toBe(true);
    expect(hasNotifier("email")).toBe(false);
    expect(unregisterNotifier("email")).toBe(false);
  });

  test("re-register overrides the prior notifier for an id", () => {
    const a = makeCapture("x");
    const b = makeCapture("x");
    registerNotifier(a.notifier);
    registerNotifier(b.notifier);
    expect(getNotifier("x")).toBe(b.notifier);
  });

  test("notify() returns false for an unknown/historical platform id (never throws)", async () => {
    expect(await notify("does-not-exist", { channelId: "c" }, "hi")).toBe(false);
  });
});

describe("splitForLength / capability-respecting dispatch", () => {
  test("no split when under the limit; empty text ⇒ no chunks", () => {
    expect(splitForLength("hello", 100)).toEqual(["hello"]);
    expect(splitForLength("", 100)).toEqual([]);
  });

  test("splits past the limit preferring a whitespace boundary; no truncation", () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const chunks = splitForLength(words, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(50);
    }
    // Rejoining with a single space restores the original (breaks fall on spaces).
    expect(chunks.join(" ")).toBe(words);
  });

  test("hard-splits when there is no whitespace boundary", () => {
    const solid = "x".repeat(120);
    const chunks = splitForLength(solid, 50);
    expect(chunks).toEqual(["x".repeat(50), "x".repeat(50), "x".repeat(20)]);
  });

  test("dispatchNotify splits a long message into maxMessageLength-bounded sends", async () => {
    const { notifier, sent } = makeCapture("cap", 10);
    await dispatchNotify(notifier, { channelId: "c" }, "abcdefghijklmnopqrstuvwxyz");
    expect(sent.length).toBeGreaterThan(1);
    for (const s of sent) {
      expect(s.msg.length).toBeLessThanOrEqual(10);
    }
    expect(sent.map((s) => s.msg).join("")).toBe("abcdefghijklmnopqrstuvwxyz");
  });

  test("dispatchNotify sends a single message under the limit unchanged", async () => {
    const { notifier, sent } = makeCapture("cap", 1000);
    await dispatchNotify(notifier, { channelId: "c", threadId: "t" }, "short");
    expect(sent).toEqual([{ dest: { channelId: "c", threadId: "t" }, msg: "short" }]);
  });
});

describe("chat channel adapters (thin wrappers over the bot send fns)", () => {
  test("telegram adapter coerces all-string chat/thread ids to numbers INSIDE the adapter", async () => {
    const calls: { chatId: number; text: string; threadId?: number }[] = [];
    const n = createTelegramNotifier(async (chatId, text, threadId) => {
      calls.push({ chatId, text, threadId });
    });
    expect(n.id).toBe("telegram");
    expect(n.capabilities).toEqual(TELEGRAM_CAPABILITIES);

    await n.send({ channelId: "12345", threadId: "67" }, "hi");
    expect(calls[0]).toEqual({ chatId: 12345, text: "hi", threadId: 67 });

    // A missing/non-finite thread id is dropped (channel root), not passed as NaN.
    calls.length = 0;
    await n.send({ channelId: "999" }, "no-thread");
    expect(calls[0]).toEqual({ chatId: 999, text: "no-thread", threadId: undefined });
  });

  test("discord adapter forwards the string channel id; slack forwards channel + thread", async () => {
    const dCalls: [string, string][] = [];
    const d = createDiscordNotifier(async (channelId, text) => {
      dCalls.push([channelId, text]);
    });
    expect(d.id).toBe("discord");
    expect(d.capabilities).toEqual(DISCORD_CAPABILITIES);
    await d.send({ channelId: "chan-1" }, "yo");
    expect(dCalls[0]).toEqual(["chan-1", "yo"]);

    const sCalls: [string, string, string | undefined][] = [];
    const s = createSlackNotifier(async (channelId, text, threadTs) => {
      sCalls.push([channelId, text, threadTs]);
    });
    expect(s.id).toBe("slack");
    expect(s.capabilities).toEqual(SLACK_CAPABILITIES);
    await s.send({ channelId: "C1", threadId: "1.234" }, "hey");
    expect(sCalls[0]).toEqual(["C1", "hey", "1.234"]);
  });
});

describe("email notifier — plugin-tier existence proof", () => {
  test("PluginManager-style registerNotifier routes email into the registry", () => {
    // A minimal PluginApi stub exercising only registerNotifier (mirrors the
    // source-registry test's stub approach).
    const api = { registerNotifier } as unknown as PluginApi;
    void emailNotifierPlugin(api);
    expect(getNotifier("email")?.id).toBe("email");
  });

  test("capability descriptor is honestly non-chat: no threading / reply, plain dialect, large max", () => {
    const n = createEmailNotifier();
    expect(n.capabilities.threading).toBe(false);
    expect(n.capabilities.interactiveReply).toBe(false);
    expect(n.capabilities.formattingDialect).toBe("plain");
    expect(n.capabilities.maxMessageLength).toBeGreaterThan(100000);
  });

  test("send() builds the mail through an injected transport; recipient precedence userId > channelId > to", async () => {
    const mails: EmailMessage[] = [];
    const n = createEmailNotifier({
      from: "bot@errandd.dev",
      to: "default@x.com",
      subject: "Alert",
      dialect: "html",
      transport: async (m) => {
        mails.push(m);
      },
    });
    await n.send({ channelId: "chan@x.com", userId: "user@x.com" }, "<b>hi</b>");
    expect(mails[0]).toEqual({
      from: "bot@errandd.dev",
      to: "user@x.com",
      subject: "Alert",
      body: "<b>hi</b>",
      contentType: "text/html",
    });
    // Falls back to channelId, then to the configured default.
    await n.send({ channelId: "chan@x.com" }, "x");
    expect(mails[1].to).toBe("chan@x.com");
    await n.send({ channelId: "" }, "x");
    expect(mails[2].to).toBe("default@x.com");
  });

  test("dispatch respects a small email maxMessageLength — splits, never truncates", async () => {
    const mails: EmailMessage[] = [];
    const n = createEmailNotifier({
      to: "a@b.com",
      maxMessageLength: 20,
      transport: async (m) => {
        mails.push(m);
      },
    });
    registerNotifier(n);
    const long = "y".repeat(55);
    expect(await notify("email", { channelId: "a@b.com" }, long)).toBe(true);
    expect(mails.length).toBe(3); // 20 + 20 + 15
    expect(mails.map((m) => m.body).join("")).toBe(long);
  });

  test("PluginManager.loadAll wires registerNotifier through the real plugin API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "errandd-notify-plugin-"));
    try {
      writeFileSync(
        join(dir, "index.js"),
        `export default function (api) {
          api.registerNotifier({
            id: "pager",
            capabilities: { threading: false, formattingDialect: "plain", maxMessageLength: 500, interactiveReply: false },
            send: async () => {},
          });
        }`,
      );
      const pm = new PluginManager(dir);
      await pm.loadAll({ pager: { enabled: true, source: dir, config: {} } });
      expect(hasNotifier("pager")).toBe(true);
      expect(getNotifier("pager")?.capabilities.maxMessageLength).toBe(500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
