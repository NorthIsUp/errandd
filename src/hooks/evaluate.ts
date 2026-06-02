/**
 * Pulls the "most important" fields out of a webhook payload — the ones the
 * matcher keys on and that get surfaced to the routine prompt. These power
 * the at-a-glance columns in the deliveries table, so each provider returns
 * an ordered list (most significant first).
 */
import type { DeliveryField } from "./deliveries";
import { readDatadogPayload, readPrPayload, readSentryPayload } from "./match";

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

/** Provider-specific extraction of the headline fields for a delivery. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one branch per provider/event shape — flattening into helpers just scatters the field order.
export function extractHookFields(event: string, payload: unknown): DeliveryField[] {
  const out: DeliveryField[] = [];

  if (event.startsWith("sentry:")) {
    const sp = readSentryPayload(payload);
    if (sp) {
      push(out, "project", sp.project);
      push(out, "level", sp.level);
      push(out, "action", sp.action);
    }
    push(out, "issue", read(payload, ["data", "issue", "title"]));
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

  // GitHub
  if (event === "pull_request") {
    const pr = readPrPayload(payload);
    push(out, "repo", pr?.repo);
    push(
      out,
      "PR",
      read(payload, ["pull_request", "number"])
        ? `#${read(payload, ["pull_request", "number"])}`
        : null,
    );
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
    push(out, "action", read(payload, ["action"]));
    push(out, "actor", read(payload, ["sender", "login"]));
    const body = read(payload, ["comment", "body"]) ?? read(payload, ["review", "body"]);
    if (body) {
      push(out, "comment", body.length > 80 ? `${body.slice(0, 80)}…` : body);
    }
    return out;
  }

  // Other GitHub events (push, ping, …) — repo + actor are usually all there is.
  push(out, "repo", read(payload, ["repository", "full_name"]));
  push(out, "actor", read(payload, ["sender", "login"]));
  return out;
}
