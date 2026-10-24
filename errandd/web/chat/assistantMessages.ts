import type { Message } from "@ag-ui/client";
import { fromAgUiMessages } from "@assistant-ui/react-ag-ui";

type DisplayMessage = ReturnType<typeof fromAgUiMessages>[number];
type ThoughtMessage = DisplayMessage & {
  content: NonNullable<Exclude<DisplayMessage["content"], string>>;
};
function isThought(message: DisplayMessage | undefined): message is ThoughtMessage {
  return (
    message?.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every(
      (part: { type: string }) => part.type === "tool-call" || part.type === "reasoning",
    )
  );
}

/** The native converter attaches activities to a preceding assistant and
 * drops them before the first assistant. Keep historical annotation positions
 * with data-only display records; ordinary messages use native conversion.
 * This adapter is only used by the disabled, read-only capture runtime. */
export function toAssistantMessages(messages: Message[]) {
  const result: ReturnType<typeof fromAgUiMessages> = [];
  let pending: Message[] = [];
  const flush = () => {
    for (const message of fromAgUiMessages(pending)) {
      const previous = result.at(-1);
      // Captures give each tool its own message ID. Project adjacent thought
      // records for native GroupedParts without crossing answers or notices.
      if (isThought(previous) && isThought(message)) {
        result[result.length - 1] = {
          ...previous,
          content: [...previous.content, ...message.content],
        };
      } else {
        result.push(message);
      }
    }
    pending = [];
  };
  for (const message of messages) {
    if (message.role !== "activity") {
      pending.push(message);
      continue;
    }
    flush();
    result.push({
      id: message.id,
      role: "assistant",
      content: [
        { type: "data", name: `agui-activity/${message.activityType}`, data: message.content },
      ],
    });
  }
  flush();
  return result;
}
