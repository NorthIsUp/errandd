/**
 * The curated allowlist of plugin keys errandd ENABLES by default at boot —
 * the "gitops default-enabled" state. Boot preflight INSTALLS every plugin the
 * manifest (plugins.json) declares, but only ENABLES this set; everything else
 * installs disabled (see app/preflight.ts → applyDefaultEnablement).
 *
 * Keys are the exact `<plugin>@<marketplace>` form preflight computes — verified
 * against each repo's marketplace.json `name` (context7's marketplace is
 * `context7-marketplace`, skillz's is `northisup-skillz`, caveman/ponytail use
 * `<name>@<name>`). errandd itself isn't installed via preflight (it runs from a
 * git checkout) but is listed for completeness / anyone who installs it as a
 * plugin.
 *
 * Single source of truth, shared by boot preflight (which materialises it into
 * project `.claude/settings.json`) and the plugin-list drift check (which
 * compares a plugin's effective enabled state against this default to flag a
 * local override — see app/ui/services/claudePlugins.ts → listPlugins).
 */
export const DEFAULT_ENABLED_PLUGINS = new Set<string>([
  "errandd@errandd",
  "caveman@caveman",
  "ponytail@ponytail",
  "context7@context7-marketplace",
  "skillz@northisup-skillz",
]);
