import type { ChatPart } from "../../lib/transcriptParts";
import { ReasoningPart } from "./ReasoningPart";
import { SourcesPart } from "./SourcesPart";
import { SystemPart } from "./SystemPart";
import { TextPart } from "./TextPart";
import { ToolPart } from "./ToolPart";

/** Render a single transcript part with its kind-specific component (spec §5/§6). */
export function Part({ part }: { part: ChatPart }) {
  switch (part.kind) {
    case "system":
      return <SystemPart text={part.text} />;
    case "text":
      return <TextPart id={part.id} role={part.role} markdown={part.markdown} />;
    case "reasoning":
      return <ReasoningPart markdown={part.markdown} />;
    case "tool":
      return <ToolPart tool={part.tool} />;
    case "sources":
      return <SourcesPart sources={part.sources} />;
  }
}

/** The full ordered list of transcript parts. */
export function PartList({ parts }: { parts: ChatPart[] }) {
  return (
    <div className="flex flex-col gap-4">
      {parts.map((part) => (
        <Part key={part.id} part={part} />
      ))}
    </div>
  );
}
