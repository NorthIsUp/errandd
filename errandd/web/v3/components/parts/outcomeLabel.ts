/**
 * Marker → friendly outcome label for hook-delivery status lines (spec §3.2).
 *
 * Every delivery that reaches a thread ends in a terminal status line whose
 * leading `[…]` marker encodes the OUTCOME. This pure helper maps that marker to
 * a human header for the `SystemPart` / `InfoPart` card and strips the marker
 * from the body so the card shows `<friendly header> · <reason>` instead of a
 * raw `[skip:rule] …`. It is the ONLY place the marker grammar is turned into
 * presentation — the parser (`src/ui/services/threadParts.ts`) decides
 * in-context vs FYI; this decides the words.
 *
 * The marker grammar is the cross-slice contract from the backend (Slice A):
 *
 *   [ok] / [done] / [pass]   → "Handled by the agent"   (in-context)
 *   [skip]                   → "Skipped by the agent"   (in-context)
 *   [skip:rule]              → "Skipped by a rule"       (FYI / not-in-context)
 *   [skip:fyi]               → "Filtered: bot noise"     (FYI / not-in-context)
 *   [skip:ignore]            → "Ignored (claw:ignore)"   (FYI / not-in-context)
 *
 * Anything without a recognized marker returns `null` (no header) so a plain
 * trigger card / notice renders unchanged. Purely presentational — no business
 * logic, no model tokens.
 */

/** Leading status marker on a delivery's terminal line: `[skip]`, `[ok]`,
 *  `[skip:rule]`, `[skip:fyi]`, `[skip:ignore]`, `[done]`, `[pass]`. The capture
 *  groups are the base verb and the optional `:suffix`. Mirrors `STATUS_LINE_RE`
 *  in `src/ui/services/threadParts.ts` (kept in sync by the marker contract). */
const OUTCOME_MARKER_RE = /^\s*\[(skip|ok|pass|done)(?::([a-z]+))?\]\s*/i;

export type OutcomeKind =
  | "handled" // agent ran + acted
  | "skipped-agent" // agent ran, chose to skip (with reason)
  | "skipped-rule" // config/self filter matched before the model
  | "filtered" // pre-filter bot noise
  | "ignored"; // claw:ignore label

export interface DeliveryOutcome {
  /** Coarse state, for any caller that wants to branch on it. */
  kind: OutcomeKind;
  /** Friendly card header, e.g. "Skipped by a rule". */
  header: string;
  /** The line with its `[…]` marker stripped — the bare reason/details. */
  body: string;
}

/**
 * Parse a status line's leading marker into a friendly outcome label, or `null`
 * when there is no recognized marker (a normal trigger card or freeform notice).
 */
export function outcomeLabel(text: string): DeliveryOutcome | null {
  const m = OUTCOME_MARKER_RE.exec(text);
  if (!m) {
    return null;
  }
  const verb = m[1]?.toLowerCase();
  const suffix = m[2]?.toLowerCase();
  const body = text.replace(OUTCOME_MARKER_RE, "").trim();

  if (verb === "skip") {
    switch (suffix) {
      case "rule":
        return filterOutcome(body);
      case "fyi":
        return { kind: "filtered", header: "Filtered: bot noise", body };
      case "ignore":
        return { kind: "ignored", header: "Ignored (claw:ignore)", body };
      default:
        // Plain `[skip]` (no suffix). New data tags filter skips as `[skip:rule]`,
        // but older transcripts emitted a plain `[skip]` for filter skips too — so
        // if the reason reads like a config-filter rejection it's the SYSTEM, not
        // the agent. The agent's own skips have free-form reasons.
        return looksLikeFilterReason(body)
          ? filterOutcome(body)
          : { kind: "skipped-agent", header: "Skipped by the agent", body };
    }
  }
  // ok / done / pass — the agent ran and acted.
  return { kind: "handled", header: "Handled by the agent", body };
}

/** A filter/system skip — the hook never reached the model. */
function filterOutcome(body: string): DeliveryOutcome {
  return {
    kind: "skipped-rule",
    header: "Skipped by filters",
    body: body || "hook doesn't match any filter",
  };
}

/** Heuristic: does a plain-`[skip]` reason read like a config-filter rejection
 *  (vs the agent's own free-form skip)? Covers the matcher skip-reason wording
 *  (`evalPrRule`/`prRuleSkipReason`, sentry/datadog, skip_self, draft, label). */
const FILTER_REASON_RE =
  /not in the .*filter|no (?:pr|sentry|datadog) rule matched|does(?:n't| not) match|excluded by|skip[_ ]?self|draft|claw:ignore|label/i;

function looksLikeFilterReason(body: string): boolean {
  return FILTER_REASON_RE.test(body);
}
