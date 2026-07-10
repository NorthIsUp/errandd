import { CircleSlash, Filter, Info, MinusCircle } from "lucide-react";
import { InfoCard, INFO_PALETTE } from "./InfoCard";
import { outcomeLabel } from "./outcomeLabel";

/**
 * An FYI block that was NOT part of the model's context — a rule/self skip
 * (`[skip:rule]`), a bot-noise prefilter (`[skip:fyi]`), a `claw:ignore`
 * (`[skip:ignore]`), a suppressed bot body, or the full untruncated payload.
 * Rendered in a distinct blue `info` palette via the shared {@link InfoCard}
 * shell so it reads as clearly outside the conversation.
 *
 * When the text carries an outcome marker, {@link outcomeLabel} turns it into a
 * friendly header — "Skipped by a rule" / "Filtered: bot noise" / "Ignored
 * (claw:ignore)" — and strips the marker so the body shows the bare filter
 * reason. The blue palette already signals "not sent to the agent"; for a
 * non-marker FYI block (suppressed body / full payload) we fall back to the
 * explicit "Not sent to the agent (FYI)" header.
 *
 * Routed in `PartList` whenever a part carries `notInContext: true` (set by the
 * parser from the backend's recorded skip/prefilter decision). The frontend
 * holds no business logic here — it trusts the parser's marking and only maps
 * the marker to words.
 */
export function InfoPart({ text, at }: { text: string; at?: number }) {
  const outcome = outcomeLabel(text);
  const atProps = at == null ? {} : { at };

  if (outcome) {
    const icon =
      outcome.kind === "filtered" ? (
        <Filter className="size-3.5" />
      ) : outcome.kind === "ignored" ? (
        <MinusCircle className="size-3.5" />
      ) : (
        <CircleSlash className="size-3.5" />
      );
    return (
      <InfoCard
        text={outcome.body || outcome.header}
        palette={INFO_PALETTE}
        header={outcome.header}
        icon={icon}
        {...atProps}
      />
    );
  }

  return (
    <InfoCard
      text={text}
      palette={INFO_PALETTE}
      header="Not sent to the agent (FYI)"
      icon={<Info className="size-3.5" />}
      {...atProps}
    />
  );
}
