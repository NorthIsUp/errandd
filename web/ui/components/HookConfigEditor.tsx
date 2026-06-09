/**
 * Editor for the `on.pr` hook-config block inside a job's YAML frontmatter.
 *
 * Renders one card per PrRule with editors for repo / user / action /
 * branch / labels / draft. Mutations bubble up via `onChange` — the parent
 * is responsible for persisting the resulting HookConfig back into the
 * job's frontmatter string (via writeFrontmatter in schedule.ts).
 */

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  ALL_PR_ACTIONS,
  type DraftValue,
  defaultPrRule,
  type HookConfig,
  type PrRule,
} from "../hookConfig";

export interface PillListProps {
  label: string;
  items: string[];
  placeholder: string;
  /** When true, items prefixed with `!` are styled as excludes. */
  supportsExclude?: boolean;
  onChange: (next: string[]) => void;
  hint?: string;
  warn?: boolean;
}

/** Tag/pill input for editing a glob list. Reused by the Sentry / Datadog
 *  hook editors as well as the GitHub PR-rule cards. */
export function PillList({
  label,
  items,
  placeholder,
  supportsExclude,
  onChange,
  hint,
  warn,
}: PillListProps) {
  const [draft, setDraft] = useState("");

  function commit() {
    const trimmed = draft.trim();
    if (!trimmed) {
      return;
    }
    onChange([...items, trimmed]);
    setDraft("");
  }

  function remove(idx: number) {
    onChange(items.filter((_, i) => i !== idx));
  }

  return (
    <div>
      <div className="text-xs font-medium mb-1 flex items-center gap-2">
        <span>{label}</span>
        {warn && <span className="badge badge-warning badge-xs">required</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {items.map((item, idx) => {
          const isExclude = supportsExclude && item.startsWith("!");
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: pill order is significant; index is a stable id while the list is rendered.
              key={`${idx}:${item}`}
              className={`badge gap-1 font-mono text-xs ${
                isExclude ? "badge-outline badge-error" : "badge-ghost"
              }`}
            >
              {item}
              <button
                type="button"
                onClick={() => remove(idx)}
                aria-label={`Remove ${item}`}
                className="opacity-60 hover:opacity-100"
              >
                ×
              </button>
            </span>
          );
        })}
        <input
          type="text"
          spellCheck={false}
          className="input input-bordered input-xs font-mono w-40"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit();
            } else if (e.key === "Backspace" && draft === "" && items.length > 0) {
              e.preventDefault();
              remove(items.length - 1);
            }
          }}
          onBlur={commit}
          placeholder={placeholder}
        />
      </div>
      {hint && <div className="text-[11px] text-base-content/50 mt-1">{hint}</div>}
    </div>
  );
}

function repoString(repo: string | string[]): string {
  return Array.isArray(repo) ? repo.join(", ") : repo;
}

function parseRepo(input: string): string | string[] {
  const parts = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return "";
  }
  if (parts.length === 1) {
    return parts[0] ?? "";
  }
  return parts;
}

function formatActions(actions: string[]): string {
  if (actions.length === 0) {
    return "no actions";
  }
  if (actions.length === 1) {
    return actions[0] ?? "";
  }
  if (actions.length === 2) {
    return `${actions[0]} or ${actions[1]}`;
  }
  return `${actions.slice(0, -1).join(", ")}, or ${actions[actions.length - 1]}`;
}

function formatUsers(users: string[]): string {
  if (users.length === 0) {
    return "nobody";
  }
  const includes = users.filter((u) => !u.startsWith("!"));
  const excludes = users.filter((u) => u.startsWith("!")).map((u) => u.slice(1));
  const incPart = includes.length > 0 ? includes.join(", ") : "nobody";
  if (excludes.length === 0) {
    return incPart;
  }
  return `${incPart} except ${excludes.join(", ")}`;
}

function formatBranches(branches: string[]): string {
  if (branches.length === 0) {
    return "no branches";
  }
  if (branches.length === 1 && branches[0] === "*") {
    return "any base branch";
  }
  return branches.join(", ");
}

function describeRule(rule: PrRule): string {
  const repoText = repoString(rule.repo) || "(repo unset)";
  const actionText = formatActions(rule.action);
  const userText = formatUsers(rule.user);
  const branchText = formatBranches(rule.branch);
  const labelText = rule.labels.length > 0 ? ` with label ${rule.labels.join(", ")}` : "";
  const draftText =
    rule.draft === true ? " (drafts only)" : rule.draft === "any" ? " (drafts and ready PRs)" : "";
  return `Fires when ${repoText} sees ${actionText} from ${userText} on ${branchText}${labelText}${draftText}.`;
}

