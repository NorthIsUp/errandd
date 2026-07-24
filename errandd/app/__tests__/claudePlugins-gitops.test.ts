import { describe, expect, it } from "bun:test";
import { DEFAULT_ENABLED_PLUGINS } from "../defaultEnabledPlugins";
import {
  GITOPS_MANAGED_LABEL,
  isGitOpsManagedError,
} from "../../web/api/claudePlugins";

// The classifier decides whether a `claude plugin` CLI error means
// "provisioned via GitOps at project scope" (calm, muted state) vs a genuine
// failure (real red "failed" + error text). See web/api/claudePlugins.ts.
describe("isGitOpsManagedError", () => {
  it("classifies the real project-scope CLI error as gitops-managed", () => {
    const cliError =
      'Plugin "caveman@caveman" is enabled at project scope ' +
      "(.claude/settings.json, shared with your team). " +
      "To disable just for you: claude plugin disable caveman@caveman --scope local";
    expect(isGitOpsManagedError(cliError)).toBe(true);
  });

  it("matches each stable signal independently and is case-insensitive", () => {
    expect(isGitOpsManagedError("enabled at PROJECT SCOPE")).toBe(true);
    expect(isGitOpsManagedError("Shared With Your Team")).toBe(true);
    expect(isGitOpsManagedError("this plugin is managed")).toBe(true);
  });

  it("leaves genuine failures unclassified", () => {
    expect(isGitOpsManagedError("npm install failed: ENOTFOUND")).toBe(false);
    expect(isGitOpsManagedError("plugin not found in any marketplace")).toBe(false);
    expect(isGitOpsManagedError(null)).toBe(false);
    expect(isGitOpsManagedError(undefined)).toBe(false);
    expect(isGitOpsManagedError("")).toBe(false);
  });

  it("exposes a stable label matching the Git-identity wording style", () => {
    expect(GITOPS_MANAGED_LABEL).toBe("Managed via GitOps");
  });
});

// Drift = a plugin's effective enabled state (incl. local override) differs
// from the gitops default (DEFAULT_ENABLED_PLUGINS allowlist = enabled, else
// disabled). listPlugins computes `overridden = enabled !== gitopsDefault`.
describe("gitops drift default set", () => {
  const drift = (id: string, enabled: boolean) => {
    const gitopsDefault = DEFAULT_ENABLED_PLUGINS.has(id);
    return { gitopsDefault, overridden: enabled !== gitopsDefault };
  };

  it("keeps the exact <plugin>@<marketplace> allowlist preflight materialises", () => {
    expect([...DEFAULT_ENABLED_PLUGINS].sort()).toEqual([
      "caveman@caveman",
      "context7@context7-marketplace",
      "errandd@errandd",
      "ponytail@ponytail",
      "skillz@northisup-skillz",
    ]);
  });

  it("flags a default-on plugin disabled locally as overridden", () => {
    expect(drift("caveman@caveman", false)).toEqual({ gitopsDefault: true, overridden: true });
  });

  it("flags a default-off plugin enabled locally as overridden", () => {
    expect(drift("code-review@claude-plugins-official", true)).toEqual({
      gitopsDefault: false,
      overridden: true,
    });
  });

  it("does not flag plugins that match their gitops default", () => {
    expect(drift("ponytail@ponytail", true).overridden).toBe(false);
    expect(drift("code-review@claude-plugins-official", false).overridden).toBe(false);
  });
});
