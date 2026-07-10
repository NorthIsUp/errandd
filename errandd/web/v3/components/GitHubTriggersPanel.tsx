/**
 * v3 GitHub triggers panel — the SUPER CLEAR 2×2 checkbox matrix.
 *
 *                 PR updates      Comments
 *      Humans       [x]             [x]
 *      Bots         [ ]             [ ]
 *
 * The simple, obvious editor for a routine's GitHub hook triggers. It is a
 * VIEW over `HookConfig` (the on-disk / wire source of truth, living in the
 * job's `on:` frontmatter). The matrix never touches YAML — it only
 * produces / consumes a `HookConfig`, and the existing `readFrontmatter` /
 * `writeFrontmatter` round-trip (web/ui/schedule.ts) does the YAML losslessly,
 * preserving every unrelated key + the markdown body.
 *
 * The product rule baked in: "created" and "updated" are the SAME thing. We
 * surface exactly two categories — PR updates and Comments — crossed with two
 * actor classes — Humans and Bots. The human never picks individual GitHub
 * write-actions; "PR updates ON" always carries the canonical
 * DEFAULT_PR_ACTIONS set and the matcher does the rest.
 *
 * The pure matrix <-> HookConfig mapping fns + summary + the easy defaults are
 * the Slice-A contract, imported from web/ui/hookConfig.ts (the browser-safe
 * mirror of src/hooks/schema.ts). This file is purely the v3 UI over them.
 */

import { ChevronRight } from "lucide-react";
import { PillList } from "../../ui/components/HookConfigEditor";
import {
  defaultGitHubTriggers,
  type GitHubTriggers,
  gitHubTriggersToHookConfig,
  type HookConfig,
  hookConfigToGitHubTriggers,
  summarizeGitHubTriggers,
} from "../../ui/hookConfig";
import type { JobFrontmatter } from "../../ui/schedule";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { cn } from "./ui/utils";

/** Project the matrix to a GitHub HookConfig, then merge any pre-existing
 *  sentry/datadog from `existing` so the panel never clobbers them. Returns
 *  null only when there is no trigger of any kind left. */
function mergeGitHubIntoConfig(
  next: GitHubTriggers,
  existing: HookConfig | null,
): HookConfig | null {
  const ghCfg = gitHubTriggersToHookConfig(next);
  const sentry = existing?.sentry;
  const datadog = existing?.datadog;
  // Base: the GitHub projection, or an empty shell if only sentry/datadog live.
  const base: HookConfig | null =
    ghCfg ?? (sentry || datadog ? { pr: [], skipSelf: next.skipSelf } : null);
  if (!base) {
    return null;
  }
  const merged: HookConfig = { ...base };
  if (sentry !== undefined) {
    merged.sentry = sentry;
  }
  if (datadog !== undefined) {
    merged.datadog = datadog;
  }
  return merged;
}

