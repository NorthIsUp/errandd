/**
 * Pulls the "most important" fields out of a webhook payload — the ones the
 * matcher keys on and that get surfaced to the routine prompt. These power
 * the at-a-glance columns in the deliveries table, so each provider returns
 * an ordered list (most significant first).
 */
import { extractSentryTitle, findLinearId, sentryDeliveryPk } from "../../shared/hookPayload";
import type { DeliveryField, DeliveryKeys } from "./deliveries";
import { readDatadogPayload, readLinearPayload, readPrPayload, readSentryPayload } from "./match";

/** Like `readPath` from shared/hookPayload, but additionally stringifies a
 *  numeric/boolean leaf — the deliveries table reads PR numbers, counts, and
 *  flags, not just strings. Kept here (rather than folded into the string-only
 *  shared reader) because the widened return type is load-bearing for these
 *  field extractors. */
function read(obj: unknown, path: string[]): string | null {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) {
      return null;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur === "string") {
    return cur;
  }
  if (typeof cur === "number" || typeof cur === "boolean") {
    return String(cur);
  }
  return null;
}

function push(out: DeliveryField[], label: string, value: string | null | undefined): void {
  if (value != null && value !== "") {
    out.push({ label, value });
  }
}

const COMMENT_EVENTS = new Set([
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
]);

const CHECK_EVENTS = new Set(["check_run", "check_suite", "workflow_run", "workflow_job"]);

/** The payload key that wraps a check event's fields — for all four CI events
 *  the wrapper node is named for the event itself. */
function checkBase(event: string): string {
  return event;
}

/** The head branch of a check event (check_suite has it directly; check_run
 *  carries it under its nested check_suite). */
function checkBranch(event: string, payload: unknown): string | null {
  const base = checkBase(event);
  return (
    read(payload, [base, "head_branch"]) ?? read(payload, [base, "check_suite", "head_branch"])
  );
}

/** Short 7-char form of a commit SHA, or null. */
function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null;
}

/** Provider-specific extraction of the headline fields for a delivery. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one branch per provider/event shape — flattening into helpers just scatters the field order.
export function extractHookFields(event: string, payload: unknown): DeliveryField[] {
  const out: DeliveryField[] = [];

  if (event.startsWith("sentry:")) {
    const sp = readSentryPayload(payload);
    if (sp) {
      // shortId (CLARA-BACKEND-T1) is the human ticket id — surface it first.
      push(out, "shortId", sp.shortId);
      push(out, "project", sp.project);
      push(out, "level", sp.level);
      // environment + host explain why an event was/wasn't filtered.
      push(out, "environment", sp.environment);
      push(out, "host", sp.serverName);
      push(out, "action", sp.action);
    }
    // Title chain spans resource shapes (issue/event/error) — prod traffic is
    // mostly `sentry:error` events, which carry data.error.title, not
    // data.issue.title; reading only the latter left rows labeled `issue <id>`.
    push(out, "issue", extractSentryTitle(payload));
    return out;
  }

  if (event.startsWith("datadog:")) {
    const dp = readDatadogPayload(payload);
    if (dp) {
      push(out, "monitor", dp.monitor);
      push(out, "priority", dp.priority);
      push(out, "type", dp.type);
      if (dp.tags.length > 0) {
        push(out, "tags", dp.tags.join(", "));
      }
    }
    push(out, "title", read(payload, ["title"]));
    return out;
  }

  if (event.startsWith("linear:") || event === "linear") {
    const lp = readLinearPayload(payload);
    // identifier (ENG-123) first — it's the headline id; then the why-it-fired
    // facts mirroring the sentry/datadog branch style.
    push(out, "identifier", lp.identifier);
    push(out, "title", lp.title);
    push(out, "state", lp.state);
    push(out, "priority", lp.priorityLabel);
    push(out, "assignee", lp.assignee);
    push(out, "team", lp.team);
    push(out, "action", lp.action);
    if (lp.labels.length > 0) {
      push(out, "labels", lp.labels.join(", "));
    }
    return out;
  }

  // GitHub
  if (event === "pull_request") {
    const pr = readPrPayload(payload);
    const num = read(payload, ["pull_request", "number"]);
    push(out, "repo", pr?.repo);
    push(out, "PR", num ? `#${num}` : null);
    push(out, "title", read(payload, ["pull_request", "title"]));
    push(out, "linear", linearTaskId(payload));
    push(out, "action", pr?.action);
    push(out, "author", pr?.user);
    push(out, "base", pr?.baseBranch);
    if (pr?.draft) {
      push(out, "draft", "true");
    }
    if (pr && pr.labels.length > 0) {
      push(out, "labels", pr.labels.join(", "));
    }
    return out;
  }

  if (COMMENT_EVENTS.has(event)) {
    push(out, "repo", read(payload, ["repository", "full_name"]));
    const num = read(payload, ["issue", "number"]) ?? read(payload, ["pull_request", "number"]);
    push(out, "PR", num ? `#${num}` : null);
    push(
      out,
      "title",
      read(payload, ["pull_request", "title"]) ?? read(payload, ["issue", "title"]),
    );
    push(out, "linear", linearTaskId(payload));
    push(out, "action", read(payload, ["action"]));
    push(out, "actor", read(payload, ["sender", "login"]));
    const body = read(payload, ["comment", "body"]) ?? read(payload, ["review", "body"]);
    if (body) {
      push(out, "comment", body.length > 80 ? `${body.slice(0, 80)}…` : body);
    }
    return out;
  }

  if (CHECK_EVENTS.has(event)) {
    const base = checkBase(event);
    push(out, "repo", read(payload, ["repository", "full_name"]));
    push(out, "check", read(payload, [base, "name"]) ?? read(payload, [base, "app", "name"]));
    push(out, "status", read(payload, [base, "status"]));
    push(out, "conclusion", read(payload, [base, "conclusion"]));
    push(out, "branch", checkBranch(event, payload));
    push(out, "sha", shortSha(read(payload, [base, "head_sha"])));
    const prNum = read(payload, [base, "pull_requests", "0", "number"]);
    if (prNum) {
      push(out, "PR", `#${prNum}`);
    }
    push(out, "linear", linearTaskId(payload));
    return out;
  }

  if (event === "issues") {
    push(out, "repo", read(payload, ["repository", "full_name"]));
    const num = read(payload, ["issue", "number"]);
    push(out, "issue", num ? `#${num}` : null);
    push(out, "title", read(payload, ["issue", "title"]));
    push(out, "action", read(payload, ["action"]));
    push(out, "author", read(payload, ["issue", "user", "login"]));
    return out;
  }

  // Other GitHub events (push, ping, …) — repo + actor are usually all there is.
  push(out, "repo", read(payload, ["repository", "full_name"]));
  push(out, "actor", read(payload, ["sender", "login"]));
  return out;
}

/** A Linear task id (e.g. `ENG-123`) referenced by a GitHub PR, pulled from
 *  the head branch (Linear's `<team>-<n>` branch convention), the PR/issue
 *  title, or the body. Returns the uppercased id, or null if none. Uses the
 *  shared loose `findLinearId` (the single Linear-id regex). */
