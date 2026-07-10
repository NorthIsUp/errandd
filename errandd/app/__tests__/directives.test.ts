import { describe, test, expect } from "bun:test";
import { extractReactionDirective } from "../messaging/directives";
import { extractReactionDirective as slackReExport } from "../commands/slack";

// The shared directive helper (src/messaging/directives.ts) is the single source
// of truth lifted out of the byte-identical copies that lived in telegram.ts,
// discord.ts and slack.ts. These tests lock its behavior so the consolidation
// cannot silently drift.
describe("extractReactionDirective (shared)", () => {
  test("extracts the first reaction emoji and strips the directive", () => {
    const { cleanedText, reactionEmoji } = extractReactionDirective("Nice! [react:thumbsup] done");
    expect(reactionEmoji).toBe("thumbsup");
    expect(cleanedText).toBe("Nice!  done".replace(/[ \t]+\n/g, "\n").trim());
    expect(cleanedText).toContain("Nice!");
    expect(cleanedText).toContain("done");
    expect(cleanedText).not.toContain("[react:");
  });

  test("returns null when there is no directive", () => {
    const { cleanedText, reactionEmoji } = extractReactionDirective("plain text");
    expect(reactionEmoji).toBeNull();
    expect(cleanedText).toBe("plain text");
  });

  test("keeps only the first emoji when several are present", () => {
    const { reactionEmoji, cleanedText } = extractReactionDirective("[react:a] hi [react:b]");
    expect(reactionEmoji).toBe("a");
    expect(cleanedText).toBe("hi");
  });

  test("collapses 3+ blank lines left by removal to a single blank line", () => {
    const { cleanedText } = extractReactionDirective("top\n\n\n[react:x]\n\n\nbottom");
    expect(cleanedText).toBe("top\n\nbottom");
  });

  test("the slack re-export is the same binding as the shared helper", () => {
    expect(slackReExport).toBe(extractReactionDirective);
  });
});
