import { AboutSection } from "../../ui/sections/AboutSection";
import type { MainPaneProps } from "../App";

/**
 * v3 About — thin wrapper around the existing web/ui AboutSection (spec §9).
 * AboutSection depends only on `web/api/*` + darwin-ui (no router), so it
 * renders unchanged inside the v3 main pane.
 */
export function AboutView(_props: MainPaneProps) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-4 space-y-4">
        <AboutSection />
      </div>
    </div>
  );
}
