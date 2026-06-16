import { useCallback, useEffect, useState } from "react";
import { resetChatSession, streamChat } from "../api/chat";
import {
  getSessionMessages,
  listSessions,
  type ChatMessage,
  type SessionInfo,
} from "../api/sessions";

export interface UseChatSessionsResult {
  sessions: SessionInfo[];
  loading: boolean;
  draft: string;
  setDraft: (v: string) => void;
  sending: boolean;
  reload: () => Promise<void>;
  /** Start a fresh chat. Returns the new session id (or null if creation failed). */
  send: () => Promise<string | null>;
}

/** Headless hook for the chat-list view: load web sessions, send a new chat. */
export function useChatSessions(): UseChatSessionsResult {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const reload = useCallback(async () => {
    try {
      const list = await listSessions(false);
      setSessions(list.filter((s) => s.channel === "web"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const send = useCallback(async (): Promise<string | null> => {
    const message = draft.trim();
    if (!message || sending) return null;
    setSending(true);
    try {
      await resetChatSession();
    } catch {
      // Non-fatal — fall through and send anyway.
    }
    await new Promise<void>((resolve) => {
      streamChat(
        { message },
        {
          onChunk: () => {},
          onUnblock: () => {},
          onDone: () => resolve(),
          onError: () => resolve(),
        },
      );
      setTimeout(resolve, 800);
    });
    const list = await listSessions(false);
    const web = list.filter((s) => s.channel === "web");
    setSessions(web);
    const newest = web[0]?.id ?? null;
    setDraft("");
    setSending(false);
    if (!newest) {
      void reload();
    }
    return newest;
  }, [draft, sending, reload]);

  return { sessions, loading, draft, setDraft, sending, reload, send };
}

export interface UseChatViewResult {
  messages: ChatMessage[];
  loading: boolean;
  draft: string;
  setDraft: (v: string) => void;
  sending: boolean;
  streamingText: string;
  reload: () => Promise<void>;
  send: () => Promise<void>;
}

/** Headless hook for a single chat view: load + stream messages. */
export function useChatView(sessionId: string): UseChatViewResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState("");

  const reload = useCallback(async () => {
    try {
      const res = await getSessionMessages(sessionId, 50, 0);
      setMessages(res.messages);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const send = useCallback(async () => {
    const message = draft.trim();
    if (!message || sending) return;
    setSending(true);
    setDraft("");
    setMessages((prev) => [
      ...prev,
      { role: "user", text: message, timestamp: new Date().toISOString() },
    ]);
    setStreamingText("");
    let acc = "";
    await new Promise<void>((resolve) => {
      streamChat(
        { message, sessionId },
        {
          onChunk: (text) => {
            acc += text;
            setStreamingText(acc);
          },
          onDone: () => resolve(),
          onError: () => resolve(),
        },
      );
    });
    setStreamingText("");
    setSending(false);
    void reload();
  }, [draft, sending, sessionId, reload]);

  return {
    messages,
    loading,
    draft,
    setDraft,
    sending,
    streamingText,
    reload,
    send,
  };
}