export function GitHubTriggersPanel({
  value,
  onChange,
}: {
  value: JobFrontmatter;
  onChange: (next: JobFrontmatter) => void;
}) {
  const projected = hookConfigToGitHubTriggers(value.hookConfig);
  const matrix = projected.matrix;
  const representable = projected.representable;

  /** Re-project the matrix → HookConfig, merging in any pre-existing
   *  sentry/datadog (the panel owns only pr/comments/skipSelf). */
  function apply(next: GitHubTriggers) {
    onChange({ ...value, hookConfig: mergeGitHubIntoConfig(next, value.hookConfig) });
  }

  function toggle(actor: "humans" | "bots", category: "prUpdates" | "comments", on: boolean) {
    apply({ ...matrix, [actor]: { ...matrix[actor], [category]: on } });
  }

  function setAdvanced(patch: Partial<GitHubTriggers["advanced"]>) {
    apply({ ...matrix, advanced: { ...matrix.advanced, ...patch } });
  }

  function setSkipSelf(on: boolean) {
    apply({ ...matrix, skipSelf: on });
  }

  const summary = summarizeGitHubTriggers(matrix);
  const anyActive =
    matrix.humans.prUpdates ||
    matrix.humans.comments ||
    matrix.bots.prUpdates ||
    matrix.bots.comments;

  return (
    <TooltipProvider delayDuration={150}>
      <fieldset className="space-y-3" disabled={!representable}>
        <legend className="text-sm font-semibold mb-1">GitHub triggers</legend>

        {!representable && <RawFallbackNote />}

        {representable && !anyActive && (
          <button
            type="button"
            onClick={() => apply(defaultGitHubTriggers())}
            className="btn btn-sm btn-outline w-full justify-start"
          >
            Respond to humans (PR updates + comments)
            <span className="text-xs text-base-content/50 ml-1">— the easy default</span>
          </button>
        )}

        {/* The 2×2 grid. */}
        <div
          className={cn(
            "rounded-lg border border-base-300 bg-base-100 p-3",
            !representable && "opacity-50",
          )}
        >
          <div className="grid grid-cols-[5rem_1fr_1fr] gap-x-2 gap-y-1 items-center">
            {/* header row */}
            <div />
            <ColHeader
              label="PR updates"
              tip="Any pull-request update — opened, pushed, edited, reopened, marked ready. (Created and updated are treated the same.)"
            />
            <ColHeader label="Comments" tip="PR reviews, review comments, and issue/PR comments." />

            {/* Humans row */}
            <RowHeader label="Humans" />
            <Cell
              actor="humans"
              category="prUpdates"
              checked={matrix.humans.prUpdates}
              onToggle={toggle}
            />
            <Cell
              actor="humans"
              category="comments"
              checked={matrix.humans.comments}
              onToggle={toggle}
            />

            {/* Bots row */}
            <RowHeader label="Bots" />
            <Cell
              actor="bots"
              category="prUpdates"
              checked={matrix.bots.prUpdates}
              onToggle={toggle}
            />
            <Cell
              actor="bots"
              category="comments"
              checked={matrix.bots.comments}
              onToggle={toggle}
            />
          </div>

          {/* Plain-English summary — always visible. */}
          <p className="mt-3 pt-2 border-t border-base-300 text-xs text-base-content/70">
            {summary}
          </p>
        </div>

        {/* Advanced — collapsed by default. */}
        <Collapsible className="rounded-lg border border-base-300 bg-base-100">
          <CollapsibleTrigger className="group flex w-full items-center gap-1.5 px-3 py-2 text-sm font-medium text-base-content/80 hover:text-base-content">
            <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
            Advanced
          </CollapsibleTrigger>
          <CollapsibleContent className="px-3 pb-3 space-y-4 border-t border-base-300 pt-3">
            <PillList
              label="Base branch"
              items={matrix.advanced.base}
              placeholder="main, release/*"
              supportsExclude
              hint="Limit PR updates by base branch. Prefix with ! to exclude (default !main)."
              onChange={(base) => setAdvanced({ base })}
            />

            <PillList
              label="Labels"
              items={matrix.advanced.labels}
              placeholder="ready-for-review"
              hint="Only fire PR updates when the PR carries these labels."
              onChange={(labels) => setAdvanced({ labels })}
            />

            <div>
              <div className="text-xs font-medium mb-1">Draft PRs</div>
              <div className="join">
                {(
                  [
                    { v: false as const, label: "Skip drafts" },
                    { v: true as const, label: "Drafts only" },
                    { v: "any" as const, label: "Any" },
                  ] as const
                ).map((opt) => (
                  <button
                    key={String(opt.v)}
                    type="button"
                    aria-pressed={matrix.advanced.draft === opt.v}
                    onClick={() => setAdvanced({ draft: opt.v })}
                    className={cn(
                      "btn btn-xs join-item",
                      matrix.advanced.draft === opt.v ? "btn-primary" : "btn-ghost",
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <PillList
              label="Repo"
              items={matrix.advanced.repo}
              placeholder="org/repo, org/*"
              hint="Which repos these triggers apply to (default */*)."
              onChange={(repo) => setAdvanced({ repo })}
            />

            <label className="flex items-start gap-2 cursor-pointer pt-1 border-t border-base-300">
              <input
                type="checkbox"
                className="checkbox checkbox-sm mt-0.5"
                checked={matrix.skipSelf}
                onChange={(e) => setSkipSelf(e.target.checked)}
              />
              <span className="min-w-0">
                <span className="text-sm font-medium block">Skip my own events</span>
                <span className="text-xs text-base-content/60">
                  Don't retrigger on this errandd user's own PRs / comments.
                </span>
              </span>
            </label>
          </CollapsibleContent>
        </Collapsible>
      </fieldset>
    </TooltipProvider>
  );
}

function ColHeader({ label, tip }: { label: string; tip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="text-center text-xs font-semibold text-base-content/80 cursor-help underline decoration-dotted decoration-base-content/30 underline-offset-2">
          {label}
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-[16rem] text-center">{tip}</TooltipContent>
    </Tooltip>
  );
}

function RowHeader({ label }: { label: string }) {
  return <div className="text-sm font-medium text-base-content/80">{label}</div>;
}

function Cell({
  actor,
  category,
  checked,
  onToggle,
}: {
  actor: "humans" | "bots";
  category: "prUpdates" | "comments";
  checked: boolean;
  onToggle: (actor: "humans" | "bots", category: "prUpdates" | "comments", on: boolean) => void;
}) {
  const actorLabel = actor === "humans" ? "Humans" : "Bots";
  const catLabel = category === "prUpdates" ? "PR updates" : "Comments";
  return (
    <div className="flex justify-center">
      <input
        type="checkbox"
        className="checkbox checkbox-primary"
        checked={checked}
        aria-label={`${actorLabel} · ${catLabel}`}
        onChange={(e) => onToggle(actor, category, e.target.checked)}
      />
    </div>
  );
}

function RawFallbackNote() {
  return (
    <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-content/90">
      This routine uses a custom hook config the simple grid can't show. Edit the raw{" "}
      <code className="font-mono">on:</code> block in the Edit tab.
    </div>
  );
}
