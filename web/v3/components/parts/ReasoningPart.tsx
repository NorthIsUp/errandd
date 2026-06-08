import { Brain } from "lucide-react";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "../prompt-kit/reasoning";

/**
 * A `reasoning` part — the agent's thinking block, collapsed by default behind
 * a "Thought" trigger. The markdown body renders via the prompt-kit `Markdown`
 * path (`ReasoningContent markdown`).
 */
export function ReasoningPart({ markdown }: { markdown: string }) {
  return (
    <Reasoning className="my-1">
      <ReasoningTrigger className="text-xs font-medium text-base-content/60">
        <Brain className="size-3.5" />
        Thought
      </ReasoningTrigger>
      <ReasoningContent
        markdown
        className="mt-2 border-l-2 border-base-300 pl-3"
        contentClassName="text-sm"
      >
        {markdown}
      </ReasoningContent>
    </Reasoning>
  );
}
