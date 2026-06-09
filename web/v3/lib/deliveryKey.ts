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
 * Returns `null` when the value carries no discriminator at all (no PR, no
 * keys) — callers fall back to job-name match alone for those.
 */
export function deliveryIdentityKey(
  d: Pick<DeliveryBase, "pk" | "keys">,
): string | null {
  return buildKey(prToken(d.pk ?? null), d.keys);
}

export function queueIdentityKey(
  m: Pick<QueueMessage, "prNumber" | "keys">,
): string | null {
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