function RuleCard({
  rule,
  index,
  onChange,
  onRemove,
}: {
  rule: PrRule;
  index: number;
  onChange: (next: PrRule) => void;
  onRemove: () => void;
}) {
  const repoBlank = repoString(rule.repo).trim() === "";
  const userBlank = rule.user.length === 0;

  function toggleAction(action: string) {
    if (rule.action.includes(action)) {
      onChange({ ...rule, action: rule.action.filter((a) => a !== action) });
    } else {
      onChange({ ...rule, action: [...rule.action, action] });
    }
  }

  function setDraft(d: DraftValue) {
    onChange({ ...rule, draft: d });
  }

  return (
    <div className="card card-bordered bg-base-200/40">
      <div className="card-body p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <h4 className="text-sm font-semibold">Rule {index + 1}</h4>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={onRemove}
            aria-label={`Remove rule ${index + 1}`}
          >
            <Trash2 size={14} /> Remove
          </button>
        </div>

        <div>
          <div className="text-xs font-medium mb-1 flex items-center gap-2">
            <span>Repo</span>
            {repoBlank && <span className="badge badge-warning badge-xs">required</span>}
          </div>
          <input
            type="text"
            spellCheck={false}
            className="input input-bordered input-sm font-mono w-full"
            value={repoString(rule.repo)}
            onChange={(e) => onChange({ ...rule, repo: parseRepo(e.target.value) })}
            placeholder="org/repo, org/* (comma-separated)"
          />
        </div>

        <PillList
          label="User"
          items={rule.user}
          placeholder="*, !*[bot]"
          supportsExclude
          warn={userBlank}
          hint="Order matters. Prefix with ! to exclude."
          onChange={(next) => onChange({ ...rule, user: next })}
        />

        <div>
          <div className="text-xs font-medium mb-1">Action</div>
          <div className="flex flex-wrap gap-1.5">
            {ALL_PR_ACTIONS.map((action) => {
              const on = rule.action.includes(action);
              return (
                <button
                  key={action}
                  type="button"
                  onClick={() => toggleAction(action)}
                  aria-pressed={on}
                  className={`btn btn-xs ${on ? "btn-primary" : "btn-ghost"}`}
                >
                  {action}
                </button>
              );
            })}
          </div>
        </div>

        <PillList
          label="Base branch"
          items={rule.branch}
          placeholder="main, release/*"
          supportsExclude
          onChange={(next) => onChange({ ...rule, branch: next })}
        />

        <PillList
          label="Labels"
          items={rule.labels}
          placeholder="ready-for-review"
          onChange={(next) => onChange({ ...rule, labels: next })}
        />

        <div>
          <div className="text-xs font-medium mb-1">Draft PRs</div>
          <div className="join">
            {(
              [
                { v: false as DraftValue, label: "Skip drafts" },
                { v: true as DraftValue, label: "Drafts only" },
                { v: "any" as DraftValue, label: "Any" },
              ] as const
            ).map((opt) => (
              <button
                key={String(opt.v)}
                type="button"
                aria-pressed={rule.draft === opt.v}
                onClick={() => setDraft(opt.v)}
                className={`btn btn-xs join-item ${
                  rule.draft === opt.v ? "btn-primary" : "btn-ghost"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="text-xs text-base-content/70 italic pt-1 border-t border-base-300">
          {describeRule(rule)}
        </div>
      </div>
    </div>
  );
}

type DraftState = "open" | "draft";
type Author = "human" | "bot";

/** Map a set of author classes to a `user` glob list. Both (or none) → any;
 *  a single class narrows. Mirrors how the rule editor + matcher read it. */
function authorsToGlob(a: Set<Author>): string[] {
  const human = a.has("human");
  const bot = a.has("bot");
  if ((human && bot) || (!human && !bot)) return ["*"];
  if (human) return ["*", "!*[bot]"];
  return ["*[bot]"];
}

function globToAuthors(u: string[]): Set<Author> {
  if (u.length === 2 && u[0] === "*" && u[1] === "!*[bot]") return new Set<Author>(["human"]);
  if (u.length === 1 && u[0] === "*[bot]") return new Set<Author>(["bot"]);
  // `["*"]` or anything else permissive → both.
  return new Set<Author>(["human", "bot"]);
}

/** The PR-commit preset rule for a chosen draft-state + author selection, or
 *  null when no draft-state is selected (= no PR trigger). */
function prPresetRule(draftStates: Set<DraftState>, authors: Set<Author>): PrRule | null {
  if (draftStates.size === 0) return null;
  const both = draftStates.has("open") && draftStates.has("draft");
  return {
    repo: "*/*",
    user: authorsToGlob(authors),
    action: ["opened", "synchronize", "reopened"],
    branch: ["!main"],
    labels: [],
    draft: both ? "any" : draftStates.has("draft"),
  };
}

/** The single rule iff it matches the preset shape (any repo, default
 *  actions, `!main` branch, no labels) — else null (the user has a bespoke
 *  rule, edited in the cards below, that the quick toggles shouldn't drive). */
function presetRule(rules: PrRule[]): PrRule | null {
  if (rules.length !== 1) return null;
  const r = rules[0];
  if (!r) return null;
  const repo = Array.isArray(r.repo) ? r.repo.join(",") : r.repo;
  const actionMatch =
    r.action.length === 3 &&
    r.action.includes("opened") &&
    r.action.includes("synchronize") &&
    r.action.includes("reopened");
  const branchMatch = r.branch.length === 1 && r.branch[0] === "!main";
  if (repo !== "*/*" || !actionMatch || !branchMatch || r.labels.length !== 0) return null;
  return r;
}

function activePrDraftStates(rules: PrRule[]): Set<DraftState> {
  const r = presetRule(rules);
  if (!r) return new Set();
  if (r.draft === "any") return new Set<DraftState>(["open", "draft"]);
  if (r.draft === true) return new Set<DraftState>(["draft"]);
  return new Set<DraftState>(["open"]);
}

function activePrAuthors(rules: PrRule[]): Set<Author> {
  const r = presetRule(rules);
  return r ? globToAuthors(r.user) : new Set();
}

function activeCommentAuthors(c: HookConfig["comments"]): Set<Author> {
  if (c === true) return new Set<Author>(["human", "bot"]);
  if (typeof c !== "object" || c === null) return new Set();
  return globToAuthors(c.user);
}

/** Comment config for a chosen author set: both → any (true), single →
 *  filtered, none → off (null). */
function commentsFromAuthors(a: Set<Author>): boolean | { user: string[] } | null {
  if (a.size === 0) return null;
  const human = a.has("human");
  const bot = a.has("bot");
  if (human && bot) return true;
  if (human) return { user: ["*", "!*[bot]"] };
  return { user: ["*[bot]"] };
}

export function HookConfigEditor({
  value,
  onChange,
}: {
  value: HookConfig | null;
  onChange: (next: HookConfig | null) => void;
}) {
  const rules = value?.pr ?? [];
  const comments = value?.comments ?? false;
  // skipSelf defaults to true — only respect an explicit false.
  const skipSelf = value?.skipSelf !== false;
  const prDraftStates = activePrDraftStates(rules);
  const prAuthors = activePrAuthors(rules);
  const commentAuthors = activeCommentAuthors(comments);
  const prActive = prDraftStates.size > 0;

  // `emit` owns skipSelf: it defaults to the current value and is only
  // changed via the explicit `skipSelfOverride` arg (set by setSkipSelf).
  // Callers pass only pr/comments — never a stale skipSelf from `value`.
  function emit(next: Omit<HookConfig, "skipSelf">, skipSelfOverride?: boolean): void {
    const commentsActive =
      next.comments === true || (typeof next.comments === "object" && next.comments !== null);
    if (next.pr.length === 0 && !commentsActive) {
      onChange(null);
      return;
    }
    onChange({ ...next, skipSelf: skipSelfOverride ?? skipSelf });
  }

  function updateRule(idx: number, next: PrRule) {
    emit({
      pr: rules.map((r, i) => (i === idx ? next : r)),
      ...(comments === false ? {} : { comments }),
    });
  }

  function addRule() {
    emit({
      pr: [...rules, defaultPrRule()],
      ...(comments === false ? {} : { comments }),
    });
  }

  function removeRule(idx: number) {
    emit({
      pr: rules.filter((_, i) => i !== idx),
      ...(comments === false ? {} : { comments }),
    });
  }

  // The PR quick-toggle drives a single preset rule (any bespoke rules live in
  // the cards below). Setting no draft-state clears the PR trigger.
  function setPrPreset(draftStates: Set<DraftState>, authors: Set<Author>) {
    const rule = prPresetRule(draftStates, authors);
    emit({ pr: rule ? [rule] : [], ...(comments === false ? {} : { comments }) });
  }

  function togglePrDraft(s: DraftState) {
    const next = new Set(prDraftStates);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    // Turning the PR trigger on requires an author; default to "any" (both).
    const authors = next.size > 0 && prAuthors.size === 0 ? new Set<Author>(["human", "bot"]) : prAuthors;
    setPrPreset(next, authors);
  }

  function togglePrAuthor(a: Author) {
    const next = new Set(prAuthors);
    if (next.has(a)) next.delete(a);
    else next.add(a);
    // Author is required while a PR trigger is active — clearing both snaps
    // back to "any" rather than producing a rule that matches nobody.
    setPrPreset(prDraftStates, next.size === 0 ? new Set<Author>(["human", "bot"]) : next);
  }

  function clearPr() {
    emit({ pr: [], ...(comments === false ? {} : { comments }) });
  }

  function toggleCommentAuthor(a: Author) {
    const next = new Set(commentAuthors);
    if (next.has(a)) next.delete(a);
    else next.add(a);
    const c = commentsFromAuthors(next);
    emit({ pr: rules, ...(c === null ? {} : { comments: c }) });
  }

  function setSkipSelf(next: boolean) {
    emit(
      {
        pr: rules,
        ...(comments === false ? {} : { comments }),
      },
      next,
    );
  }

  return (
    <div className="space-y-3">
      {/* Quick trigger presets — multi-select toggles over the `on:` config. */}
      <div className="rounded-box border border-base-300 p-3 space-y-2">
        <div className="text-sm font-medium">Quick trigger presets</div>
        <div className="font-mono text-xs text-base-content/50">on:</div>

        {/* pull request: open | draft (both/none) + authored by human | bot */}
        <div className="flex flex-wrap items-center gap-2 pl-3">
          <span className="text-xs text-base-content/70 w-24 shrink-0">pull request:</span>
          <MultiToggle
            options={["open", "draft"]}
            active={prDraftStates}
            onToggle={(id) => togglePrDraft(id as DraftState)}
          />
          {prActive && (
            <>
              <span className="text-xs text-base-content/50">and authored by</span>
              <MultiToggle
                options={["human", "bot"]}
                active={prAuthors}
                onToggle={(id) => togglePrAuthor(id as Author)}
              />
              <ClearButton onClick={clearPr} />
            </>
          )}
        </div>

        {/* comments: human | bot (both/none) */}
        <div className="flex flex-wrap items-center gap-2 pl-3">
          <span className="text-xs text-base-content/70 w-24 shrink-0">comments:</span>
          <MultiToggle
            options={["human", "bot"]}
            active={commentAuthors}
            onToggle={(id) => toggleCommentAuthor(id as Author)}
          />
          {commentAuthors.size > 0 && <ClearButton onClick={() => emit({ pr: rules })} />}
        </div>

        <label className="flex items-center gap-2 text-xs text-base-content/80 mt-1 cursor-pointer">
          <input
            type="checkbox"
            className="checkbox checkbox-xs"
            checked={skipSelf}
            onChange={(e) => setSkipSelf(e.target.checked)}
          />
          Skip hooks generated by this clawdcode user
          <span className="text-base-content/50">
            (prevents the routine from retriggering on its own PRs / comments)
          </span>
        </label>
      </div>

      {rules.length === 0 ? (
        <button type="button" className="btn btn-sm btn-outline" onClick={addRule}>
          <Plus size={14} /> Add PR trigger
        </button>
      ) : (
        <>
          {rules.map((rule, i) => (
            <RuleCard
              // biome-ignore lint/suspicious/noArrayIndexKey: rules are an ordered list with no stable id; index is fine for editor sessions.
              key={i}
              rule={rule}
              index={i}
              onChange={(next) => updateRule(i, next)}
              onRemove={() => removeRule(i)}
            />
          ))}
          <button type="button" className="btn btn-sm btn-outline" onClick={addRule}>
            <Plus size={14} /> Add rule
          </button>
        </>
      )}
    </div>
  );
}

/** Independent multi-select toggle group — each option flips on/off
 *  separately (selecting both or none is valid). */
function MultiToggle({
  options,
  active,
  onToggle,
}: {
  options: string[];
  active: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="join">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          aria-pressed={active.has(opt)}
          onClick={() => onToggle(opt)}
          className={`btn btn-xs join-item ${active.has(opt) ? "btn-primary" : "btn-ghost border-base-300"}`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function ClearButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="btn btn-ghost btn-xs"
      aria-label="Turn off this trigger"
      title="Turn off"
    >
      ×
    </button>
  );
}
