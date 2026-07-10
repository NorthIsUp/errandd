import { RefreshCw } from "lucide-react";
import { useStaleBundle } from "../hooks/useBuildInfo";

/**
 * Shows a refresh prompt when the daemon has redeployed a newer build than the
 * one this tab loaded — so a stale SPA tab (running pre-deploy JS) doesn't
 * silently show outdated behavior. Click to reload into the new bundle.
 *
 * Non-intrusive by design: a prompt, not a forced auto-reload, so it never
 * interrupts mid-action (e.g. typing in a chat).
 */
export function UpdateBanner() {
  const { stale, version } = useStaleBundle();
  if (!stale) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      className="flex w-full shrink-0 items-center justify-center gap-2 border-b border-primary/30 bg-primary/10 px-4 py-1.5 text-xs text-primary transition-colors hover:bg-primary/20"
      title={`The daemon redeployed to v${version}; this tab is running an older bundle.`}
    >
      <RefreshCw className="size-3.5 shrink-0" />
      <span className="font-medium">New version deployed{version ? ` (v${version})` : ""}</span>
      <span className="text-primary/80">— click to refresh</span>
    </button>
  );
}
