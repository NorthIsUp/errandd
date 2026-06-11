# TODO — deferred work / short-term compromises

## 2026-06-09 — v3 Linear: no structured "+ linear hook" editor button

- **Where:** web/v3/sections/RoutinesView.tsx + web/ui/components/ProviderHookEditor.tsx
- **What:** the Linear receiver fires routines and `on: linear` round-trips
  through the Config pane (parse/serialize/non-representable raw editing), but
  there's no structured `LinearHookEditor` / "+ linear hook" button like
  sentry/datadog have — you add `on: linear` via the routine's raw `.md`.
- **Why:** the ask was "receiver + settings" (both shipped); the per-routine
  editor UI is parity polish.
- **Fix:** add `LinearHookEditor` (type/team/action pills + a mention toggle,
  mirroring `SentryHookEditor`) and wire the add-button + render in RoutinesView.

## 2026-06-08 — v3 biome: complexity/a11y warnings in agent-built views

- **Where:** web/v3/sections/DeliveriesView.tsx, web/v3/lib/tree.ts:114,
  web/v3/lib/sources.ts:67, web/v3/sections/RoutinesView.tsx:337,
  web/v3/components/SectionTree.tsx:119
- **What:** `noExcessiveCognitiveComplexity` (several fns >15),
  one `noNonNullAssertion`, one `useKeyWithClickEvents` (a11y), one
  `useExhaustiveDependencies` (handleDelta) remain after auto-fixing the 120
  `useBlockStatements` issues. (biome is not a CI gate here — the pre-existing
  src/ui/server.ts main handler already scores 255 vs max 15.)
- **Why:** these are in freshly workflow-built views; refactoring for
  complexity right before shipping risks regressions with no UI tests yet.
- **Fix:** split the long DeliveriesView render/handlers into smaller
  components, replace the `routines[0]!` assertion with a guard, add keyboard
  handlers to the clickable delivery row, and memoize `handleDelta`.

## 2026-06-08 — v3 visual QA pending

- **Where:** web/v3 (Abyssal/Tidepool reskin)
- **What:** reskin verified by build + typecheck + mockup parity, but not yet
  screenshotted against a running daemon with live queue data.
- **Why:** running the daemon with auth + seeded hook data is heavier than the
  build gate; shipping behind /v3 (parallel, opt-in) so it's low-risk.
- **Fix:** load `/v3/` against a daemon with a few real deliveries, screenshot
  both themes, tune spacing/contrast (esp. Tidepool coral/teal legibility).

## 2026-06-10 — deploy/restart readiness: ~1min unavailable window

- **Where:** src/commands/start.ts:599 (`await ensureAllRepos()`) vs :1060
  (web server starts listening) vs :1807 (`setReady(true)`)
- **What:** On every deploy AND every in-place plugin auto-update (the
  start-claw.sh supervisor pkills+respawns the daemon ~every 10min on a new
  published version), the daemon is unavailable for ~1min. The infra
  readinessProbe→/readyz fix (teamclara/infrastructure#449) makes that window
  CLEAN (503/no-route instead of half-init 502s) but does not SHORTEN it.
- **Why:** The web server doesn't start listening until line 1060, but
  `await ensureAllRepos()` (git clone/fetch of all jobsRepos over the network)
  runs first at line 599. So `/readyz` is unreachable during the slow part —
  moving `setReady(true)` earlier can't help because the HTTP server isn't up
  yet. The minute is dominated by the pre-listen git I/O.
- **Fix:** Reorder startup so the HTTP layer comes up before the git-heavy
  work: start the web server (at minimum the `/readyz` + `/healthz` + durable
  webhook-enqueue paths) first, flip `setReady(true)` once the server + SQLite
  hook queue are open, then run `ensureAllRepos()`/`loadJobs()` in the
  background. Webhooks accepted early enqueue durably and drain once jobs load;
  the dashboard can show a "loading jobs" state until then. Shrinks the
  unavailable window from ~1min to seconds for both deploys and auto-updates.
  Measure the actual ensureAllRepos duration first (needs prod daemon.log /
  pod exec — denied this session) to confirm it's the dominant cost.
