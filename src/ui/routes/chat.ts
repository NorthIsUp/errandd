import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { runUserMessage } from "../../runner";
import { resetSession } from "../../sessions";
import { json } from "../http";
import { getSessionEffort, getSessionGoal, getSessionModel } from "../services/session-meta";
import type { RouteHandler } from "./types";

/** POST /api/inject — run a one-shot message and (optionally) echo to Telegram. */
export const inject: RouteHandler = async ({ req, opts }) => {
  try {
    const body = await req.json();
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return json({ ok: false, error: "message is required" }, 400);
    }
    const result = await runUserMessage("inject", message);
    const text = result.stdout.trim();
    const { telegram } = opts.getSnapshot().settings;
    if (text && telegram.token && telegram.allowedUserIds.length > 0) {
      const chatId = telegram.allowedUserIds[0];
      fetch(`https://api.telegram.org/bot${telegram.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      }).catch(() => {});
    }
    return json({ ok: true, result: result.stdout, exitCode: result.exitCode });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
};

/** POST /api/chat/reset — reset the chat session. */
export const chatReset: RouteHandler = async () => {
  try {
    await resetSession("chat");
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
};

/**
 * POST /api/chat — streamed chat. Kept verbatim as its own ReadableStream
 * rather than routed onto the shared sseResponse() helper: this stream is
 * finite (it closes the controller after `done`) and emits no 25s ping
 * heartbeat, whereas sseResponse() owns a heartbeat and only closes on
 * client abort. Folding it in would alter the wire output (extra ping
 * frames) and lifecycle — a behavior change this refactor must not make.
 */
export const chat: RouteHandler = async ({ req, opts }) => {
  if (!opts.onChat) {
    return json({ ok: false, error: "chat not configured" }, 503);
  }
  try {
    const body = await req.json();
    const message = String(body?.message ?? "").trim();

    interface Attachment {
      name: string;
      type: string;
      data: string; // base64
    }

    const rawAttachments = Array.isArray(body?.attachments) ? (body.attachments as unknown[]) : [];

    // Validate attachments
    if (rawAttachments.length > 5) {
      return json({ ok: false, error: "too many attachments (max 5)" }, 400);
    }

    const attachments: Attachment[] = [];
    for (const raw of rawAttachments) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const att = raw as Record<string, unknown>;
      const name = String(att.name ?? "");
      const type = String(att.type ?? "");
      const data = String(att.data ?? "");
      // base64 decoded size approximation
      const decodedSize = data.length * 0.75;
      if (decodedSize > 10 * 1024 * 1024) {
        return json({ ok: false, error: `attachment "${name}" exceeds 10 MB limit` }, 400);
      }
      attachments.push({ name, type, data });
    }

    if (!message && attachments.length === 0) {
      return json({ ok: false, error: "message required" }, 400);
    }

    const TEXT_EXTENSIONS = new Set([
      "js",
      "ts",
      "py",
      "json",
      "yaml",
      "yml",
      "md",
      "txt",
      "csv",
      "xml",
      "sh",
      "sql",
      "toml",
      "ini",
      "env",
      "log",
    ]);

    const tempImagePaths: string[] = [];
    const attachmentBlocks: string[] = [];

    for (const att of attachments) {
      const ext = att.name.includes(".") ? (att.name.split(".").pop()?.toLowerCase() ?? "") : "";
      if (att.type.startsWith("text/") || TEXT_EXTENSIONS.has(ext)) {
        const content = Buffer.from(att.data, "base64").toString("utf-8");
        attachmentBlocks.push(`[Attached file: ${att.name}]\n\`\`\`${ext}\n${content}\n\`\`\``);
      } else if (att.type.startsWith("image/")) {
        const uploadDir = `${tmpdir()}/clawdcode-uploads`;
        await import("node:fs/promises")
          .then(({ mkdir }) => mkdir(uploadDir, { recursive: true }))
          .catch(() => {});
        const filePath = `${uploadDir}/${randomUUID()}.${ext || "bin"}`;
        const buffer = Buffer.from(att.data, "base64");
        await Bun.write(filePath, buffer);
        tempImagePaths.push(filePath);
        attachmentBlocks.push(
          `[Attached image: ${att.name} — file saved at ${filePath}, you can read it with your Read tool]`,
        );
      } else {
        attachmentBlocks.push(
          `[Attached file: ${att.name} — unsupported type, content not included]`,
        );
      }
    }

    // Prepend session goal if present; also fetch model/effort overrides
    const chatSessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
    let baseMessage =
      attachmentBlocks.length > 0
        ? attachmentBlocks.join("\n\n") + (message ? `\n\n${message}` : "")
        : message;
    let chatModelOverride = "";
    let chatEffortOverride = "";
    if (chatSessionId) {
      const [sessionGoal, sessionModel, sessionEffort] = await Promise.all([
        getSessionGoal(chatSessionId),
        getSessionModel(chatSessionId),
        getSessionEffort(chatSessionId),
      ]);
      if (sessionGoal) {
        baseMessage = `Goal: ${sessionGoal}\n\n${baseMessage}`;
      }
      chatModelOverride = sessionModel;
      chatEffortOverride = sessionEffort;
    }
    const enrichedMessage = baseMessage;

    const encoder = new TextEncoder();
    const onChat = opts.onChat;
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: object) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };
        try {
          await onChat(
            enrichedMessage,
            (chunk) => send({ type: "chunk", text: chunk }),
            () => send({ type: "unblock" }),
            (ev) =>
              send({
                type: ev.type === "spawn" ? "agent_spawn" : "agent_done",
                id: ev.id,
                description: ev.description,
                result: ev.result,
              }),
            {
              modelOverride: chatModelOverride || undefined,
              effortOverride: chatEffortOverride || undefined,
            },
          );
          send({ type: "done" });
        } catch (err) {
          send({ type: "error", message: String(err) });
        } finally {
          controller.close();
          // Fire-and-forget cleanup of temp image files
          for (const p of tempImagePaths) {
            Bun.file(p)
              .exists()
              .then((exists) => {
                if (exists) {
                  import("node:fs").then(({ unlink }) => unlink(p, () => {})).catch(() => {});
                }
              })
              .catch(() => {});
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
};

/** GET /api/slash — slash autocomplete registry. */
export const slash: RouteHandler = async () => {
  try {
    const { listAllSlashEntries } = await import("../../slashRegistry");
    return json(await listAllSlashEntries());
  } catch (err) {
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 500);
  }
};
