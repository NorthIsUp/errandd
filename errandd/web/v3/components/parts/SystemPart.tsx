import { CircleCheck, CircleSlash, Webhook } from "lucide-react";
import { InfoCard, SYSTEM_PALETTE } from "./InfoCard";
import { outcomeLabel } from "./outcomeLabel";

/**
 * A `system` part — a hook trigger (the WHAT: `event · @actor · #PR`) or the
 * agent's terminal outcome line. Renders through the shared {@link InfoCard}
 * shell: a long trigger collapses to a one-line summary so it never dominates
 * the thread; a short notice is a compact banner. Both show a timestamp.
 *
 * This is the *in-context* variant (base palette) — it covers the two outcomes
 * that WERE the model's input/output: **handled by the agent** (`[ok]`) and
 * **skipped by the agent** (plain `[skip] <reason>`). When the text carries an
 * outcome marker, {@link outcomeLabel} turns it into a friendly header
 * ("Handled by the agent" / "Skipped by the agent") and strips the marker from
 * the body so the card reads cleanly. A plain trigger card (no marker) renders
 * unchanged.
 *
 * Its FYI sibling — rule-skips / bot-noise filters that were NOT sent to the
 * agent — is `InfoPart` (blue palette), routed in `PartList` on `notInContext`.
 */
export function SystemPart({ text, at }: { text: string; at?: number }) {
  const outcome = outcomeLabel(text);
  const atProps = at == null ? {} : { at };

  if (outcome) {
    // A handled/skipped-by-agent outcome: badge the state in the header, show
    // the bare reason as the body, and pick an icon that reads at a glance.
    const icon =
      outcome.kind === "handled" ? (
        <CircleCheck className="size-3.5" />
      ) : (
        <CircleSlash className="size-3.5" />
      );
    return (
      <InfoCard
        text={outcome.body || outcome.header}
        palette={SYSTEM_PALETTE}
        header={outcome.header}
        icon={icon}
        {...atProps}
      />
    );
  }

  // The WHAT trigger card (or any freeform system notice) — collapsed to its
  // one-line summary by InfoCard.
  return <InfoCard text={text} palette={SYSTEM_PALETTE} icon={<Webhook className="size-3.5" />} {...atProps} />;
}
