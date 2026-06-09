import { AlertTriangle } from "lucide-react";
import { useQueueTree } from "../hooks/useQueueTree";
import { useRateLimit } from "../hooks/useRateLimit";
import { deferredCount, fmtUtcHM } from "../lib/queuedUntil";

/**
 * Compact top banner shown across the main pane while the agent is rate-limited
 * (spec: queued-until UI). Reads `rateLimit` from `/api/state` (the backend
 * adds it) via `useRateLimit`, and the number of deferred messages from the
 * durable hook queue. Renders nothing when not rate-limited, so it's safe to
 * mount unconditionally above any view.
 *
 *   ⚠ Rate limited — N message(s) queued, resuming HH:MM UTC
 */
export function RateLimitBanner() {
  const { limited, resetAt } = useRateLimit();
  const { messages } = useQueueTree();

  if (!limited) {
    return null;
  }

  const n = deferredCount(messages);
  const when = resetAt > 0 ? fmtUtcHM(resetAt) : "soon";
  const count = n === 1 ? "1 message" : `${n} messages`;

  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-xs text-warning"
    >
      <AlertTriangle className="size-3.5 shrink-0" />
      <span className="font-medium">Rate limited</span>
      <span className="text-warning/80">
        — {count} queued, resuming {when}
      </span>
    </div>
  );
}
