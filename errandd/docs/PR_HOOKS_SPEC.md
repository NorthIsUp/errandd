# Errandd PR Hooks — Design Spec

## Goal

Let a job declare GitHub events that should trigger it, instead of (or in
addition to) a cron `schedule:`. Initial scope: pull requests. The trigger
declaration lives in the **job's own frontmatter** as the single source of
truth; the Hooks tab is a roll-up view across jobs.

Example:

```yaml
---
schedule: ""
on:
  pr:
    repo: org/repo
    user:
      - "*"
      - "!*[bot]"
      - "!northisup"
    action: [opened, synchronize, reopened]
---
```

When GitHub sends a webhook matching that rule, the daemon runs the job's
prompt with the event payload available as context.

---

## Rule schema

### Top-level shape

```yaml
on:
  pr:        <PrRule>          # required (for v1)
  push:      <PushRule>         # reserved — out of scope for v1
  issue:     <IssueRule>        # reserved — out of scope for v1
  comment:   <CommentRule>      # reserved — out of scope for v1
```

Only `pr` is implemented in v1. The schema is forward-compatible so adding
event types later doesn't break existing rules.

### `PrRule`

| Field    | Type                  | Default                                                                  | Notes |
|----------|-----------------------|--------------------------------------------------------------------------|-------|
| `repo`   | string \| string[]    | required                                                                 | `org/repo`, or list of `org/repo`. Wildcards allowed: `org/*`, `*/repo`, `*/*`. |
| `user`   | string \| string[]    | `["*"]`                                                                  | Glob list with optional `!` prefix for negation. See "User matching" below. |
| `action` | string \| string[]    | `["opened", "synchronize", "reopened"]`                                  | GitHub PR action values. `*` means all. |
| `branch` | string \| string[]    | `["*"]`                                                                  | Glob list matched against the PR's base branch. Negation supported. |
| `labels` | string \| string[]    | `[]`                                                                     | If set, PR must carry ALL listed labels (AND-match). Negation = label must be absent. |
| `draft`  | `true` \| `false` \| `"any"` | `false`                                                            | `false` excludes draft PRs; `true` includes only drafts; `"any"` includes both. |

### User matching

Patterns are evaluated **in order** against the PR author's login,
case-insensitively. Each pattern is a shell-style glob (`*`, `?`, `[set]`).

- A bare pattern (`*`, `northisup`, `*[bot]`) is an **include** rule.
- A `!`-prefixed pattern (`!northisup`, `!*[bot]`) is an **exclude** rule.

Evaluation:

1. Start with `included = false`.
2. For each pattern in order:
   - Include pattern matches login → `included = true`.
   - Exclude pattern matches login → `included = false`.
3. Final value of `included` decides whether the rule fires.

This makes `user: ["*", "!*[bot]", "!northisup"]` read naturally: include
everyone, then peel off bots, then peel off northisup. Order matters — moving
`*` to the end would re-include everyone.

Same evaluation model applies to `branch` and `labels`.

### Multiple rules per job

A single `on:` block describes one rule. If a job needs disjoint triggers
(e.g. PR opened on repo A *or* repo B with different user sets), declare
multiple rules under `on.pr` as a list:

```yaml
on:
  pr:
    - repo: org/repo-a
      user: ["*", "!*[bot]"]
    - repo: org/repo-b
      user: [northisup]
```

The job runs once per rule that matches.

### Coexistence with `schedule:`

A job can have both `schedule:` (cron) and `on:` (event-driven). They run
independently. Empty `schedule: ""` makes a job event-only.

---

## Frontmatter parser

**Constraint**: `src/jobs.ts` currently uses a hand-rolled line parser
(`parseFrontmatterValue` + `lines.find(l => l.startsWith(...))`). It cannot
handle nested mappings or sequences, so the `on:` block requires a real YAML
parser.

**Plan**:

1. Add `yaml` (the npm package, ~70 KB) as a runtime dep.
2. Inside `parseJobFile`, parse the full frontmatter block with `yaml.parse`,
   then keep the existing field extraction working off the parsed object
   instead of `lines.find`.
3. Migrate gradually: keep both code paths in parallel for one release, with
   a unit-test fixture per existing job file confirming the YAML parser
   produces the same `Job` object as the legacy line parser. Delete the
   legacy parser once parity is verified.

