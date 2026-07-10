---
name: datadog-resolve-page
description: Explicitly dismiss/resolve a Datadog On-Call page after confirming the underlying monitor has recovered. Use when an incident-response agent has fixed the problem and needs to close out the page rather than leave it for a human or rely on auto-resolve. Trigger phrases include "resolve the page", "dismiss the alert", "close the page", "clear the alert", "mark resolved", "the fix worked resolve it", "dismiss the datadog page".
---

# Datadog — resolve / dismiss a page

Explicitly close out a page once the problem is fixed. Pages should be
**explicitly dismissed**, not left to time out — but only after recovery is
*confirmed*. Runs after `datadog-recheck-recovery` returns `recovered`.

## Hard preconditions — do NOT resolve unless all hold

1. **Recovery is confirmed.** `datadog-recheck-recovery` reported `overall_state:
   OK` *and* the metric is healthy for ≥2 consecutive checks. Never dismiss a
   page whose monitor is still `Alert`/`Warn`/`No Data`.
2. **The right group.** For grouped monitors, the *specific* alerting group named
   in the page recovered — not just the rollup.
3. **You own the resolution.** If the page was already **escalated** to a human
   (`datadog-escalate-page`), do **not** auto-resolve it — the human owns it.
   Resolving out from under on-call hides a real incident.

If any precondition fails → stop; keep working or escalate instead.

## Inputs

- **`page_id`** (UUID, Datadog On-Call) and/or **`monitor_id`** from the payload.
- Env creds: `DD_SITE`, `DD_API_KEY`, `DD_APP_KEY`.

## Action — resolve the On-Call page (explicit dismissal)

Bodyless POST; returns **202 Accepted**:

```bash
curl -sf -X POST \
  -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
  "https://api.$DD_SITE/api/v2/on-call/pages/$PAGE_ID/resolve"
```

(There is also `.../pages/$PAGE_ID/acknowledge` — use ack, not resolve, if you're
actively working an issue and want to stop re-notification without closing it.)

> Host note: served on `api.$DD_SITE`. If that 404s for `/api/v2/on-call/*`,
> retry against the regional On-Call cell host in `DD_ONCALL_HOST`
> (`*.oncall.datadoghq.com`).

## No On-Call page (monitor-only alert)

A monitor-driven alert with no standalone page auto-resolves the instant the
monitor returns to `OK` (already confirmed by precondition 1). Make the closure
explicit and auditable with a resolution event — do **not** substitute monitor
*mute* (mute only silences a still-firing monitor and hides real problems):

```bash
curl -sf -X POST \
  -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
  -H "Content-Type: application/json" \
  "https://api.$DD_SITE/api/v1/events" \
  -d "{\"title\":\"✅ Resolved: $ALERT_TITLE — recovered after L1 remediation\",\"text\":\"Monitor https://app.$DD_SITE/monitors/$MONITOR_ID is back to OK. Fix: $SUMMARY_OF_FIX${PR:+ (PR #$PR)}. Verified overall_state=OK + metric healthy for 2 checks.\",\"alert_type\":\"success\",\"tags\":[\"source:errandd\",\"resolution:auto\",\"monitor_id:$MONITOR_ID\"]}"
```

## After resolving

Summarize: which page/monitor, the confirmed recovery evidence, the fix (link
the PR), and that the page was explicitly dismissed (HTTP 202).
