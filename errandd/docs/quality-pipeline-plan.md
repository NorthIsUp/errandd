# errandd quality pipeline — remaining plan

Status snapshot: **2026-06-11**. Paused at user request (subagent usage). This is
the continuation of the deep-analysis → refactor → provider-excellence pipeline.
Each item below is sized to one PR. Land order is roughly top-to-bottom; #2 (DRY)
should land before #3 (GitHub) because #3 adds rule shapes to the same schema.

## How to resume

Dispatch each item as an **Opus** worktree subagent (`model: "opus"`,
`isolation: "worktree"`), one at a time, branched from current `master`. Per-PR
gates: `bun run typecheck` clean, `bun test` (9 pre-existing env-specific failures
on master — jobsRepo git fixtures + hook-scope; a 10th appears only when tests run
*inside* `.claude/worktrees/`), `bun run build:web` succeeds, `bunx biome check`
on changed files. Bump both versions (`bun run bump:plugin-version` +
`bump:marketplace-version`) at land time, revert any generated
`web/v3/styles.gen.css`, auto-merge after opening.

---

## Already shipped (this pipeline)

- **#156** fix(sentry): meaningful sidebar titles + issue-id identity
- **#157** feat(hooks): comment bodies as rich markdown end-to-end (data layer +
  prompt-kit Tool/Reasoning in the chat rail)
- **#158** feat(chat): monospace-markdown rendering for tool Input panel
- **#159** feat(sentry): host filter + shortId sidebar names + env/host fields
- **#160** feat(chat): render GitHub-comment HTML (details/summary/tables) safely
  (rehype-raw + rehype-sanitize)

---

## 1. DRY hook pipeline (PARTIALLY DONE — resume from worktree)

**State:** a subagent committed the backend half on branch `dry-hook-pipeline-v2`
(commit `733738b`, in worktree `.claude/worktrees/agent-a5c7e92088675f232`):
"adopt shared webhook envelope + DRY rule-eval/sentry-id/ts". It left the
**frontend schema unification (part 4)** uncommitted (dirty: `src/hooks/schema.ts`,
`web/ui/hookConfig.ts`, `web/ui/schedule.ts`).

**Decision needed before resuming:** verify the committed backend half is correct
and green (the prior attempt broke an import chain once). Either finish part 4 on
top of `733738b`, or cherry-pick the clean backend pieces onto a fresh branch and
redo part 4 carefully. Don't blind-merge `733738b` — review the diff vs current
master first.

Scope (from analysis):
1. Adopt `src/hooks/webhookEnvelope.ts` `handleSignedWebhook` (was 100% dead code)
   — write its tests first, then migrate sentry/datadog/linear receivers onto it;
   migrate GitHub only if the spec fits a match callback cleanly. Delete the
   byte-identical local `verifySentrySignature` / `verifyLinearSignature`.
2. Generic rule-eval helper for the 4× `evalXxxRule`/`matchXxxRule`/
   `xxxRuleSkipReason` triple in `match.ts` — keep exported names/signatures.