**Backward compatibility**: every existing job file is already valid YAML
(flat scalars), so this is purely an additive change.

---

## Daemon side

### Webhook receiver

`POST /api/webhooks/github` (legacy alias: `POST /api/github/webhook`)

Lives in `src/ui/server.ts` next to the existing API routes, but does **not**
use the bearer-token auth path. Instead:

- Requires header `X-Hub-Signature-256: sha256=...`.
- Verifies HMAC-SHA256 over the raw request body using a shared secret stored
  in settings: `settings.github.webhookSecret`.
- Rejects requests where `Content-Type !== application/json` or the signature
  is absent/invalid (401).
- Reads `X-GitHub-Event` to dispatch (`pull_request`, others ignored in v1).
- Reads `X-GitHub-Delivery` for idempotency: keep a 24h LRU of delivery IDs;
  duplicates return `200 {duplicate: true}` without re-running anything.

### Matcher

New module `src/hooks/match.ts`:

- Loads all jobs via the existing `loadJobs()` API.
- For each job carrying an `on.pr` rule, runs the rule against the parsed
  payload (repo, user, action, branch, labels, draft).
- Returns the list of `(job, rule, matchedFields)` tuples.

### Runner integration

For each match, the daemon enqueues a run via the existing `runUserMessage`
path (the same one that powers chat and cron jobs), with:

- A constructed prompt: `<job body>\n\n## Triggering event\n<JSON payload>`
- Session ID `pr:<delivery-id>:<job-name>` so multiple matches don't collide
- Job-name tagged so it shows up under Home → token-usage grouping

### Configuration surface

`settings.github`:

```ts
interface GithubSettings {
  webhookSecret: string;        // HMAC secret, edited only in Settings
  installationId?: number;       // (future) GitHub App install for replies
  defaultRepos?: string[];       // (future) gate which repos can fire any hook
}
```

Edited from a new Settings → GitHub panel. Secret is shown masked
(`••••••••`) with a "Reveal" button; writing it goes through the same
`updateSettings` patch endpoint.

### Security

