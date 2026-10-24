import { randomUUID } from "node:crypto";
import { getRuntime } from "../../runtime/select";
import type { RuntimeSubprocess } from "../../runtime/types";
import { createAguiAdapter, extractConversationPrompt } from "../agui";
import { json } from "../http";
import type { RouteHandler } from "./types";

/**
 * POST /api/agui — run the selected coding-agent runtime and stream the turn as
 * AG-UI (https://ag-ui.com) events over SSE.
 *
 * Body: an AG-UI RunAgentInput ({ threadId?, runId?, messages: [...] }) or a
 * plain { prompt }. Emits RUN_STARTED → (TEXT_MESSAGE_* / TOOL_CALL_*) →
 * RUN_FINISHED, or RUN_ERROR on failure.
 *
 * Runtime-agnostic: it taps the normalized RuntimeStreamHandlers seam, so it
 * works identically whether ERRANDD_RUNTIME is claude or pi — the same code
 * path both are already tested against.
 *
 * Owns its ReadableStream (not the shared sseResponse helper) so the stream is
 * finite — it closes after RUN_FINISHED and emits none of sseResponse's 25s
 * `ping` frames, which would pollute a strict AG-UI event stream.
 */
export const aguiRun: RouteHandler = async ({ req, opts }) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const prompt = extractConversationPrompt(body);
  if (!prompt) {
    return json(
      { ok: false, error: "no prompt: send { prompt } or AG-UI { messages: [...] }" },
      400,
    );
  }

  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const threadId = typeof b.threadId === "string" && b.threadId ? b.threadId : randomUUID();
  const runId = typeof b.runId === "string" && b.runId ? b.runId : randomUUID();

  if (req.signal.aborted) return new Response(null, { status: 499 });
  const encoder = new TextEncoder();
  let proc: RuntimeSubprocess | null = null;
  let closed = false;
  const stopProcess = () => {
    try { proc?.kill(); } catch { /* best-effort */ }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      send({ type: "RUN_STARTED", threadId, runId });
      try {
        const rt = getRuntime();
        const s = opts.getSnapshot().settings;
        const args = rt.buildRunArgs({
          prompt,
          outputMode: "stream",
          model: s.model,
          security: s.security,
          jobsRepoArgs: [],
        });
        const env = rt.buildChildEnv(rt.cleanSpawnEnv(), s.model, s.api);
        proc = rt.spawn(args, env);
        req.signal.addEventListener("abort", stopProcess, { once: true });
        if (req.signal.aborted) stopProcess();

        // Drain stderr concurrently: a full pipe can otherwise deadlock the
        // child before stdout closes. Keep only a bounded diagnostic tail.
        const stderr = (async () => {
          const reader = proc.stderr.getReader();
          const decoder = new TextDecoder();
          let text = "";
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) return text + decoder.decode();
              text = (text + decoder.decode(value, { stream: true })).slice(-8192);
            }
          } finally {
            reader.releaseLock();
          }
        })();
        const adapter = createAguiAdapter(send);
        try {
          const [, exitCode, diagnostic] = await Promise.all([
            rt.parseStream(proc.stdout, adapter.handlers),
            proc.exited,
            stderr,
          ]);
          if (exitCode !== 0)
            throw new Error(diagnostic.trim() || `Agent exited with code ${exitCode}`);
        } catch (err) {
          proc.kill();
          await stderr.catch(() => {});
          throw err;
        }

        send({ type: "RUN_FINISHED", threadId, runId, result: adapter.resultText() });
      } catch (err) {
        send({ type: "RUN_ERROR", message: err instanceof Error ? err.message : String(err) });
      } finally {
        req.signal.removeEventListener("abort", stopProcess);
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      closed = true;
      stopProcess();
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
};
