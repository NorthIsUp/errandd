---
name: datadog-recheck-recovery
description: Re-check whether a firing Datadog monitor / the metric that tripped it has recovered, after attempting a remediation. Use when an incident-response agent needs to confirm a fix worked before resolving a page, or to decide whether to escalate. Trigger phrases include "did the alert recover", "re-check the monitor", "is the metric back to normal", "confirm recovery", "check monitor state", "has it recovered", "verify the fix cleared the alert".
---

# Datadog — re-check recovery

Confirm, from Datadog itself, whether a monitor that triggered has returned to
**OK** (and/or the underlying metric is back within threshold). This is the
read step an incident-response flow runs *after* attempting a fix and *before*
deciding to resolve the page or escalate.

## Inputs you need

- **`monitor_id`** — numeric id of the monitor that fired. It is in the alert
  payload (`$ALERT_ID` / `alert_id` / the monitor URL `.../monitors/<id>`).
- Datadog site + credentials from the environment (do **not** hard-code):
  - `DD_SITE` (e.g. `us3.datadoghq.com`; API base is `https://api.$DD_SITE`)
  - `DD_API_KEY`, `DD_APP_KEY`

If the `datadog` MCP server is configured with the `monitors` + `metrics`
toolsets, prefer its tools (`get_monitor`, `query_timeseries`) over raw curl —
same data, no key handling. Fall back to the REST calls below when the MCP
isn't available.

## Step 1 — read the monitor's current state (authoritative)

`GET https://api.$DD_SITE/api/v1/monitor/{monitor_id}` and read
**`overall_state`**:

```bash
curl -sf -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
  "https://api.$DD_SITE/api/v1/monitor/$MONITOR_ID" \
  | jq '{state: .overall_state, name: .name, query: .query}'
```

| `overall_state` | Meaning |
| --------------- | ------- |
| `OK`            | Recovered — the fix worked. Safe to resolve/dismiss the page. |
| `Alert` / `Warn`| Still firing — do **not** resolve; keep working or escalate. |
| `No Data`       | Inconclusive — the metric stopped reporting. Treat as **not recovered** (a service that stopped emitting is not healthy); investigate or escalate. |

**Grouped monitors:** a multi-group monitor is only truly clear when *every*
alerting group is OK. Check `state.groups` (or `overall_state_modified`) and
confirm the specific group named in the alert is `OK`, not just the rollup.

## Step 2 — corroborate with the metric (guards against latch)

`overall_state` can lag or latch (e.g. absent-when-healthy series). Confirm the
actual signal recovered by querying the monitor's own query over the last few
minutes:

```bash
FROM=$(($(date +%s) - 300)); TO=$(date +%s)
curl -sf -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
  "https://api.$DD_SITE/api/v1/query?from=$FROM&to=$TO&query=<monitor metric query>" \
  | jq '.series[].pointlist[-3:]'
```

Take the monitor's `query`, strip the `<aggregation>(<window>):` prefix and the
`> <threshold>` comparator to get the bare metric query, and confirm the recent
points are back on the healthy side of the threshold.

## Step 3 — poll, don't assume

Recovery is rarely instant after a fix (pods reschedule, metrics roll up).
Re-check on a short cadence with a ceiling — e.g. every **30s up to ~5 min**:

- **Recovered** (state `OK` *and* metric healthy for 2 consecutive checks) →
  hand off to **`datadog-resolve-page`** to explicitly dismiss the page.
- **Still firing at the deadline** → hand off to **`datadog-escalate-page`**;
  do not silently give up.

## Step 4 — render the recovered graph (optional, on recovery)

When the verdict is `recovered`, render the tripping metric as an image spanning
the incident so the page thread shows the spike **and** the return to normal in
one graph. Same bare metric query as Step 2; window from just before the trigger
to now:

```bash
START=$(($(date +%s) - 1800)); END=$(date +%s)   # trigger-ish → now (~30m)
curl -sf -G -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
  "https://api.$DD_SITE/api/v1/graph/snapshot" \
  --data-urlencode "metric_query=<bare metric query>" \
  --data-urlencode "start=$START" --data-urlencode "end=$END" \
  | jq -r '.snapshot_url'
```

The returned `snapshot_url` is a PNG that takes a few seconds to become
available. It's a **bonus** — never block or fail recovery on it; if the call
errors, just report the numeric points from Step 2 instead.

## Output

Report: monitor id + name, final `overall_state`, the last few metric points,
the recovery verdict (`recovered` | `still-firing` | `no-data`), the
`snapshot_url` of the recovered graph (when rendered), and the next action taken.