| Threat                                   | Mitigation |
|------------------------------------------|------------|
| Spoofed webhooks                         | HMAC verification, constant-time compare |
| Replay attacks                           | Delivery-ID LRU |
| Hook fires on attacker-controlled fork PR| Rules are `user`-allowlisted by default (`["*", "!*[bot]"]` is a reasonable starting suggestion in the UI scaffold, but each rule still requires an explicit author list — fork PRs from new accounts won't match `northisup`-style allowlists) |
| Secret leakage via logs                  | Never log raw secret; log only the last 4 chars + length |
| DoS via flood                            | Token-bucket rate limit on `/api/webhooks/github` (e.g. 60/min/IP), drop with 429 |
| Code-exec from PR title/body             | Treat payload strictly as data — prompts include it as a fenced JSON block, never interpolated raw |

---

## Public-internet exposure

A webhook receiver needs to be reachable from GitHub. Three options to
document in the UI's empty-state, in order of friction:

1. **GitHub App with smee.io / cloudflared tunnel** — recommended for local
   dev. Document the exact tunnel command.
2. **Self-hosted on a public host** — point `settings.web.host` at a public
   interface; user is responsible for TLS / reverse-proxy.
3. **Future**: bundled tunnel mode in Errandd itself (deferred).

The Hooks tab should not pretend the local-only default `127.0.0.1` listener
works for webhooks — show a yellow banner with the appropriate setup link
when the daemon is bound to loopback.

---

## UI: Hooks tab

Source-of-truth is the job .md, so this tab is a **roll-up + jump** view, not
a primary editor.

### Layout

```
┌─ Breadcrumbs: Hooks ──────────────────────────────────┐
│  ⚠ webhook URL not reachable — see setup    [docs ↗]  │   ← when on loopback
└───────────────────────────────────────────────────────┘
┌─ Receiver ────────────────────────────────────────────┐
│  Webhook URL:  https://….example.com/api/webhooks/github│
│  Secret:       ••••••••  [reveal] [rotate]            │
│  Last event:   2026-05-26 10:42 · pull_request#1234   │
└───────────────────────────────────────────────────────┘
┌─ PR triggers across all routines ─────────────────────┐
│  repo                user                     job       │
│  org/repo-a   *, !*[bot], !northisup    review-pr  →   │
│  org/repo-b   northisup                 ship-it    →   │
│  …                                                      │
└───────────────────────────────────────────────────────┘
┌─ Recent deliveries  (last 50) ────────────────────────┐
│  10:42  PR#1234 opened   org/repo-a   matched: review-pr │
│  10:17  PR#1230 sync     org/repo-a   no match           │
│  …                                                       │
└──────────────────────────────────────────────────────────┘
```

- Each row in "PR triggers" → click to jump to that job's editor in the Jobs
  tab (`/ui/#/jobs/<slug>/<file>`), where the user edits the `on:` block in
  the .md. Hooks tab itself is read-only.
- "Add trigger" button → opens the Jobs tab in a "new routine with PR hook"
  flow that pre-fills the frontmatter template.
- Recent deliveries come from a new daemon-side ring buffer; exposed at
  `GET /api/github/deliveries` (last 50 entries, in-memory, lost on restart
  for v1).

### Data flow

| Action                  | API                                              |
|-------------------------|--------------------------------------------------|
| List hook rules         | New `GET /api/hooks/pr` — server walks loaded jobs, returns flattened rule rows |
| Receiver status         | New `GET /api/hooks/receiver` — URL, last-event timestamp, reachability hint |
| Recent deliveries       | New `GET /api/github/deliveries`                 |
| Get/set webhook secret  | Existing `GET/PUT /api/settings` patch          |
| Test a payload          | New `POST /api/hooks/test` — accepts a hand-crafted PR payload, runs matcher, returns matched rules without executing |

---

## File layout (new)

```
src/
  hooks/
    schema.ts        # zod schemas for OnRule / PrRule
    parse.ts         # frontmatter → OnRule list
    match.ts         # PrRule × payload → boolean + matched-fields trace
    receiver.ts      # webhook HTTP handler (HMAC verify, dispatch)
    deliveries.ts    # in-memory ring buffer
web/
  api/
    hooks.ts         # client for /api/hooks/* and /api/github/deliveries
  ui/sections/
    HooksSection.tsx # rewrite from stub to spec above
PR_HOOKS_SPEC.md     # this file
```

Test fixtures:

```
test/hooks/
  fixtures/
    pr-opened-human.json
    pr-opened-bot.json
    pr-sync-northisup.json
  match.test.ts      # rule × fixture matrix
  parse.test.ts      # frontmatter parsing + zod errors
  receiver.test.ts   # HMAC verify, replay protection, dispatch
```

---

## Build sequence

1. **YAML parser swap** (`src/jobs.ts`) — gated, with a fixture-based parity
   test. Land alone.
2. **Schema + matcher** (`src/hooks/{schema,parse,match}.ts`) with unit tests.
   No HTTP yet. Land alone.
3. **Receiver + deliveries buffer** (`src/hooks/{receiver,deliveries}.ts`),
   wired into `src/ui/server.ts`. HMAC verification + 24h replay LRU. Tested
   via curl with a hand-built `X-Hub-Signature-256`.
4. **Settings: GitHub panel** (mask/reveal secret).
5. **Hooks tab rewrite** + `/api/hooks/*` endpoints.
6. **Docs page / empty-state banner** for the public-URL setup options.

Each step is shippable on its own.

---

## Open questions

1. **Match-anywhere on body?** Should we support a `body:` glob (match a
   trigger phrase inside PR description, like `[errandd: please-review]`)?
   Recommendation: yes in v1.1, not v1 — orthogonal feature, separate review.
2. **Reply path** — does the matched job's output get posted back as a PR
   comment? Requires a GitHub App install (or PAT); deferred to v2 along with
   `installationId`.
3. **Concurrency** — if two webhooks fire for the same `(job, PR)` pair
   within seconds (rapid push), do we coalesce? Recommendation: yes, debounce
   to one run per `(job-name, pr-number)` over a 30s window. Define in v1.
4. **Multi-repo rule explosion** — `repo: org/*` could match dozens of repos
   on a single delivery. We still only run the job once per delivery (the
   delivery itself names one repo), so this isn't a fan-out concern.
