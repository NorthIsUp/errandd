/**
 * Shared chat-directive helpers used by every chat platform integration
 * (telegram / discord / slack).
 *
 * These were byte-for-byte duplicated in each `src/commands/<platform>.ts`
 * file; hoisting them here keeps the behavior identical while removing the
 * copy-paste drift risk called out in the codebase audit (P1-1).
 */

/**
 * Extract a `[react:<emoji>]` directive from model output.
 *
 * Removes every `[react:...]` token from the text, returning the first
 * non-empty emoji found (or `null`) alongside the cleaned text. Trailing
 * whitespace introduced by the removal is normalized: spaces before a newline
 * are trimmed and runs of 3+ blank lines collapse to a single blank line.
 *
 * NOTE: This is a verbatim lift of the identical implementation that lived in
 * telegram.ts, discord.ts, and slack.ts. Do not change its behavior without
 * updating all three call sites' expectations.
 */
export function extractReactionDirective(text: string): { cleanedText: string; reactionEmoji: string | null } {
  let reactionEmoji: string | null = null;
  const cleanedText = text
    .replace(/\[react:([^\]\r\n]+)\]/gi, (_match, raw) => {
      const candidate = String(raw).trim();
      if (!reactionEmoji && candidate) reactionEmoji = candidate;
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, reactionEmoji };
}
