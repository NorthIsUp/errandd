import { SettingsSection } from "../../ui/sections/SettingsSection";
import type { MainPaneProps } from "../App";

/**
 * v3 Settings — thin wrapper around the existing web/ui SettingsSection
 * (spec §9). It depends only on `web/api/*` + darwin-ui, both available in
 * v3, so we render it as-is inside a scrollable main-pane container.
 *
 * SettingsSection reads `web/ui`'s hash router for its "scroll to section"
 * deep-link, but only ever *reads* `route.segments[0]` (it never calls
 * `goto`), so it coexists with v3's own hash router without hijacking
 * navigation.
 *
 * `hideAppearance` drops the legacy theme controls — v3 owns its own theme
 * system (sidebar ThemePicker / `errandd:v3:theme`); the old Appearance
 * panel writes conflicting `errandd:theme` keys, which was the source of the
 * "themes all messed up" behavior when visiting Settings.
 */
export function SettingsView(_props: MainPaneProps) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-4 space-y-4">
        <SettingsSection hideAppearance />
      </div>
    </div>
  );
}
