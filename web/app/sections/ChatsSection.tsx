import {
 Badge,
 Button,
 Card,
 CardContent,
 CircularProgress,
 Input,
} from"@pikoloo/darwin-ui";
import { ArrowLeft, ChevronRight, Send } from"lucide-react";
import { useCallback, useEffect, useRef, useState } from"react";
import { resetChatSession, streamChat } from"../../api/chat";
import {
 getSessionMessages,
 listSessions,
 type ChatMessage,
 type SessionInfo,
} from"../../api/sessions";
import { useHash } from"../../hooks/useHash";

function fmtRelative(iso: string): string {
 const d = new Date(iso).getTime();
 const diff = Date.now() - d;
 const s = Math.floor(diff / 1000);
 if (s < 60) return `${s}s ago`;
 const m = Math.floor(s / 60);
 if (m < 60) return `${m}m ago`;
 const h = Math.floor(m / 60);
 if (h < 24) return `${h}h ago`;
 return `${Math.floor(h / 24)}d ago`;
}

export function ChatsSection() {
 const { params, setParam } = useHash();
 const sessionId = params.get("id");

 if (sessionId) {
 return (
 <ChatView
 sessionId={sessionId}
 onBack={() => setParam("id", null)}
 />
 );
 }
 return <ChatList onOpen={(id) => setParam("id", id)} />;
}

function ChatList({ onOpen }: { onOpen: (id: string) => void }) {
 const [sessions, setSessions] = useState<SessionInfo[]>([]);
 const [loading, setLoading] = useState(true);
 const [draft, setDraft] = useState("");
 const [sending, setSending] = useState(false);

 const reload = useCallback(async () => {
 try {
 const list = await listSessions(false);
 setSessions(list.filter((s) => s.channel ==="web"));
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
 // Force the daemon's chat agent to start a fresh session.
 try {
 await resetChatSession();
 } catch {
 // Non-fatal — fall through and send anyway.
 }
 let newId: string | null = null;
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
 const web = list.filter((s) => s.channel ==="web");
 newId = web[0]?.id ?? null;
 setDraft("");
 setSending(false);
 if (newId) onOpen(newId);
 else void reload();
 }, [draft, sending, onOpen, reload]);

 return (
 <div className="space-y-4 px-2 sm:px-0">
 <div className="flex gap-2 px-1">
 <Input
 size="lg"
 value={draft}
 onChange={(e) => setDraft(e.target.value)}
 onKeyDown={(e) => {
 if (e.key ==="Enter" && !e.shiftKey) {
 e.preventDefault();
 void handleSend();
 }
 }}
 placeholder="Start a new chat…"
 />
 <Button
 variant="primary"
 size="lg"
 onClick={() => void handleSend()}
 disabled={!draft.trim() || sending}
 loading={sending}
 leftIcon={<Send size={18} />}
 >
 <span className="hidden sm:inline">Send</span>
 </Button>
 </div>

 {loading ? (
 <div className="flex justify-center py-16">
 <CircularProgress indeterminate size={32} />
 </div>
 ) : sessions.length === 0 ? (
 <p className="text-center text-sm text-muted-foreground py-12">No chat sessions yet.</p>
 ) : (
 <div className="space-y-2">
 {sessions.map((s) => (
 <button
 key={s.id}
 type="button"
 className="w-full text-left"
 onClick={() => onOpen(s.id)}
 >
 <Card className="cursor-pointer transition-opacity hover:opacity-80">
 <CardContent className="py-3 flex items-center gap-3">
 <div className="flex-1 min-w-0">
 <div className="flex items-center gap-2 mb-1">
 <span className="font-medium truncate">
 {s.title || s.firstMessage ||"Untitled chat"}
 </span>
 {s.closed ? <Badge variant="secondary">closed</Badge> : null}
 </div>
 <div className="text-xs text-muted-foreground truncate">
 {s.lastMessage}
 </div>
 <div className="text-xs text-muted-foreground mt-1">
 {s.turnCount} turn{s.turnCount === 1 ?"" :"s"} · {fmtRelative(s.lastUsedAt)}
 </div>
 </div>
 <ChevronRight size={18} className="text-muted-foreground" />
 </CardContent>
 </Card>
 </button>
 ))}
 </div>
 )}
 </div>
 );
}

function ChatView({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
 const [messages, setMessages] = useState<ChatMessage[]>([]);
 const [loading, setLoading] = useState(true);
 const [draft, setDraft] = useState("");
 const [sending, setSending] = useState(false);
 const [streamingText, setStreamingText] = useState("");
 const scrollRef = useRef<HTMLDivElement>(null);

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

 useEffect(() => {
 scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
 }, [messages, streamingText]);

 const handleSend = useCallback(async () => {
 const message = draft.trim();
 if (!message || sending) return;
 setSending(true);
 setDraft("");
 setMessages((prev) => [
 ...prev,
 { role:"user", text: message, timestamp: new Date().toISOString() },
 ]);
 setStreamingText("");
 let acc ="";
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

 return (
 <div className="flex flex-col h-[calc(100vh-7rem)] sm:h-[calc(100vh-9rem)] px-2 sm:px-0">
 <div className="flex items-center gap-2 mb-3 px-1">
 <Button variant="ghost" size="sm" onClick={onBack} leftIcon={<ArrowLeft size={16} />}>
 Chats
 </Button>
 <span className="text-muted-foreground">/</span>
 <span className="text-sm font-medium truncate">
 {messages[0]?.text?.slice(0, 60) ||"Chat"}
 </span>
 </div>

 <div
 ref={scrollRef}
 className="flex-1 overflow-y-auto space-y-3 px-1 pb-3"
 >
 {loading ? (
 <div className="flex justify-center py-8">
 <CircularProgress indeterminate size={28} />
 </div>
 ) : messages.length === 0 && !streamingText ? (
 <p className="text-center text-sm text-muted-foreground py-12">No messages yet.</p>
 ) : (
 <>
 {messages.map((m, i) => (
 <MessageBubble key={`${m.timestamp}-${i}`} role={m.role} text={m.text} />
 ))}
 {streamingText ? <MessageBubble role="assistant" text={streamingText} /> : null}
 </>
 )}
 </div>

 <div className="pt-3 flex gap-2">
 <Input
 value={draft}
 onChange={(e) => setDraft(e.target.value)}
 onKeyDown={(e) => {
 if (e.key ==="Enter" && !e.shiftKey) {
 e.preventDefault();
 void handleSend();
 }
 }}
 placeholder="Reply…"
 />
 <Button
 variant="primary"
 onClick={() => void handleSend()}
 disabled={!draft.trim() || sending}
 loading={sending}
 leftIcon={<Send size={16} />}
 >
 <span className="hidden sm:inline">Send</span>
 </Button>
 </div>
 </div>
 );
}

function MessageBubble({ role, text }: { role:"user" |"assistant"; text: string }) {
 const isUser = role ==="user";
 return (
 <div className={isUser ?"flex justify-end" :"flex justify-start"}>
 <Card className="max-w-[85%]">
 <div className="px-3 py-2 text-sm whitespace-pre-wrap">
 {isUser ? <strong>{text}</strong> : text}
 </div>
 </Card>
 </div>
 );
}