function linearTaskId(payload: unknown): string | null {
  const candidates = [
    read(payload, ["pull_request", "head", "ref"]),
    read(payload, ["pull_request", "title"]),
    read(payload, ["issue", "title"]),
    read(payload, ["pull_request", "body"]),
    // check_run / check_suite carry the branch instead of a PR head ref.
    read(payload, ["check_suite", "head_branch"]),
    read(payload, ["check_run", "check_suite", "head_branch"]),
  ];
  for (const c of candidates) {
    const id = findLinearId(c);
    if (id) {
      return id;
    }
  }
  return null;
}

/** The delivery's "primary key" — a short headline identifier shown in its own
 *  column. GitHub: PR number (or the head/ref branch); Sentry: the issue/error
 *  id; Datadog: best-effort monitor/aggregation id (TBD). */
export function extractHookPk(event: string, payload: unknown): string {
  if (event.startsWith("sentry:")) {
    // Prefer the ISSUE id over per-event ids — the issue is the subject
    // (threads coalesce on `sentry-issue-<id>`, and the UI organizes by it).
    // Event ids are a last resort for payloads that carry nothing else. The
    // canonical path ordering lives in shared/hookPayload (sentryDeliveryPk).
    return sentryDeliveryPk(payload);
  }
  if (event.startsWith("datadog:")) {
    // Keying TBD — fall back to the monitor / aggregation id for now.
    return (
      read(payload, ["monitor_id"]) ??
      read(payload, ["alert_id"]) ??
      read(payload, ["aggreg_key"]) ??
      read(payload, ["id"]) ??
      ""
    );
  }
  if (event.startsWith("linear:") || event === "linear") {
    // The issue identifier (ENG-123) is the subject — threads coalesce on it.
    return readLinearPayload(payload).identifier;
  }
  // check_run / check_suite: PR number from the check's pull_requests, else the
  // head branch, else the short head SHA (often the only handle a check has).
  if (CHECK_EVENTS.has(event)) {
    const base = checkBase(event);
    const checkPr = read(payload, [base, "pull_requests", "0", "number"]);
    if (checkPr) {
      return `#${checkPr}`;
    }
    return checkBranch(event, payload) ?? shortSha(read(payload, [base, "head_sha"])) ?? "";
  }
  // GitHub: prefer the PR number, else the branch (head ref for PRs, `ref` for
  // pushes, issue number for plain issue comments).
  const prNum = read(payload, ["pull_request", "number"]) ?? read(payload, ["issue", "number"]);
  if (prNum) {
    return `#${prNum}`;
  }
  const branch =
    read(payload, ["pull_request", "head", "ref"]) ?? stripRefsHeads(read(payload, ["ref"]));
  return branch ?? "";
}

function stripRefsHeads(ref: string | null): string | null {
  if (!ref) {
    return null;
  }
  return ref.replace(/^refs\/heads\//, "");
}

/** The two headline "keys" shown as their own columns. GitHub: the action and
 *  the PR#/branch. Sentry: level + action. Datadog: priority + alert type. */
export function extractHookKeys(event: string, payload: unknown): DeliveryKeys {
  if (event.startsWith("sentry:")) {
    const sp = readSentryPayload(payload);
    return {
      key1Label: "level",
      key1: sp?.level ?? "",
      key2Label: "action",
      key2: sp?.action ?? "",
    };
  }
  if (event.startsWith("datadog:")) {
    const dp = readDatadogPayload(payload);
    return {
      key1Label: "priority",
      key1: dp?.priority ?? "",
      key2Label: "type",
      key2: dp?.type ?? "",
    };
  }
  if (event.startsWith("linear:") || event === "linear") {
    const lp = readLinearPayload(payload);
    return {
      key1Label: "action",
      key1: lp.action,
      key2Label: "id",
      key2: lp.identifier,
    };
  }
  // GitHub: the action (opened / synchronize / created / …) and the
  // PR#/branch (reuses the pk derivation).
  return {
    key1Label: "action",
    key1: read(payload, ["action"]) ?? "",
    key2Label: "pr/branch",
    key2: extractHookPk(event, payload),
  };
}