3. Consolidate sentry issue-id extraction (match.ts scope vs evaluate.ts pk) into
   shared/hookPayload.ts. (Note: #156 already made pk issue-id-first — keep that.)
4. **Frontend schema unification (the uncommitted part):** `web/ui/hookConfig.ts`
   hand-mirrors `src/hooks/schema.ts` (SentryRule/DatadogRule/LinearRule parse +
   defaults) and `web/ui/schedule.ts` has the serializers. Move provider-rule
   types/defaults/parsers/serializers into a new `shared/hookRules.ts` both sides
   re-export from (shared/ must stay node-free so it bundles). Fix the
   `sentryValue()` all-empty→`true` lossy-collapse bug. Add round-trip tests
   (parse→serialize→parse === identity) for Sentry/Datadog/Linear.
   **Watch out:** #159 added a `host` dimension to SentryRule — the unification
   must include `host` on both sides.
5. Trivial: dedupe identical local `ts()` in start.ts + plugins.ts → `src/logTime.ts`.

If it can't all land cleanly, split: backend DRY (parts 1-3,5) as one PR, frontend
schema unification (part 4) as a second. Partial-but-correct beats broken.

## 2. GitHub webhook coverage (task #3)

The gap is **schema-shape**, not just missing dispatch branches: `HookConfig`
(src/hooks/schema.ts) only has `pr`, `comments`, and the three provider keys —
no rule type can express `issues` (opened/labeled/assigned), `push`, `check_run`/
`check_suite`, `workflow_run`, or `release`. So 48/50 of recent prod deliveries
(check_run/check_suite/workflow_job/workflow_run) match nothing and record no skip
reason. `dispatchHook` (receiver.ts) has only `pull_request` + COMMENT_EVENTS
branches. `server.ts` already routes any `x-github-event` to handleWebhook, so no
routing work is needed.

Scope: new rule shapes in schema.ts (+ the frontend mirror — fold into the #1
unification if it hasn't landed yet, else mirror by hand); the GitHubTriggers UI
has no cells for these event classes; dispatchHook branches with skip-reason
parity; github-triggers-mapping round-trip tests. Decide per event class whether
the default is fire / filter / explicit-skip — most CI noise (check_*/workflow_*)
should record a clear skip reason, not silently drop.

## 3. Sentry first-seen triage via Opus, debounced (task #6)

Headline feature. When a sentry issue_id arrives for the **first time**, run an
Opus triage (new error vs group-with-existing). Must debounce the thundering herd
(N events for one issue within seconds → ONE triage).

Building blocks that ALREADY exist (don't rebuild):
- Per-routine model override: jobs frontmatter `model?: string` (src/jobs.ts) — so
  "via Opus" is just `model: opus` on the triage routine.
- Debounce primitives: `hookQueue.defer(ids, notBefore)` returns messages to
  pending with a future not_before; `claimThread` coalesces all due pending
  messages per thread oldest-first. So debounce = enqueue-with-notBefore +
  coalesced batch claim.

Genuinely missing → build:
- Persistent per-issue first-seen state — a SQLite table keyed on sentry issue id
  (the only dedup today is the 24h delivery TTL in deliveries.ts). Singleflight per
  issue_id so concurrent first events collapse.
- A rule predicate: `SentryRule.firstSeen: true` (+ `debounceMs`) in schema.ts /
  match.ts + the hookConfig mirror.

**Architectural note from the staging-leak finding (Image, 2026-06-11):** issue
webhooks carry NO environment/host, so a staging issue can't be filtered at the
webhook layer — the routine fires and the LLM only then learns `dd.env=staging`.
Error webhooks DO carry env + `server_name` (host). If pre-LLM env/host scoping
matters, triage should key off **error** events (which #159's env+host filters can
gate), not issue events. Weigh this when wiring the trigger.

## 4. Linear support — parity + excellent (task #7)

Bring Linear to sentry/datadog parity, then past it. (server.ts still labels the
Linear route a "STUB" — update that.)

Parity gaps (analysis):
- **No structured rule editor:** ProviderHookEditor.tsx has Sentry+Datadog editors,
  no Linear. TriggersEditor has no linearActive / add/remove lifecycle; RoutinesView
  imports both editors but renders no Linear. Build LinearHookEditor (type/team/
  action/mention toggles; "Require @mention" default-on with an off warning).
- **Shallow payload extraction:** readLinearPayload reads identifier/team/title/
  body but not state/priority/assignee/estimate/labels; evaluate.ts has no Linear
  branch in extractHookFields. Add them so deliveries show why an event fired.
- **No clickable Linear URLs:** build canonical `https://linear.app/<team>/issue/<id>`
  links into deliveries + session metadata (parity with GitHub PR#/Sentry source
  bubbles). sourceLabel in markdown.tsx already handles Linear ids.
- **Thin rule matching:** LinearRule has type/team/action/mention only. Add
  priority + state globs (payload carries data.priority). Consider a safe default
  (e.g. priority ['urgent','high']) matching sentry/datadog's safe-by-default ethos.
- **buildHookTrigger** has no Linear branch (falls through to GitHub defaults) — add
  one so the Runs view shows `ENG-123 urgent · create` not bare `linear:issue.create`.
- **Event coverage:** DEFAULT_LINEAR_TYPES = [Issue, Comment]; Linear supports ~14
  entity types. Add a LINEAR_ENTITY_TYPES constant; consider a labels field for
  label-based routing.

"Excellent" beyond parity: reply-to-comment conversation flow (the @mention gate
infra supports mention:false for heavy integration), and label-triggered routines.

---

## Worktree hygiene

Stale worktree to deal with on resume:
- `.claude/worktrees/agent-a5c7e92088675f232` (`dry-hook-pipeline-v2`, partial #1) —
  preserve until #1 is landed, then `git worktree remove --force` + delete branch.
- `.claude/worktrees/agent-af72a038b10d7283d` is **locked and unrelated** — leave it.
