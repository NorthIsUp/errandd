import { Bot, User } from "lucide-react";
import { Message, MessageContent } from "../prompt-kit/message";
import { cn } from "../ui/utils";

/**
 * A prose turn (`text` part). User turns sit right-aligned in a chip; assistant
 * turns render full-width markdown (code blocks via the `Markdown` → `CodeBlock`
 * path). `id` is passed to `Markdown` so streaming block-splitting keys line up.
 */
export function TextPart({
  id,
  role,
  markdown,
}: {
  id: string;
  role: "user" | "assistant";
  markdown: string;
}) {
  const isUser = role === "user";

  return (
    <Message className={cn(isUser && "flex-row-reverse")}>
      <div
        className={cn(
          "mt-1 flex size-7 shrink-0 items-center justify-center rounded-full",
          isUser ? "bg-primary/15 text-primary" : "bg-base-300 text-base-content/70",
        )}
        aria-hidden
      >
        {isUser ? <User className="size-4" /> : <Bot className="size-4" />}
      </div>

      <MessageContent
        id={id}
        markdown
        className={cn(
          "max-w-[80ch] min-w-0 bg-transparent p-0 text-base-content",
          isUser && "rounded-2xl bg-base-200 px-3 py-2 prose-p:my-0",
        )}
      >
        {markdown}
      </MessageContent>
    </Message>
  );
}
