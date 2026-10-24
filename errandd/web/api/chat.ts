import { apiFetch, apiJSON } from "./client";

/**
 * Reset the daemon's "chat" agent session so the next chat starts fresh.
 */
export function resetChatSession(): Promise<{ ok: true }> {
  return apiJSON<{ ok: true }>("/api/chat/reset", { method: "POST" });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatAttachment {
  name: string;
  type: string;
  /** base64-encoded file content */
  data: string;
}

export interface StreamChatOptions {
  /** The user's message text. */
  message: string;
  /** Session ID to attach the message to (optional). */
  sessionId?: string;
  /** File attachments (max 5, each ≤10 MB). */
  attachments?: ChatAttachment[];
  /** AbortSignal to cancel the stream. */
  signal?: AbortSignal;
}

export interface StreamChatCallbacks {
  /** Called for each text chunk as it arrives. */
  onChunk: (text: string) => void;
  /**
   * Called when the server sends "unblock" — the daemon has dispatched the
   * agent into the background.  The user can type again but the response is
   * still streaming.
   */
  onUnblock?: () => void;
  /** Called when a sub-agent is spawned. */
  onAgentSpawn?: (id: string, description: string) => void;
  /** Called when a sub-agent finishes. */
  onAgentDone?: (id: string, description: string, result?: string) => void;
  /** Called when the stream ends successfully. */
  onDone: () => void;
  /** Called on network errors or when the server sends an error event. */
  onError: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// SSE event shapes coming from the server
// ---------------------------------------------------------------------------

type SseEvent =
  | { type: "TEXT_MESSAGE_CONTENT"; delta: string }
  | { type: "CUSTOM"; name: string; value: { id: string; description: string; result?: string } }
  | { type: "RUN_FINISHED" }
  | { type: "RUN_ERROR"; message: string };

// ---------------------------------------------------------------------------
// Stream implementation
//
// Protocol: POST /api/chat returns Content-Type: text/event-stream
// with SSE lines of the form "data: <JSON>\n\n".
// The client reads the raw byte stream via response.body.getReader() and
// splits on newlines (matching the existing script.ts implementation exactly).
// ---------------------------------------------------------------------------

export async function streamChat(
  opts: StreamChatOptions,
  callbacks: StreamChatCallbacks,
): Promise<void> {
  const { message, sessionId, attachments = [], signal } = opts;
  const { onChunk, onUnblock, onAgentSpawn, onAgentDone, onDone, onError } = callbacks;

  let res: Response;
  try {
    const fetchInit: RequestInit = {
      method: "POST",
      body: JSON.stringify({
        threadId: sessionId || "chat",
        runId: crypto.randomUUID(),
        messages: [{ id: crypto.randomUUID(), role: "user", content: message }],
        attachments: attachments.length > 0 ? attachments : undefined,
        sessionId: sessionId || undefined,
      }),
    };
    if (signal != null) fetchInit.signal = signal;
    res = await apiFetch("/api/chat", fetchInit);
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      // ignore parse error
    }
    onError(new Error(msg));
    return;
  }

  if (!res.body) {
    onError(new Error("No response body"));
    return;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let ev: SseEvent;
        try {
          ev = JSON.parse(line.slice(6)) as SseEvent;
        } catch {
          continue;
        }

        switch (ev.type) {
          case "TEXT_MESSAGE_CONTENT":
            onChunk(ev.delta);
            break;
          case "CUSTOM":
            if (ev.name === "errandd.unblock") onUnblock?.();
            else if (ev.name === "errandd.agent_spawn")
              onAgentSpawn?.(ev.value.id, ev.value.description);
            else if (ev.name === "errandd.agent_done")
              onAgentDone?.(ev.value.id, ev.value.description, ev.value.result);
            break;
          case "RUN_FINISHED":
            onDone();
            return;
          case "RUN_ERROR":
            onError(new Error(ev.message));
            return;
        }
      }
    }
    onError(new Error("Chat stream ended before RUN_FINISHED"));
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      // Caller cancelled — surface as a plain done so the UI can finalise.
      onDone();
    } else {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
