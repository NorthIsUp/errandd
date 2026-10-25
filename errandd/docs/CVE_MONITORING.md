# CVE monitoring

In **Errands → choose a library → Subscribe to CVEs**, select the repositories and filters, then save the errand. New repository subscriptions start enabled. `current` means Errandd's configured working repository, not the repository containing the errand Markdown. Additional targets are explicit `owner/repo` names. Existing cached GitHub repositories appear as checkboxes; other repositories can be added by name.

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

The first enabled poll captures the current commit and starts with subsequent updates, without replaying the historical catalogue. SQL stores the commit cursor, partial-batch position, poll status and compact advisory/repository assessment receipts. A restart resumes missed batches in chronological order; each poll processes at most 100 records and 25 commits. The full catalogue and rolling delta log are not downloaded or stored. HTTP failures retain the cursor for retry. Diverged upstream history is reported rather than silently resetting it.

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

## GitHub Advisory discovery and deduplication

**Settings → Event sources → CVEs → GitHub Security Advisories** adds reviewed GitHub advisories alongside the selected official/RSS feed. It defaults on when polling is allowed; both the connection's webhook-only mode and each errand's `poll: false` disable this discovery. The same polling interval and existing severity, ecosystem, language, technology, product, and repository filters apply. GitHub `pip`, `rust`, `go`, and `rubygems` metadata is normalized to `pypi`, `cargo`, `golang`, and `gem`.

The first enabled pass establishes a timestamp baseline, without creating historical jobs. Later passes read at most 100 advisories, resume pagination in a fixed time window, and preserve the last acknowledged cursor on HTTP/rate-limit/queue failures. GitHub and official/RSS discovery run independently so one source failing does not block the other. Public reads need no additional credentials; existing `GH_TOKEN`/`GITHUB_TOKEN` credentials are sent only to the fixed GitHub API endpoint.

Advisories without a CVE ID are supported using their GHSA ID. SQL stores one canonical record, CVE/GHSA aliases, and the latest relevant observation from each source. A later CVE assignment reported in GitHub's structured identifiers merges into the existing identity. Reference links alone never assert shared identity, since an advisory can cite related vulnerabilities. Source URLs and reference links (including NVD, Django, or Next.js maintainer advisories when provided upstream) remain evidence on the record, not independent remediation triggers. These vendor pages are not separately scraped.

Assessments are deduplicated per advisory and configured repository target, across overlapping errands, webhooks, and poll feeds. The first matching errand supplies the prompt. `current` and an explicit `owner/repo` remain distinct configured targets; avoid listing both for the same checkout. Queuing is serialized through acknowledgement; partial failures retry only unfinished targets with deterministic queue IDs. Alias writes are transactional. Previous-version `cve-receipts` are recognized and retained; existing feed cursors and other SQL data are not rewritten.

A source's first observation enriches an existing assessment. Reference, wording, timestamp, and ordering changes do not create more work. For subsequent material changes, GitHub's structured package data takes precedence when available, followed by official CNA/ADP data, then CVEFeed. Changes to the authoritative source's affected/fixed versions, severity, or classification can trigger reassessment. Mirror updates from lower-priority sources only enrich evidence. Withdrawn/rejected records stop remediation. If separate advisories were assessed before an upstream source supplied their shared alias, already-started work cannot be undone, but future deliveries are merged.

Only advisories matching an enabled errand, and updates to already-tracked records, are retained. The complete advisory catalogue is not mirrored. Records, cursors, and receipts use the existing SQL JSON columns and transparent SQLite-zstd compression; no new file store or destructive schema migration is introduced.

## Subscribe by repository dependencies or technology

Start in **Settings → Event sources → CVEs → CVE subscriptions**, then select **Subscribe to CVEs / manage subscriptions**. In Errands, choose the library in which to save the errand, click **Subscribe to CVEs**, select target repositories and save the subscription. Monitoring starts enabled by default; existing explicitly disabled errands remain disabled. Repeated clicks create separate subscription files rather than overwriting an existing one.

