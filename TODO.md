## 2026-10-31 — Separate dependency matches from assessed non-applicability

- **Where:** errandd/app/cve-subscriptions.ts and the v3 CVE status filters.
- **What:** A lockfile match remains marked affected even when its tracking issue is closed as not affected; CLA-3140 / CVE-2026-119196 demonstrates the mismatch.
- **Why:** Scan findings capture affected dependency versions, while agent reachability conclusions live in the tracking issue. A generic pass result does not establish non-applicability.
- **Fix:** Persist a structured applicability disposition with repository-revision evidence and reconcile it into the dashboard without treating a vulnerable dependency version as patched. Invalidate the disposition when relevant repository evidence changes.
