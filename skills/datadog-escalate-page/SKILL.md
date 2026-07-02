---
name: datadog-escalate-page
description: Explicitly escalate a Datadog On-Call page (or proactively page on-call) when an automated first-responder cannot safely resolve an alert. Bumps an existing page to the next escalation tier, or creates a new page targeting the on-call team, so a human is engaged now instead of waiting for the next timed tier. Use when an agent gives up, is unsure, or the fix did not recover the monitor. Trigger phrases include "escalate the page", "escalate to on-call", "page a human", "notify on-call", "hand off to on-call", "I can't fix this alert", "escalate the incident".
---

# Datadog — escalate to on-call

Explicitly engage a **human** when the automated first responder (L1) cannot
safely resolve the alert. Don't just stop and wait for the timed 2nd tier — act,
with context, so on-call gets a head start.

## When to escalate (do this, don't silently give up)

- The fix attempt did **not** recover the monitor (see `datadog-recheck-recovery`).
- Root cause is outside what you can safely change (data-loss risk, secrets,
  infra you don't own, anything ambiguous).
- You're **uncertain** — err toward escalating. A false page is cheaper than a
  missed outage.

## Inputs

- **`page_id`** (UUID) if a Datadog On-Call page already exists for this alert —
  it's in the webhook payload. If absent, you'll create one.
- **Target** for a new page: on-call **team handle** (default `DD_ONCALL_TEAM`),
  or a specific `user_id`.
- Env creds: `DD_SITE` (e.g. `us3.datadoghq.com`; API base `https://api.$DD_SITE`),
  `DD_API_KEY`, `DD_APP_KEY`.

## Action A — escalate an existing page to the next tier (preferred)

Bodyless POST; returns **202 Accepted**. Keeps one page thread and its ack state.

```bash
curl -sf -X POST \
  -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
  "https://api.$DD_SITE/api/v2/on-call/pages/$PAGE_ID/escalate"
```

## Action B — no page yet: create one targeting on-call

Use when L1 decides to page *before* the timed human tier would fire. `target`,
`title`, `urgency` are required; `urgency: high` actually pages the rotation.

```bash
curl -sf -X POST \
  -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
  -H "Content-Type: application/json" \
  "https://api.$DD_SITE/api/v2/on-call/pages" \
  -d @- <<JSON
{ "data": { "type": "pages", "attributes": {
  "title": "L1 could not resolve: $ALERT_TITLE",
  "urgency": "high",
  "target": { "type": "team_handle", "identifier": "$DD_ONCALL_TEAM" },
  "description": "Automated first-responder could not recover this alert.\nMonitor: https://app.$DD_SITE/monitors/$MONITOR_ID\nService: $SERVICE ($NAMESPACE)\nTried: $WHAT_WAS_TRIED\nState: $CURRENT_STATE\nWhy escalating: $REASON",
  "tags": ["source:clawdcode","escalation:oncall","monitor_id:$MONITOR_ID","service:$SERVICE"]
} } }
JSON
```

`target.type` may be `team_handle`, `team_id`, or `user_id`. The response `data.id`
is the new `page_id` — record it.

## Fallback — org not on Datadog On-Call

If On-Call isn't in use, post a Datadog **event** whose `text` `@`-mentions the
on-call handle (mentions are parsed from the body, not the title):

```bash
curl -sf -X POST \
  -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
  -H "Content-Type: application/json" \
  "https://api.$DD_SITE/api/v1/events" \
  -d "{\"title\":\"🚨 Escalation: $ALERT_TITLE\",\"text\":\"$DD_ONCALL_HANDLE L1 could not recover. Monitor: https://app.$DD_SITE/monitors/$MONITOR_ID • Tried: $WHAT_WAS_TRIED • Why: $REASON\",\"alert_type\":\"error\",\"tags\":[\"source:clawdcode\",\"escalation:oncall\"]}"
```

> Host note: On-Call is served on the standard `api.$DD_SITE` host. Some orgs
> use a regional On-Call cell host (`*.oncall.datadoghq.com`); if `api.$DD_SITE`
> returns 404 for `/api/v2/on-call/*`, retry against the cell host from
> `DD_ONCALL_HOST`.

## After escalating

- Record the `page_id` / event id and **stop trying to fix** unless you have a
  genuinely safe, high-confidence action.
- Do **not** resolve/dismiss the page — a human owns it now.
- Summarize: what fired, what you tried, why you escalated, the id.
