# v3 UX — live backlog (post-merge follow-ups)

Ordered by priority. Each becomes its own small PR so they stay reviewable and
the daemon redeploys (`docker-publish` on master) incrementally.

## Queued (in order)
2b. **Local auth for dev.** The daemon issues an ephemeral web token, so opening
   `/v3/` without `?token=` → all API calls 401 ("Not authorized" banners). For local
   dev, either disable auth for loopback or start with a fixed token. Pairs with #9.
10. **Routines: render .md with prompt-kit `Markdown`** (prompt-kit.com/docs/markdown)
    instead of the current editor-only view. (User note 2026-06-08.)
2. **Chat: stop re-sending the whole prompt on resume.** On a resumed session only
   send "new events since you last ran" + payloads, NOT the full routine prompt
   (`buildCoalescedHookPrompt` in src/commands/start.ts must take `isNewSession` and
   omit the routine body when resuming). Root cause of the giant trigger wall +
   wasted tokens. (User note 2026-06-08.)
3. **Chat: trigger as a clean card.** Parser should emit the hook-trigger turn as a
   compact, collapsible `system` part (event/repo/PR/sender chips + "show full
   prompt" expander) instead of a raw `text` wall. Pairs with #2.
4. **Chat: dark/theme-aware code blocks.** shiki defaults to `github-light` → white
   boxes in dark themes. Make the Markdown/CodeBlock theme follow the active v3 theme.
5. **Chat: `SystemMessage` for `[skip]`/`[ok]` outcome lines** and "No response
   requested." notices, instead of plain bot-avatar text rows.
6. **v3 = default UI.** `/` → `/v3/`; move the current `ui` bundle to `/v2/`
   (rename bundle name only — source stays `web/ui/` since v3 reuses its sections).
   Touches build.ts, server.ts (BUNDLES + root redirect + sentinel), start.ts
   (builtMarker + printed URL).
7. **Mobile: sidebar collapses to a drawer** on narrow widths (hamburger + overlay;
   `md:` breakpoint).
8. **Settings frontend-design pass.** Over/under field layout (Git identity Name/Email
   are inline now), consistent spacing across all settings sections. Shared with /v2.
9. **Dev mode → prod data.** Point the local v3 UI at the tailnet API
   (`https://clawdcode.raccoon-fish.ts.net`) for real data while iterating — likely a
   local server-side `/api/*` proxy (env-gated) to avoid CORS; reuse tailnet trust for
   auth. Unblocks real-data UI verification.

## Done
- v3 structural build + Abyssal/Tidepool reskin + Linear stub (PR #110, merged → 1.0.172).
- **Theme system**: 5 curated themes (Abyssal/Tidepool/Contrast-Dark/Contrast-Light/
  Colorblind), system + prefers-contrast default, sidebar ThemePicker, severed the old
  AppearancePanel from v3 (fixed "themes all messed up").
