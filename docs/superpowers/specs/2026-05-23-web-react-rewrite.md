# Web UI — React Rewrite

**Date:** 2026-05-23
**Status:** Approved — execute autonomously
**Branch:** `feat/web-react-rewrite`

## Goal

Rewrite the entire web dashboard from a hand-written string-served HTML/CSS/JS page into a **React + TypeScript** app with a shared component library and tokens, so no section ever solves a cross-cutting problem (the burger, the rail, the header layout, the section frame) in isolation. Behavior parity, not behavior change.

## Stack — locked decisions

| Concern | Choice | Why |
|---|---|---|
| UI framework | **React 18 + TypeScript** | Standard, supports the component-sharing the user asked for. |
| Bundler | **Bun's built-in `Bun.build`** | Already in the toolchain; no new dependency. |
| Styling | **CSS Modules + tokens.css** | Predictable, no runtime, preserves the existing dark/glass aesthetic. No Tailwind. |
| A11y primitives | **Radix UI primitives** | Dialog/Popover/Tooltip/Combobox only. Everything visual is ours. |
| Routing | **Hash-based** | Matches today (`#chats`/`#jobs`/etc.); browser back/forward works. |
| Data fetching | **Plain `fetch` + small typed wrappers** | No TanStack Query — the app is small and our state is simple. |
| State | **React built-ins** (`useState`/`useReducer`/`useContext`) | No Zustand/Redux. |
| Tool/dep pin | **mise** (`mise.toml`) | Per user. |
| Git hooks | **hk** (`hk.pkl`) | Per user. |
| Lint/format | **Biome strict** for general JS/TS + format. **ESLint with strict React rules** for React-specific lints Biome doesn't cover (react-hooks rules-of-hooks, jsx-a11y). | Per user — belt-and-suspenders. |

## API contract

The whole `/api/*` surface is **locked from the previous PR**. The React app is purely a new client. Endpoints used: `/api/state`, `/api/home`, `/api/sessions[?includeClosed=1]`, `/api/sessions/<id>/messages`, `/api/sessions/<id>/title|close|reopen|goal|model|effort`, `/api/jobs/repos`, `/api/jobs/repos/<slug>/pull|sync`, `/api/jobs/files[?repo=<slug>]`, `/api/jobs/file[?repo=<slug>&path=<p>]` (GET/PUT/POST/DELETE), `/api/jobs/file/auto-name`, `/api/usage`, `/api/mcp` (GET/POST/DELETE), `/api/slash`, `/api/chat` (SSE stream), `/api/settings` (PUT), `/api/settings/heartbeat` (POST).

## File structure

```
web/
  index.html               # entry shell — just <div id="root"></div> + the served JS/CSS
  index.tsx                # React mount + router boot
  build.ts                 # wraps Bun.build → outputs dist/web/
  tsconfig.json            # strict, jsx: react-jsx
  api/                     # typed fetch wrappers, one module per resource
    client.ts              # token mgmt + base fetch
    state.ts home.ts sessions.ts jobs.ts repos.ts mcp.ts slash.ts chat.ts
  app/
    App.tsx                # the root: <AppShell><Router/></AppShell>
    Router.tsx             # hash-based route → active section
    sections/
      HomeSection.tsx
      ChatsSection.tsx
      JobsSection.tsx
      SettingsSection.tsx
  components/              # design system — every section uses these
    AppShell.tsx           # owns the rail + burger + drawer + scrim. THE place the burger problem is solved.
    SectionFrame.tsx       # every section renders here. Receives header + children.
    Header.tsx             # title + actions row used inside SectionFrame.
    Card.tsx Field.tsx Input.tsx Select.tsx Textarea.tsx Button.tsx IconButton.tsx
    Badge.tsx Banner.tsx Disclosure.tsx Drawer.tsx Popover.tsx Toast.tsx Table.tsx
    Spinner.tsx Tooltip.tsx EmptyState.tsx GitFooter.tsx
  features/                # cross-cutting feature components that don't belong to a single section
    chat/
      ChatPane.tsx ChatInput.tsx ChatMessage.tsx SlashPopover.tsx PrefsBanner.tsx
    sessions/
      SessionsSidebar.tsx ThreadGroup.tsx SessionRow.tsx
    jobs/
      JobsEditor.tsx JobsFileList.tsx RepoStatusRow.tsx FrontmatterSummary.tsx
    mcp/
      McpList.tsx McpAddForm.tsx
  styles/
    tokens.css             # the existing CSS variables — palette, rail width, etc.
    reset.css
  hooks/
    useHash.ts             # active section from URL hash
    useApiState.ts         # polled /api/state cache
    useToast.ts
```

## Cross-cutting solutions (the user's actual ask)

- **`AppShell`** is the sole owner of: the left rail (desktop), the burger button (mobile), the slide-out drawer, the scrim. Every section is `<AppShell>{activeSection}</AppShell>`. Sections never know about the burger.
- **`SectionFrame`** owns: the header row layout, the safe-area reserve on mobile (so the burger never overlaps anything inside ANY section), scrollable body region. Every section renders `<SectionFrame title="..." actions={...}>...</SectionFrame>`.
- **`tokens.css`** centralizes the palette and a few layout vars (rail width, header height, gap scale). No section defines its own colors or spacings.

## Build + serve

- `bun run build:web` → produces `dist/web/{index.html, app.js, app.css, ...}`.
- `bun run dev:web` → `bun build --watch` for HMR-ish iteration.
- `src/ui/server.ts` is modified to serve `dist/web/index.html` at `/` and the asset files at their paths, behind the existing token gate. All `/api/*` routes are untouched.
- The old `src/ui/page/` directory is deleted as part of the server cutover (phase 9).

## Tests

- Backend tests (262 today) are not touched and must continue to pass.
- React components: focused unit tests for the pure utilities (slash command parsing, fuzzy match, frontmatter parser, the loop interval parser). UI integration tests are out of scope — visual QA via the gstack browser is the verification.
- Biome + ESLint run in CI via hk pre-commit hooks; must be clean.

## Behavior parity checklist (every existing surface preserved)

- Home: server card, upcoming jobs, git sync per repo, recent activity, session usage with totals + per-job grouping + disclosure.
- Chats: threaded sidebar grouping per-job runs, rename ✎, close ×, "Show closed (N)", chat send + SSE streaming + attachments + history paging + new session, slash popover with fuzzy match + ↑↓/Enter + space-dismiss, `/goal /loop /model /effort` client intercepts, prefs banner above the input.
- Jobs: file list grouped per repo, frontmatter summary line, monospace editor with dirty indicator, save, `+ New` (date-named + Haiku auto-rename on first save), delete, per-repo Sync to Git + status row + plugins-N readout.
- Settings: model, fallback, heartbeat (enabled/interval/prompt), security, clock format, timezone, Jobs Plugin Repos list with `+` / `−` and 🧩 icon, MCP list with add form + per-row remove.
- Mobile (≤760px): burger floats top-left over an empty safe-area; no section's content is ever underneath it. Rail slides in via burger.
- Footer in rail: sha8 + dirty `*`, links to the GitHub commit.

## Out of scope

- Behavior changes / new features (the rewrite is parity-only).
- Backend changes (API + daemon untouched).
- Tests for visual layouts (rely on visual QA).
- A full Storybook / component playground.
- shadcn/ui or Tailwind.

## Done definition

- The daemon serves the React app at `/`; the old `src/ui/page/` is deleted.
- All behavior in the parity checklist passes visual QA.
- `bun test` still 262 green.
- `mise run lint` (Biome + ESLint) clean.
- `hk` pre-commit hooks pass.
- One PR onto `master`.
