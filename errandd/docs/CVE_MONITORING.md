# CVE monitoring

In **Errands → Add CVE errand**, select the repositories and filters, then enable and save the errand. The preset starts disabled. `current` means Errandd's configured working repository, not the repository containing the errand Markdown. Additional targets are explicit `owner/repo` names. Existing cached GitHub repositories appear as checkboxes; other repositories can be added by name.

The default prompt assesses applicability, reports evidence, and, only when affected, fixes the code, runs checks, and opens or updates a PR. It does not merge or deploy. The agent needs checkout access and PR permissions for each selected repository. Edit the prompt to change this behavior.

```yaml
---
enabled: true
notify: error
on:
  - cve:
      repositories: [current, NorthIsUp/errandd]
      severity: [high, critical]
      ecosystem: [npm, pypi]
      language: [typescript, python]
      technology: ['*react*', '*django*']
      includeUnclassified: true
      poll: true
---
Assess the incoming CVE against the selected target repository. If affected,
fix it, run relevant checks, and open or update a PR with evidence.
```

## Structured filters

Fields combine with AND; positive values within a field combine with OR. Matching is case insensitive and supports `*` globs. Prefix a pattern with `!` to exclude it. An empty optional filter matches all values. No selected repositories or severities means no assessment runs.

- `severity`: critical, high, medium, low, unknown, or `*`. Defaults to high and critical.
- `ecosystem`: package ecosystems from Package URLs or explicit metadata, such as npm, pypi, maven, cargo, golang, gem, composer or nuget.
- `language`: inferred from package ecosystems, e.g. npm → javascript/typescript, pypi → python, cargo → rust. This is an approximation, not source-code analysis.
- `technology`: structured product, vendor, package, module, platform and CPE identifiers; includes ecosystem names.
- `product` and `vendor`: matched together against the same affected product entry.
- `project`: CVEFeed project slug or ID; official records have no project.
- `includeUnclassified`: include records missing ecosystem/language/technology metadata when those filters are set. Defaults true to avoid silently losing unclassified CVEs. Turn off for strict filtering.

Descriptions are not used to guess a programming language. CNA and ADP affected-product metadata are both processed. These filters reduce which advisories reach the agent; they do not prove the repository is vulnerable.

## Official feed

Errandd polls the [official CVE JSON repository](https://github.com/CVEProject/cvelistV5) every five minutes by default when the connection permits polling and an enabled CVE errand has polling and at least one target and severity. The upstream repository updates about every seven minutes. No CVEFeed subscription or webhook secret is needed.

The first enabled poll captures the current commit and starts with subsequent updates, without replaying the historical catalogue. SQL stores the commit cursor, partial-batch position, poll status and compact per-errand/repository/CVE receipts. A restart resumes missed batches in chronological order; each poll processes at most 100 records and 25 commits. The full catalogue and rolling delta log are not downloaded or stored. HTTP failures retain the cursor for retry. Diverged upstream history is reported rather than silently resetting it.

`GH_TOKEN` or `GITHUB_TOKEN`, when set, authenticates only requests to the GitHub API. Public reads also work without a token, subject to GitHub's anonymous API limits. Tokens are not sent to the raw-file host.

## Optional CVEFeed webhook

Configure CVEFeed JSON alerts to POST to `/api/webhooks/cvefeed` (alias `/api/webhooks/cve`). Set `ERRANDD_CVEFEED_WEBHOOK_SECRET` to the secret CVEFeed shows for this endpoint and restart Errandd. The endpoint is disabled until the secret is configured. Only the exact `X-Webhook-Secret` header is accepted; URL tokens are not accepted. [CVEFeed sends a shared secret, not an HMAC](https://docs.cvefeed.io/integrations/webhooks/).

The same filters and selected repositories apply to webhook alerts. Set `poll: false` for webhook-only monitoring. CVEFeed's canned test payload is acknowledged without starting remediation. Rejected CVEs are skipped. Durable receipts and deterministic queue IDs prevent repeated delivery of the same revision from starting duplicate work, including partial fan-out retries.

Agents treat incoming advisory text and reference links as untrusted evidence, verify applicability from primary sources and resolved dependencies, and check for an existing CVE fix PR before creating another.

## Connection settings

In **Settings → Event sources → CVEs**, choose **Webhook**, **Poll feed**, or **Both**, a polling interval (1–1440 minutes), and the official feed or an RSS/Atom feed URL. Review and save the connection settings. These settings live in SQL and apply without restarting; credential environment changes still require a deployment restart.

Existing installations default to Both, preserving the previous webhook + per-errand polling behavior. A legacy errand with `poll: false` remains opted out; its editor offers **Allow connection polling**. Connection settings never rewrite repository targets, advisory filters, or prompts in errand files. In Poll feed mode, authenticated webhook deliveries are acknowledged with 202 and do not start work.

RSS/Atom entries supply CVE IDs, not agent instructions. Errandd resolves changed entries to official CVE JSON before applying structured filters. The first feed read establishes a baseline without running historical advisories. RSS catch-up is limited to entries the publisher retains; the official JSON feed is the option for durable historical catch-up. Use the final feed URL; redirects are not followed. Feed checks validate access/parsing without queueing agents or changing sync cursors.

Polled advisories that trigger an errand appear in **Event activity**, alongside webhook deliveries. Unmatched feed records are not retained as full activity payloads.
