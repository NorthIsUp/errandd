import type { SourceLink } from "../../lib/transcriptParts";
import { Source, SourceContent, SourceTrigger } from "../prompt-kit/source";

/**
 * A `sources` part — the reference rail appended under an assistant turn (hook
 * origin URL + `file:line` links). Each link is a prompt-kit `Source` with a
 * hover-card preview.
 */
export function SourcesPart({ sources }: { sources: SourceLink[] }) {
  if (sources.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 pl-9 text-xs">
      <span className="text-base-content/50">Sources</span>
      {sources.map((s) => (
        <Source key={s.href} href={s.href}>
          <SourceTrigger label={s.label} className="max-w-48" />
          <SourceContent title={s.title ?? s.label} description={s.href} />
        </Source>
      ))}
    </div>
  );
}
