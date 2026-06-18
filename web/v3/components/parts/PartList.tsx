import { type ReactNode, useState } from "react";
import type { ChatPart } from "../../lib/transcriptParts";
import { ChainOfThoughtGroup, type CotPart, type RailPart } from "./ChainOfThoughtGroup";
import { InfoPart } from "./InfoPart";
import { SourcesPart } from "./SourcesPart";
import { SystemPart } from "./SystemPart";
import { TextPart } from "./TextPart";

/**
 * Does model WORK (a tool call or reasoning block) follow the part at index
 * `i` before the turn ends? A `user` text or any `system` part is a turn
 * boundary; sources / further assistant text are transparent. Used to tell
 * INTERIOR narration ("Let me check X…", followed by more tools) from the
 * TERMINAL response (the last assistant text, with no work after it).
 */
function workFollows(parts: ChatPart[], i: number): boolean {
  for (let j = i + 1; j < parts.length; j++) {
    const p = parts[j];
    if (!p) continue;
    if (p.kind === "tool" || p.kind === "reasoning") return true;
    if (p.kind === "system") return false;
    if (p.kind === "text" && p.role === "user") return false;
    // assistant text / sources: keep scanning within the same turn
  }
  return false;
}

/**
 * The rail item for the part at `i`, or null if it's a standalone message.
 * Rail items: reasoning, tool calls, and interior assistant narration (an
 * in-context assistant text that still has tool/reasoning work after it). The
 * terminal assistant text — the actual answer — stays a full message.
 */
function asRailPart(parts: ChatPart[], i: number): RailPart | null {
  const part = parts[i];
  if (!part) return null;
  if (part.kind === "reasoning" || part.kind === "tool") return part;
  if (
    part.kind === "text" &&
    part.role === "assistant" &&
    !part.notInContext &&
    workFollows(parts, i)
  ) {
    return part;
  }
  return null;
}

/**
 * Render a single NON-rail part (text / system / sources). Reasoning + tool
 * parts never reach here — they're collected into a `ChainOfThoughtGroup` by
 * `PartList` so they read as one "train of thought" instead of a flat stack.
 */
export function Part({ part }: { part: Exclude<ChatPart, CotPart> }) {
  const at = part.at == null ? {} : { at: part.at };
  switch (part.kind) {
    case "system":
      // FYI / not-in-context blocks (pre-filtered hooks, suppressed bot bodies,
      // full payloads, [skip:fyi] reasons) render in the blue InfoPart; real
      // triggers / [skip]/[ok] outcomes stay in the base-palette SystemPart.
      return part.notInContext ? (
        <InfoPart text={part.text} {...at} />
      ) : (
        <SystemPart text={part.text} {...at} />
      );
    case "text":
      // A not-in-context text block (e.g. a surfaced payload echoed as prose)
      // also reads as FYI — route it through the blue InfoPart shell.
      return part.notInContext ? (
        <InfoPart text={part.markdown} {...at} />
      ) : (
        <TextPart id={part.id} role={part.role} markdown={part.markdown} />
      );
    case "sources":
      return <SourcesPart sources={part.sources} />;
  }
}

/**
 * The full ordered transcript. Consecutive `reasoning` + `tool` parts are
 * coalesced into a single chain-of-thought rail; every other part renders as a
 * normal full-width message between rails. Order is preserved exactly.
 */
/** Max transcript blocks rendered by default. A pathologically long thread
 *  (thousands of parts) would otherwise mount the whole history as live DOM;
 *  render the most-recent window and let the user expand the rest on demand.
 *  The newest parts (what you're watching) are always shown. */
const DEFAULT_BLOCK_WINDOW = 150;

export function PartList({ parts }: { parts: ChatPart[] }) {
  const [showAll, setShowAll] = useState(false);
  const blocks: { id: string; node: ReactNode }[] = [];
  let run: RailPart[] = [];

  const flushRun = () => {
    if (run.length > 0) {
      const group = run;
      blocks.push({ id: `cot:${group[0]!.id}`, node: <ChainOfThoughtGroup parts={group} /> });
      run = [];
    }
  };

  for (let i = 0; i < parts.length; i++) {
    const rail = asRailPart(parts, i);
    if (rail) {
      run.push(rail);
    } else {
      flushRun();
      blocks.push({
        id: parts[i]!.id,
        node: <Part part={parts[i] as Exclude<ChatPart, CotPart>} />,
      });
    }
  }
  flushRun();

  // Keep only the most-recent window unless the user expands — bounds the live
  // DOM for very long threads (the newest parts stay visible).
  const hiddenCount = showAll ? 0 : Math.max(0, blocks.length - DEFAULT_BLOCK_WINDOW);
  const visible = hiddenCount > 0 ? blocks.slice(-DEFAULT_BLOCK_WINDOW) : blocks;

  return (
    <div className="flex flex-col gap-4">
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="self-center rounded-full border border-base-300 px-3 py-1 font-mono text-[11px] text-base-content/55 transition-colors hover:border-secondary hover:text-secondary"
        >
          Show {hiddenCount} earlier {hiddenCount === 1 ? "part" : "parts"}
        </button>
      )}
      {visible.map((b) => (
        <div key={b.id}>{b.node}</div>
      ))}
    </div>
  );
}
