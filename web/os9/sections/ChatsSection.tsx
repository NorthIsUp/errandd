import { Button, ListView, TextField, Window } from "@liiift-studio/mac-os9-ui";
import { useCallback, useEffect, useState } from "react";
import { resetChatSession, streamChat } from "../../api/chat";
import {
  getSessionMessages,
  listSessions,
  type ChatMessage,
  type SessionInfo,
} from "../../api/sessions";
import { MessageBubble } from "../components/MessageBubble";
import { Os9Scroll } from "../components/Os9Scroll";
import { useOs9Hash } from "../useOs9Hash";

interface Props {
  maxHeight: number;
  /** When true, skip outer `<Window>` chrome and use local state for the
   *  session router (instead of writing to the URL hash, which conflicts with
   *  hosts like osish that own the hash). */
  bare?: boolean;
}

export function ChatsSection({ maxHeight, bare }: Props) {
  const hash = useOs9Hash();
  const [localId, setLocalId] = useState<string | null>(null);
  const sessionId = bare ? localId : hash.params.get("id");
  const setSession = (id: string | null) =>
    bare ? setLocalId(id) : hash.setParam("id", id);
  if (sessionId) {
    return (
      <ChatView
        sessionId={sessionId}
        maxHeight={maxHeight}
        onBack={() => setSession(null)}
        bare={bare ?? false}
      />
    );
  }
  return (
    <ChatList
      maxHeight={maxHeight}
      onOpen={(id) => setSession(id)}
      bare={bare ?? false}
    />
  );
}

function ChatList({
  maxHeight,
  onOpen,
  bare,
}: {
  maxHeight: number;
  onOpen: (id: string) => void;
  bare?: boolean;
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);

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

  const handleSend = useCallback(async () => {
    const message = draft.trim();
    if (!message || sending) return;
    setSending(true);
    try {
      await resetChatSession();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      streamChat(
        { message },
        {
          onChunk: () => {},
          onDone: () => resolve(),
          onError: () => resolve(),
        },
      );
      setTimeout(resolve, 800);
    });
    const list = await listSessions(false);
    const web = list.filter((s) => s.channel === "web");
    const newest = web[0]?.id;
    setDraft("");
    setSending(false);
    if (newest) onOpen(newest);
    else void reload();
  }, [draft, sending, onOpen, reload]);

  const innerMax = Math.max(200, maxHeight - 36);

  const body = (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: 8,
          maxHeight: innerMax,
        }}
      >
        <fieldset style={{ padding: 8, flexShrink: 0 }}>
          <legend>New chat</legend>
          <div style={{ display: "flex", gap: 6 }}>
            <div style={{ flex: 1 }}>
              <TextField
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Type a message…"
                fullWidth
              />
            </div>
            <Button
              variant="primary"
              onClick={() => void handleSend()}
              disabled={!draft.trim() || sending}
              loading={sending}
            >
              Send
            </Button>
          </div>
        </fieldset>

        <fieldset
          style={{
            padding: 8,
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <legend>Sessions</legend>
          {loading ? (
            <p>Loading…</p>
          ) : sessions.length === 0 ? (
            <p style={{ color: "#555", padding: 8 }}>No chat sessions yet.</p>
          ) : (
            <Os9Scroll style={{ flex: 1, minHeight: 0 }}>
              <ListView
                columns={[
                  { key: "title", label: "Title", width: "55%" },
                  { key: "turns", label: "Turns", width: "15%" },
                  { key: "lastUsed", label: "Last used", width: "30%" },
                ]}
                items={sessions.map((s) => ({
                  id: s.id,
                  title: s.title || s.firstMessage || "Untitled",
                  turns: String(s.turnCount),
                  lastUsed: new Date(s.lastUsedAt).toLocaleString(),
                }))}
                onItemOpen={(item) => onOpen(String(item.id))}
              />
            </Os9Scroll>
          )}
        </fieldset>
      </div>
  );
  return bare ? body : <Window title="Chats">{body}</Window>;
}

function ChatView({
  sessionId,
  maxHeight,
  onBack,
  bare,
}: {
  sessionId: string;
  maxHeight: number;
  onBack: () => void;
  bare?: boolean;
}) {
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

  const handleSend = useCallback(async () => {
    const message = draft.trim();
    if (!message || sending) return;
    setSending(true);
    setDraft("");
    setMessages((prev) => [
      ...prev,
      { role: "user", text: message, timestamp: new Date().toISOString() },
    ]);
    let acc = "";
    setStreamingText("");
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

  const innerMax = Math.max(200, maxHeight - 36);

  const body = (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: 8,
          height: innerMax,
        }}
      >
        <div style={{ flexShrink: 0 }}>
          <Button onClick={onBack}>‹ Back to sessions</Button>
        </div>
        <Os9Scroll style={{ flex: 1, minHeight: 0 }}>
          <div
            style={{
              padding: 8,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {loading ? (
              <p>Loading…</p>
            ) : messages.length === 0 && !streamingText ? (
              <p style={{ color: "#555" }}>No messages yet.</p>
            ) : (
              <>
                {messages.map((m, i) => (
                  <MessageBubble
                    key={`${m.timestamp}-${i}`}
                    role={m.role}
                    text={m.text}
                  />
                ))}
                {streamingText ? (
                  <MessageBubble role="assistant" text={streamingText} />
                ) : null}
              </>
            )}
          </div>
        </Os9Scroll>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <div style={{ flex: 1 }}>
            <TextField
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Reply…"
              fullWidth
            />
          </div>
          <Button
            variant="primary"
            onClick={() => void handleSend()}
            disabled={!draft.trim() || sending}
            loading={sending}
          >
            Send
          </Button>
        </div>
      </div>
  );
  return bare ? body : <Window title="Chats / Messages">{body}</Window>;
}
