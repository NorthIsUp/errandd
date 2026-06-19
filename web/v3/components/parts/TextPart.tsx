import { Bot, Github, User } from "lucide-react";
import { useState } from "react";
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
  // A hook-trigger turn ("## Incoming hook · github issue_comment … author: X")
  // is a "user" message, but its real author is the GitHub actor — show THEIR
  // avatar (a human commenter), or the GitHub mark for a bot / system action.
  const hookActor = isUser ? parseHookActor(markdown) : null;

  return (
    <Message className={cn(isUser && "flex-row-reverse")}>
      <Avatar isUser={isUser} hookActor={hookActor} />

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

interface HookActor { login: string; human: boolean }

/** Pull the GitHub actor out of a hook-trigger block. Returns null when the
 *  text isn't a hook trigger (a normal user/assistant message). */
function parseHookActor(markdown: string): HookActor | null {
  if (!/^##\s*Incoming hooks?\b/.test(markdown.trimStart())) {
    return null;
  }
  const m = /\bauthor:\s*([^\s·\n]+)/i.exec(markdown);
  const login = m?.[1]?.trim() ?? "";
  if (!login) {
    return { login: "", human: false }; // system action (CI / no actor) → GitHub mark
  }
  // App/bot logins ("claraclawd[bot]", "github-actions[bot]", "dependabot[bot]")
  // don't have a plain user avatar — treat as a system/bot action.
  const human = !/\[bot\]$/i.test(login) && login !== "github-actions";
  return { login, human };
}

/** The round avatar chip. Hook-actor humans get their GitHub avatar; bots /
 *  system actions get the GitHub mark; assistant turns the Bot; everything
 *  else the generic User. Falls back to the GitHub mark if an avatar 404s. */
function Avatar({ isUser, hookActor }: { isUser: boolean; hookActor: HookActor | null }) {
  const [imgFailed, setImgFailed] = useState(false);
  const base =
    "mt-1 flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full";

  if (hookActor) {
    if (hookActor.human && !imgFailed) {
      return (
        <img
          src={`https://github.com/${encodeURIComponent(hookActor.login)}.png?size=56`}
          alt={hookActor.login}
          title={hookActor.login}
          className={cn(base, "bg-base-300")}
          onError={() => setImgFailed(true)}
        />
      );
    }
    // bot / system action / failed avatar → GitHub mark
    return (
      <div
        className={cn(base, "bg-base-300 text-base-content/70")}
        title={hookActor.login || "system action"}
        aria-hidden
      >
        <Github className="size-4" />
      </div>
    );
  }

  return (
    <div
      className={cn(base, isUser ? "bg-primary/15 text-primary" : "bg-base-300 text-base-content/70")}
      aria-hidden
    >
      {isUser ? <User className="size-4" /> : <Bot className="size-4" />}
    </div>
  );
}
