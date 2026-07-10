import type { DeliveryBase, DeliveryKeys } from "../../../shared/deliveryTypes";
import type { QueueMessage } from "../../api/hooks";

/**
 * Canonical identity key for matching a {@link DeliveryBase} to the
 * {@link QueueMessage}s (chat threads) it spawned.
 *
 * Both shapes carry the same structured discriminators — a PR number and the
 * two extracted `keys` (key1/key2) — under slightly different field names
 * (`Delivery.pk` is a string PR/issue id; `QueueMessage.prNumber` is the
 * numeric PR). This derives the SAME string from either side so a delivery and
 * a queue row can be matched by equality (a Map lookup) instead of the old
 * `scope.includes()` substring heuristic, which risked matching the wrong
 * thread.
 *
 * Provider nuance — sentry: the subject identity is the ISSUE id (`pk` on the
 * delivery, `sentry-issue-<id>` scope on the queue row). key1/key2 hold
 * *state* (level + action) that changes across the issue's lifecycle; folding
 * them in meant a `resolved` delivery computed a different key than the
 * `created` delivery whose thread it belongs to, so the UI failed to associate
 * them. Datadog has the same state-in-keys shape but its pk (monitor id) and
 * scope (aggregation key, slugified) derive from different fields, so a
 * symmetric provider key isn't reliably available — it stays on the generic
 * key until pk/scope are aligned. GitHub keeps the full key: its pk (PR
 * number) is not globally unique across repos.
 *
 * Returns `null` when the value carries no discriminator at all (no PR, no
 * keys) — callers fall back to job-name match alone for those.
 */
export function deliveryIdentityKey(
  d: Pick<DeliveryBase, "pk" | "keys" | "event">,
): string | null {
  if (d.event.startsWith("sentry")) {
    const pk = prToken(d.pk ?? null);
    if (pk != null) {
      return `sentry:${pk}`;
    }
  }
  return buildKey(prToken(d.pk ?? null), d.keys);
}

export function queueIdentityKey(
  m: Pick<QueueMessage, "prNumber" | "keys" | "event" | "scope">,
): string | null {
  if (m.event.startsWith("sentry")) {
    const issueId = m.scope?.startsWith("sentry-issue-")
      ? m.scope.slice("sentry-issue-".length)
      : null;
    if (issueId) {
      return `sentry:${issueId}`;
    }
  }
  return buildKey(prToken(m.prNumber ?? null), m.keys);
}

/** Normalize a PR/issue discriminator from either `pk` (string) or
 *  `prNumber` (number) to the same string token. */
function prToken(pr: string | number | null): string | null {
  if (pr == null) {
    return null;
  }
  const s = String(pr).trim();
  return s.length > 0 ? s : null;
}

function buildKey(pr: string | null, keys: DeliveryKeys | undefined): string | null {
  const k1 = keys?.key1?.trim() || null;
  const k2 = keys?.key2?.trim() || null;
  if (pr == null && k1 == null && k2 == null) {
    return null;
  }
  return `pr=${pr ?? ""}|k1=${k1 ?? ""}|k2=${k2 ?? ""}`;
}
