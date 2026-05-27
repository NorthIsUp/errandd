/**
 * Tiny chat-bubble box used by both the Chats view and the routine run
 * viewer (since both display a user-prompt / assistant-response exchange).
 * The library doesn't ship a chat bubble, so this is a small styled div.
 */
export function MessageBubble({
  role,
  text,
}: {
  role: "user" | "assistant";
  text: string;
}) {
  const isUser = role === "user";
  return (
    <div
      style={{
        alignSelf: isUser ? "flex-end" : "flex-start",
        maxWidth: "85%",
        padding: "6px 10px",
        border: "1px solid #888",
        background: isUser ? "#cce0ff" : "#f0f0f0",
        whiteSpace: "pre-wrap",
        fontSize: 12,
      }}
    >
      {text}
    </div>
  );
}