New subscriptions default to **Anything in my lockfiles**, historical coverage and automatic clearing, with every severity selected. Existing CVE errands retain their previous feed-only behavior unless edited. The subscription editor also accepts language, web-server, technology, ecosystem, package/product and vendor filters. Fields combine with AND; values within a field combine with OR. With lockfile mode on, filters narrow the dependency scan. With it off, they select advisories for agent assessment.

The checked-in YAML equivalent is:

```yaml
on:
  - cve:
      repositories: [current, example/backend]
      severity: ['*']
      lockfiles: true
      history: true
      autoResolve: true
      poll: true
```

### Anything in my lockfiles

A checksum-pinned **OSV-Scanner 2.7.0** extracts resolved dependencies in offline mode. Errandd then queries OSV's exact package-version API, with **no advisory-publication date cutoff**, and hydrates matching records. This covers direct and transitive locked dependencies, including old CVEs still affecting installed versions. It does not execute repository install scripts, resolve dependencies, run Rust/Go call analysis, or use repository suppression configuration. OSV aliases are merged before remediation dispatch.

Supported files include Bun, npm, pnpm, Yarn, Python uv/Poetry/Pipfile/pdm/pylock/pinned requirements, Cargo, Go modules, Composer, Ruby, .NET, Conan, Dart, Elixir, R and Gradle lockfiles. Packages without resolved versions, unsupported files, incomplete trees, oversized snapshots, malformed results, missing scanner binaries, network errors and partial scans produce an error; they never produce an automatic clean bill of health. Empty coverage does not clear old findings.

`current` scans Errandd's current Git working repository, including nested tracked and unignored lockfiles. Explicit `owner/repo` targets read only dependency blobs at a pinned default-branch commit via the existing `gh` credentials. No repository clones are retained. Temporary snapshot files are removed after scanning; SQL stores the compact package inventory, relevant advisory metadata, findings and status. Unchanged inventories are reused for subsequent exact-version queries.

The scanner is included in the Docker image. Source installations run `bun run setup:osv-scanner`, or configure an existing binary with `ERRANDD_OSV_SCANNER`. Public OSV requests contain package names, versions and ecosystems; repository credentials are used only by `gh`, not sent to OSV.

### Historical languages, web servers and technologies

When lockfile mode is off and **Include historical advisories** is on, Errandd backfills reviewed GitHub advisories for selected language/package ecosystems and NVD records for explicit web-server, technology and product keywords. For example, Python maps to GitHub's pip ecosystem; nginx or OpenSSL searches NVD's historical records. Existing structured filters still apply after discovery. Keyword matches are candidates, not proof the selected repository is vulnerable; the agent verifies applicability before changing code.

Each poll processes at most one historical page (100 advisories) and one lockfile repository, rotating among subscriptions and repositories. History cursors and errors survive restarts, queue failures do not discard a page, and SQL receipts prevent replays from duplicating assessments. Anonymous NVD calls are spaced by at least 6.5 seconds; `ERRANDD_NVD_API_KEY` is optional. This discovery runs alongside the incremental feeds; it does not reset their existing cursors.

### Automatic clearing and history

A complete successful version scan changes a finding from **Affected → Resolved** only when no locked package instance still matches the advisory, or the affected dependency has been removed while the remaining inventory was scanned successfully. A second vulnerable version elsewhere in the repository keeps the finding open. Current versions and the resolution reason remain visible under **CVE subscriptions**. Findings are retained as history.

Already-queued remediation that has not started is marked done/pass for the same subscription, target and advisory aliases. Running turns are left to finish their own applicability check. A vulnerable version returning later reopens the finding with a fresh assessment ID. Disabling automatic clearing keeps prior findings open. Generic technology-only subscriptions are never automatically cleared based on a missing feed item or a repository version we did not inspect.

Upgrade tests exercise populated compressed SQL data, old receipts and settings, finding persistence, fixed-version transitions, alias merging, and pending-versus-running queue resolution. They are included in `bun run test:upgrade`, which also runs during Docker builds.
