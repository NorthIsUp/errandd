# TODO — deferred work / short-term compromises

## 2026-06-11 — frontend rule-schema still mirrors the daemon schema (not shared)

- **Where:** web/ui/hookConfig.ts (645 lines) + web/ui/schedule.ts (468 lines)
  hand-mirror src/hooks/schema.ts (821 lines) — the types, defaults, parsers,
  and serializers for ALL SIX rule families (pr / comments / sentry / datadog /
  linear / checks / issues).
- **What:** the DRY-hook-pipeline PR unified the BACKEND (shared receiver
  envelope, generic rule-eval factory, shared Sentry id extraction) but
  deliberately did NOT unify the frontend rule schema. The provider-rule
  types/defaults/parsers/serializers should move into a node-free
  `shared/hookRules.ts` that both `src/hooks/schema.ts` and the web mirror
  re-export from, so adding a field to a rule can't silently drift the editor.
- **Why deferred:** this is LARGE and high-drift-risk now that there are six
  families. The web parser is a *separate, more lenient* implementation than the
  daemon's throwing parser (different error semantics), and schedule.ts's
  serializers carry subtle round-trip semantics — notably the all-empty→`true`
  lossy collapse the task flagged. Reconciling them byte-for-byte is a real
  behavior merge, not a mechanical extraction; doing it inside a
  zero-behavior-change refactor PR (whose backend parts are all green) would put
  that correctness at risk. Backend DRY shipped; this is the remaining (purely
  additive-risk) piece.
- **Fix:** create `shared/hookRules.ts` (node-free) holding the 6 rule
  interfaces + `defaultXxxRule()` + `parseXxx` + serializers. Have schema.ts and
  hookConfig.ts/schedule.ts re-export from it (keep every existing import path
  working). Cover EVERY field of all 6 families and add round-trip tests
  (parse → serialize → parse === identity) for each family, explicitly pinning
  the all-empty→`true` collapse so the unification can't regress it.

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


## 2026-06-18 — Mobile run-row keyboard nav gap
- **Where:** web/ui/sections/RunsSection.tsx (mobile `<ul className="md:hidden">` row `<li>`)
- **What:** the whole-row tap navigates to the chat detail, but the row is mouse-only (eslint-disabled jsx-a11y click/keyboard rules); the inner RoutineLink only opens the .md file, so keyboard users can't reach the chat from this list.
- **Why:** `<li>` can't take `role="button"`, and wrapping it in a button nests the existing `<a>` (invalid). A proper fix is a layout change risky to do blind on the live dashboard.
- **Fix:** restructure the row as a "stretched-link" card — a full-row `<button>`/link for chat nav with the routine `<a>` layered above — so both targets are keyboard-reachable without nested interactives.
