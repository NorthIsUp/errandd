import { Bot, User } from "lucide-react";
import { hookOrigin } from "../../../../shared/hookOrigin";
import { MessageSender } from "../../../chat/MessageSender";
import { CopyButton } from "../../../components/CopyButton";
import { webhookDisplayMarkdown } from "../../../../shared/webhookDisplay";
import { routineDocument } from "../../../../shared/routineDocument";
import { RoutineDocument } from "../../../components/RoutineDocument";
import { Markdown } from "../prompt-kit/markdown";
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
  const origin = isUser ? hookOrigin(markdown) : null;
  const document = isUser ? routineDocument(markdown) : null;
  if (document) return (
    <div className="flex min-w-0 flex-col gap-4">
      <TextPart id={`${id}-event`} role={role} markdown={document.context} />
      <RoutineDocument title={document.title} markdown={document.body}>
        <Markdown id={`${id}-instructions`}>{document.content}</Markdown>
      </RoutineDocument>
    </div>
  );

  if (origin) {
    const body = webhookDisplayMarkdown(markdown).replace(/^\s*##\s*Incoming hooks?[^\n]*(?:\n|$)/i, "").trimStart()
      .replace(/^(?:action:\s*[^\n]*?\s*·\s*)?author:\s*[^\s\n]+[ \t]*(?:\r?\n|$)/i, "").trimStart();
    return <section className="v3-hook-message" aria-label="Incoming hook message">
      <MessageSender origin={origin} />
      <div className="v3-hook-body"><CopyButton text={webhookDisplayMarkdown(markdown)} label="hook message" /><Markdown id={id}>{body}</Markdown></div>
    </section>;
  }

  return (
    <Message className={cn(isUser && "flex-row-reverse")}>
      <Avatar isUser={isUser} />

      <MessageContent
        id={id}
        markdown
        className={cn(
          "max-w-[80ch] min-w-0 bg-transparent p-0 text-base-content",
          isUser && "rounded-2xl bg-base-200 px-3 py-2 prose-p:my-0",
        )}
      >
        {isUser ? webhookDisplayMarkdown(markdown) : markdown}
      </MessageContent>
    </Message>
  );
}

function Avatar({ isUser }: { isUser: boolean }) {
  return <div className={cn("mt-1 flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full", isUser ? "bg-primary/15 text-primary" : "bg-base-300 text-base-content/70")} aria-hidden="true">
    {isUser ? <User className="size-4" /> : <Bot className="size-4" />}
  </div>;
}
