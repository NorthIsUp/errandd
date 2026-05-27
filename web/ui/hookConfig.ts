/**
 * Client-side mirror of the `on:` hook-config schema.
 *
 * The server-side source of truth is `src/hooks/schema.ts`. Types and
 * defaults must stay in sync. We can't import that file from web because
 * it's wired into the daemon — so we mirror the shape here and re-parse
 * the YAML frontmatter on the client.
 */

import { parse as parseYaml } from "yaml";

export type DraftValue = boolean | "any";

export interface PrRule {
  repo: string | string[];
  user: string[];
  action: string[];
  branch: string[];
  labels: string[];
  draft: DraftValue;
}

export interface HookConfig {
  pr: PrRule[];
}

export const DEFAULT_PR_ACTIONS = ["opened", "synchronize", "reopened"];

export const ALL_PR_ACTIONS = [
  "opened",
  "synchronize",
  "reopened",
  "closed",
  "edited",
  "labeled",
  "unlabeled",
  "ready_for_review",
  "converted_to_draft",
];

/** Best-effort defaults for a new rule. */
export function defaultPrRule(): PrRule {
  return {
    repo: "",
    user: ["*", "!*[bot]"],
    action: [...DEFAULT_PR_ACTIONS],
    branch: ["*"],
    labels: [],
    draft: false,
  };
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/**
 * Parse the `on:` block out of a job's frontmatter. Returns null when:
 * - no frontmatter present
 * - no `on:` key
 * - YAML is malformed (silently — the editor falls back to "Add PR trigger")
 */
export function parseOnBlock(content: string): HookConfig | null {
  const m = content.match(FRONTMATTER_RE);
  if (!m) {
    return null;
  }
  const block = m[1] ?? "";
  let parsed: unknown;
  try {
    parsed = parseYaml(block);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const on = (parsed as Record<string, unknown>).on;
  if (on === undefined || on === null) {
    return null;
  }
  if (typeof on !== "object" || Array.isArray(on)) {
    return null;
  }
  const pr = (on as Record<string, unknown>).pr;
  if (pr === undefined) {
    return { pr: [] };
  }
  const list = Array.isArray(pr) ? pr : [pr];
  const rules: PrRule[] = [];
  for (const raw of list) {
    const rule = normalizeRule(raw);
    if (rule) {
      rules.push(rule);
    }
  }
  return { pr: rules };
}

function normalizeRule(raw: unknown): PrRule | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const repo = asStringOrList(obj.repo) ?? "";
  const user = asList(obj.user);
  const action = obj.action === undefined ? [...DEFAULT_PR_ACTIONS] : asList(obj.action);
  const branch = obj.branch === undefined ? ["*"] : asList(obj.branch);
  const labels = obj.labels === undefined ? [] : asList(obj.labels);
  let draft: DraftValue = false;
  const d = obj.draft;
  if (d === true || d === "true") {
    draft = true;
  } else if (d === "any") {
    draft = "any";
  }
  return { repo, user, action, branch, labels, draft };
}

function asStringOrList(v: unknown): string | string[] | null {
  if (typeof v === "string") {
    return v;
  }
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    return v as string[];
  }
  return null;
}

function asList(v: unknown): string[] {
  if (v === undefined || v === null) {
    return [];
  }
  if (typeof v === "string") {
    return [v];
  }
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string");
  }
  return [];
}
