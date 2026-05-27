# Web UI React Rewrite — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Steps use `- [ ]` checklists for tracking.

**Goal:** Replace `src/ui/page/` (hand-written string-served HTML/CSS/JS) with a React + TypeScript app in `web/`, behavior parity, shared component library, served by the existing `Bun.serve` from `dist/web/`.

**Spec:** `docs/superpowers/specs/2026-05-23-web-react-rewrite.md` — read it.

**Architecture:** React 18, Bun's built-in bundler, CSS Modules + tokens.css, Radix UI primitives for a11y, hash routing, plain fetch + typed wrappers. mise + hk + Biome (strict) + ESLint (strict React rules).

**Tech stack:** React 18, TypeScript, Bun, Radix UI, Biome, ESLint, mise, hk.

## Phase ordering & file conflicts

Each phase = one subagent. Strictly sequential — most phases touch shared files (`package.json`, `web/index.tsx`, the App, etc.).

| # | Phase | Touches |
|---|---|---|
| 0 | Tooling: mise + hk + Biome + ESLint + package deps | `mise.toml`, `hk.pkl`, `biome.json`, `.eslintrc.cjs`, `package.json`, `bun.lock` |
| 1 | Scaffold: web/ structure, build script, tsconfig, index.html, mount | `web/*`, `package.json` scripts |
| 2 | Tokens + reset + core components (Button/Card/Field/Input/Select/Textarea/Badge/Banner/Disclosure/Spinner/EmptyState/Tooltip/Popover/Drawer/Toast/Table) | `web/styles/*`, `web/components/*` |
| 3 | AppShell + Router + SectionFrame + GitFooter | `web/components/AppShell.tsx`, `web/components/SectionFrame.tsx`, `web/app/Router.tsx`, `web/components/GitFooter.tsx`, `web/hooks/useHash.ts`, `web/app/App.tsx` |
| 4 | API client (typed fetch wrappers per resource) | `web/api/*.ts` |
| 5 | Home section | `web/app/sections/HomeSection.tsx`, supporting bits |
| 6 | Chats section (largest — sidebar, chat pane, streaming, slash popover, prefs, intercepts) | `web/app/sections/ChatsSection.tsx`, `web/features/chat/*`, `web/features/sessions/*` |
| 7 | Jobs section (file list, editor, frontmatter summary, repo status, new-job + Haiku rename) | `web/app/sections/JobsSection.tsx`, `web/features/jobs/*` |
| 8 | Settings + MCP | `web/app/sections/SettingsSection.tsx`, `web/features/mcp/*` |
| 9 | Server cutover: serve dist/web/ from Bun.serve, delete src/ui/page/, README | `src/ui/server.ts`, remove `src/ui/page/*`, `README.md` |

After phase 9: final visual QA pass, push, open PR onto `master`.

---

## Phase 0 — Tooling

**Files:**
- Create: `mise.toml`, `hk.pkl`, `biome.json`, `.eslintrc.cjs`, `.eslintignore`
- Modify: `package.json`, `bun.lock` (via `bun add`)
- Create: `.gitignore` additions (`dist/`)

- [ ] **Step 1: `mise.toml`** at repo root:
```toml
[tools]
bun = "1.3.14"
node = "22"           # for @types/node, npm-published tools
biome = "latest"
hk  = "latest"
```

- [ ] **Step 2: install deps**

Run:
```bash
bun add react react-dom
bun add -d @types/react @types/react-dom typescript
bun add @radix-ui/react-dialog @radix-ui/react-popover @radix-ui/react-tooltip @radix-ui/react-toast
bun add -d eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin eslint-plugin-react eslint-plugin-react-hooks eslint-plugin-jsx-a11y
```
(Biome via mise, not as a project dep, to keep the dep tree small.)

- [ ] **Step 3: `biome.json`** — strict.
```json
{
  "$schema": "https://biomejs.dev/schemas/latest/schema.json",
  "files": { "include": ["web/**/*.{ts,tsx,js,jsx,css,json}", "src/**/*.ts"] },
  "linter": { "enabled": true, "rules": { "recommended": true, "all": true, "style": { "useImportType": "error" } } },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2 },
  "javascript": { "formatter": { "quoteStyle": "double", "semicolons": "always" } }
}
```

- [ ] **Step 4: `.eslintrc.cjs`** — strict React rules only (Biome handles general JS/TS):
```js
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: 2022, sourceType: "module", ecmaFeatures: { jsx: true } },
  plugins: ["react", "react-hooks", "jsx-a11y"],
  extends: [
    "plugin:react/recommended",
    "plugin:react/jsx-runtime",
    "plugin:react-hooks/recommended",
    "plugin:jsx-a11y/strict",
  ],
  settings: { react: { version: "detect" } },
  rules: {
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "error",
  },
  ignorePatterns: ["dist/", "node_modules/", "src/", ".claude/"],
};
```
`.eslintignore`: `dist/`, `node_modules/`, `src/`, `.claude/`.

- [ ] **Step 5: `hk.pkl`** — pre-commit + pre-push hooks.
```pkl
amends "https://hk.jdx.dev/release/v0/pkl/Config.pkl"

hooks {
  ["pre-commit"] {
    steps {
      ["biome"] { check = "biome check --error-on-warnings ." }
      ["eslint"] { check = "bun run lint:eslint" }
      ["typecheck"] { check = "bun run typecheck" }
    }
  }
  ["pre-push"] {
    steps {
      ["test"] { check = "bun test" }
      ["build"] { check = "bun run build:web" }
    }
  }
}
```

- [ ] **Step 6: `package.json` scripts**
```json
{
  "scripts": {
    "lint": "biome check . && bun run lint:eslint",
    "lint:eslint": "eslint web/",
    "lint:fix": "biome check --write . && eslint web/ --fix",
    "format": "biome format --write .",
    "typecheck": "tsc --noEmit -p web/tsconfig.json",
    "build:web": "bun run web/build.ts",
    "dev:web": "bun --watch web/build.ts"
  }
}
```
(Keep existing scripts; just add these.)

- [ ] **Step 7: `.gitignore`** — add `dist/`.

- [ ] **Step 8: Verify**
- `mise install` succeeds (or report what's missing; user's mise may have the tools already).
- `bun install` resolves cleanly.
- `bunx biome check biome.json` parses the config.
- `bun test` — still 262 green (no source changed).

- [ ] **Step 9: Commit**
```bash
git add mise.toml hk.pkl biome.json .eslintrc.cjs .eslintignore package.json bun.lock .gitignore
git commit -m "chore: scaffold tooling — mise, hk, Biome strict, ESLint React rules"
```

---

## Phase 1 — Scaffold `web/`

**Files:**
- Create: `web/tsconfig.json`, `web/index.html`, `web/index.tsx`, `web/build.ts`, `web/app/App.tsx`

- [ ] **Step 1: `web/tsconfig.json`** — strict.
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": false,
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "types": ["bun"]
  },
  "include": ["**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules", "../dist"]
}
```

- [ ] **Step 2: `web/index.html`** — minimal shell. The build inlines token+CSS bundle references; the served HTML names them as `app.css`/`app.js`.
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ClawdCode</title>
  <link rel="icon" href='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🦞</text></svg>' />
  <link rel="stylesheet" href="/app.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 3: `web/index.tsx`** — mount.
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import "./styles/reset.css";
import "./styles/tokens.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(<StrictMode><App /></StrictMode>);
```

- [ ] **Step 4: `web/app/App.tsx`** — placeholder for now.
```tsx
export default function App() {
  return <div>ClawdCode — bootstrapping…</div>;
}
```

- [ ] **Step 5: `web/build.ts`** — `Bun.build` wrapper.
```ts
import { rm, mkdir, cp } from "node:fs/promises";

const outdir = "dist/web";
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp("web/index.html", `${outdir}/index.html`);

const result = await Bun.build({
  entrypoints: ["web/index.tsx"],
  outdir,
  target: "browser",
  format: "esm",
  splitting: false,
  minify: process.env.NODE_ENV === "production",
  naming: { entry: "app.js", asset: "[name].[ext]", chunk: "[name]-[hash].[ext]" },
  loader: { ".css": "css" },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${outdir}/  (${result.outputs.length} files)`);
```
(If `Bun.build`'s CSS loader writes to a different default name, override the naming so the HTML's `<link href="/app.css">` resolves. Bun-build emits side CSS as `<entry-stem>.css` automatically; verify and adjust the HTML link if needed.)

- [ ] **Step 6: Build and verify**
- `bun run build:web` succeeds, outputs `dist/web/index.html` + `dist/web/app.js` + (likely) `dist/web/app.css` or `dist/web/index.css`.
- `bun typecheck` clean.
- `bunx biome check web/` clean.
- `bunx eslint web/` clean.

- [ ] **Step 7: Commit**
```bash
git add web/ package.json
git commit -m "feat(web): scaffold React app — tsconfig, index, build, mount"
```

---

## Phase 2 — Tokens + reset + core component library

**Files:**
- Create: `web/styles/tokens.css`, `web/styles/reset.css`
- Create: `web/components/{Button,IconButton,Card,Field,Input,Select,Textarea,Badge,Banner,Disclosure,Spinner,EmptyState,Tooltip,Popover,Drawer,Toast,Table}.tsx` (+ matching `.module.css`)

- [ ] **Step 1: `web/styles/tokens.css`** — port the existing variables from `src/ui/page/styles.ts:1-15` exactly:
```css
:root {
  --bg-top: #2a4262;
  --bg-bottom: #0d1828;
  --bg-spot-a: #7fb8ff3d;
  --bg-spot-b: #95d1ff38;
  --text: #f0f4fb;
  --muted: #a8b4c5;
  --panel: #0b1220aa;
  --border: #d8e4ff1f;
  --accent: #9be7ff;
  --good: #67f0b5;
  --bad: #ff7f7f;
  --warn: #ffc276;
  --rail-width: 72px;
  --header-h: 56px;
  --burger-safe: 52px;       /* top-reserve on mobile for the floating burger */
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 20px; --space-6: 24px;
  --radius-sm: 6px; --radius-md: 10px; --radius-lg: 14px;
  --font-sans: "Space Grotesk", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
}
```

- [ ] **Step 2: `web/styles/reset.css`** — minimal:
```css
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body, #root { width: 100%; height: 100%; margin: 0; overflow: hidden; }
body {
  font-family: var(--font-sans);
  color: var(--text);
  background:
    radial-gradient(1400px 700px at 15% -10%, var(--bg-spot-a), transparent 60%),
    radial-gradient(900px 500px at 85% 10%, var(--bg-spot-b), transparent 65%),
    linear-gradient(180deg, var(--bg-top) 0%, var(--bg-bottom) 100%);
  overflow: hidden;
}
button { font: inherit; color: inherit; }
a { color: inherit; }
```

- [ ] **Step 3: Each component**

For each component, create a `.tsx` plus a co-located `.module.css`. Strict props with TypeScript. Components are small, composable, no business logic.

Example — `Button.tsx`:
```tsx
import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}

export function Button({ variant = "secondary", size = "md", className, children, ...rest }: Props) {
  return (
    <button
      type="button"
      className={[styles.btn, styles[variant], styles[size], className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}
```

Companion `Button.module.css` carries the existing button looks ported from `styles.ts` (lift the values, don't reinvent the palette).

Do the same for the rest. Radix wraps where applicable: `Popover`, `Tooltip`, `Dialog` (Drawer is a Dialog styled as a side-sheet), `Toast`. The visual styling is ours.

Match the existing aesthetic — borders, radii, gradients in `Card`, the muted/accent label colors, the `JetBrains Mono` data fields. Read `src/ui/page/styles.ts` to lift specific values into the new modules; don't blindly reinvent the look.

- [ ] **Step 4: Smoke check**

Temporarily render one of each component in `App.tsx` to confirm they look right; run `bun run build:web && bun --hot src/index.ts start --web --replace-existing &` and screenshot via `~/.claude/skills/gstack/browse/dist/browse`. Then revert the temporary App to the placeholder.

- [ ] **Step 5: Lint + typecheck**
- `bunx biome check web/` clean.
- `bunx eslint web/` clean.
- `bun typecheck` clean.

- [ ] **Step 6: Commit**
```bash
git add web/
git commit -m "feat(web): tokens + reset + core component library"
```

---

## Phase 3 — AppShell + Router + SectionFrame + GitFooter

**Files:**
- Create: `web/components/AppShell.tsx`, `web/components/SectionFrame.tsx`, `web/components/GitFooter.tsx`, `web/components/Header.tsx`, `web/app/Router.tsx`, `web/hooks/useHash.ts`
- Modify: `web/app/App.tsx`

This is the **structural** phase. The user's specific ask — "no tab should be solving a problem like the burger problem in a unique way" — gets solved here, once, in `AppShell` + `SectionFrame`.

- [ ] **Step 1: `web/hooks/useHash.ts`** — subscribes to `hashchange` and returns the current section name (default `"home"`). Validates against `["home","chats","jobs","settings"]`.

- [ ] **Step 2: `web/components/AppShell.tsx`**

Owns:
- The left rail at desktop (a column of `<IconButton>` for each section + `<GitFooter />` at the bottom).
- The burger at mobile (≤760px) fixed top-left.
- The drawer that slides in when burger is tapped.
- The scrim behind the open drawer.
- A CSS variable `--shell-header-h` that the SectionFrame consumes to know the safe top inset.

Renders `<div class="app-shell">{rail/burger}<main class="section-host">{children}</main></div>`. No section ever touches these.

- [ ] **Step 3: `web/components/SectionFrame.tsx`**

Props: `{ title: string; actions?: ReactNode; children: ReactNode; bodyClassName?: string }`. Renders:
- A `<Header />` row with `title` and `actions`.
- A scrollable body region.
- On mobile, the body's top has `padding-top: var(--burger-safe)` so the burger never overlaps anything inside any section. The mobile header is right-padded to clear the burger horizontally.

Every section uses this; no section ever solves layout-around-burger again.

- [ ] **Step 4: `web/components/GitFooter.tsx`**

Reads `/api/state` once (via the API client from Phase 4 — for now, a direct `fetch` is fine; Phase 4 will swap it). Renders the `sha8` + `*` dirty marker as a link to `commitUrl`. Hidden when no git info.

- [ ] **Step 5: `web/app/Router.tsx`**

Switch on `useHash()` value → render the appropriate `*Section`. For now, sections are placeholders (`<SectionFrame title="Home">Home</SectionFrame>` etc.) — they'll get fleshed out in phases 5–8.

- [ ] **Step 6: `web/app/App.tsx`**
```tsx
import AppShell from "../components/AppShell";
import Router from "./Router";
export default function App() {
  return <AppShell><Router /></AppShell>;
}
```

- [ ] **Step 7: Build + visual QA**

Start the daemon serving `dist/web/` (Phase 9 changes the server; for now, manually open `dist/web/index.html` against a token-injected URL or wait for Phase 9). Until Phase 9, verify by loading `web/index.html` via Bun.serve a small static-file route OR — simpler — open the built files from disk in a browser. Confirm:
- Rail visible at desktop with the four section icons and `GitFooter` at the bottom.
- Burger visible at ≤760px; rail hidden until burger tapped.
- Routing: clicking a rail button updates `location.hash` and swaps which placeholder section renders.

- [ ] **Step 8: Commit**
```bash
git add web/
git commit -m "feat(web): AppShell + SectionFrame + Router + GitFooter — the burger problem solved once"
```

---

## Phase 4 — API client

**Files:**
- Create: `web/api/client.ts`, `web/api/{state,home,sessions,jobs,repos,mcp,slash,chat,usage,settings}.ts`

- [ ] **Step 1: `client.ts`** — token read on load from `?token=…`, stash in memory; persist to `sessionStorage` for refreshes. `apiFetch(path, init?)` adds `Authorization: Bearer …`. `apiJSON<T>(path, init?)` returns parsed JSON typed. On 401, throw a `NotAuthorizedError`.

- [ ] **Step 2: One module per resource**

Each exports typed functions matching the existing API. Examples:
```ts
// sessions.ts
export interface SessionInfo { id: string; agent: string; channel: "web"|"discord"|"agent"|"job"|"unknown"; lastUsedAt: string; createdAt: string; turnCount: number; firstMessage: string; lastMessage: string; title?: string; closed: boolean; jobName?: string; }
export const listSessions = (includeClosed=false) => apiJSON<SessionInfo[]>(`/api/sessions${includeClosed?"?includeClosed=1":""}`);
export const setSessionTitle = (id: string, title: string) => apiJSON(`/api/sessions/${id}/title`, { method: "PUT", body: JSON.stringify({ title }) });
// …
```

Match every endpoint the existing `script.ts` uses.

- [ ] **Step 3: Chat streaming (`chat.ts`)** — the trickiest. The server's `/api/chat` streams via SSE-or-fetch-stream. Read the existing client's send code (`src/ui/page/script.ts` — search for `/api/chat`) and port it: `streamChat({ text, sessionId, attachments, onChunk, onDone, onError, signal })`.

- [ ] **Step 4: Lint, typecheck**
- `bunx biome check web/` clean.
- `bunx eslint web/` clean.
- `bun typecheck` clean.

- [ ] **Step 5: Commit**
```bash
git add web/api/
git commit -m "feat(web): typed API client wrappers for every /api endpoint"
```

---

## Phase 5 — Home section

**Files:**
- Create: `web/app/sections/HomeSection.tsx`, `web/features/home/*` (Recent activity, Upcoming jobs, Git sync, Server status, Session usage with totals + grouping)

Behavior to preserve (read `src/ui/page/script.ts` `loadHome()` and the usage rendering):
- Five cards in a responsive grid.
- Usage table groups `<base>:<runId>` sessions under a parent row, totals row at the top.
- Git sync card lists per-repo status.

Use the `Card`, `Table`, `Disclosure` components. No bespoke CSS unless adding to a `.module.css`.

- [ ] Build, lint, typecheck. Visual QA at desktop + mobile.

- [ ] **Commit**: `feat(web): Home section — recent, upcoming, git, server, usage (with totals + grouping)`

---

## Phase 6 — Chats section

**Files:**
- Create: `web/app/sections/ChatsSection.tsx`, `web/features/chat/*`, `web/features/sessions/*`

Largest phase. Behavior to preserve (read `src/ui/page/script.ts`):
- Threaded sidebar (`groupSessionsIntoThreads`). Per-job thread with disclosure, paginator at >10.
- Rename ✎ inline, close ×, Show closed (N) toggle.
- Chat pane: messages with timestamps (`formatClockTime`), streaming, attachments (paperclip → file picker → base64 upload), history paging (`load-more`), new session button.
- Slash popover: fuzzy match, ↑↓/Enter, space dismisses, source chip with optional `plugin` label.
- Client intercepts: `/goal` `/loop` `/model` `/effort` — exact same parsing as today's script (port `parseLoopArgs` and the goal/model/effort handlers).
- Prefs banner above the input — rows for goal/model/effort with ×.

Use Radix Popover for the slash popover. Use a custom `useEventSource`-style hook for streaming (or async iterator on the response body — match the existing client).

- [ ] Build, lint, typecheck. Visual QA: open Chats, send a message and watch it stream, type `/`, navigate the popover, send `/goal …`, send a non-goal message and verify it's prefixed with `Goal: …` (check the daemon log).

- [ ] **Commit**: `feat(web): Chats section — threaded sidebar, streaming chat, slash popover, /goal /loop /model /effort`

---

## Phase 7 — Jobs section

**Files:**
- Create: `web/app/sections/JobsSection.tsx`, `web/features/jobs/*`

Behavior to preserve:
- File list grouped by repo. Sync to Git button per repo. Status row (clean/dirty/ahead/behind/last pulled/plugins).
- Editor: monospace textarea, dirty indicator (●), Save.
- Frontmatter summary line below the filename (`parseJobFrontmatter` + `summarizeFrontmatter` — port).
- `+ New`: creates `YYYY-MM-DD-HHmm.md`, opens it, dirty flag, Save → if filename matches date pattern → calls `/api/jobs/file/auto-name` to rename via Haiku.
- Delete (with confirm).
- Plugin icon left of the repo name in the group header.

- [ ] Build, lint, typecheck. Visual QA: open a job, edit, save, confirm summary updates and Haiku rename fires; create + delete; Sync to Git.

- [ ] **Commit**: `feat(web): Jobs section — explorer, editor, frontmatter summary, sync, Haiku rename`

---

## Phase 8 — Settings + MCP

**Files:**
- Create: `web/app/sections/SettingsSection.tsx`, `web/features/mcp/*`

Behavior:
- Model, fallback model.
- Heartbeat: enabled, interval, prompt.
- Security: level select.
- Clock: format (12/24) + timezone.
- Jobs Plugin Repos: list of rows (url/branch/interval, `−` to remove), `+ Add`, 🧩 next to each repo with discovered plugins.
- MCP: list (name + transport + target + `−` remove), `+ Add` form (name + transport select + target + headers list for http/sse).
- Save Changes button writes via `PUT /api/settings` (whitelist already extended to include `jobsRepos`, `model`, `timezone`, etc.). Heartbeat uses its own `POST /api/settings/heartbeat`.

- [ ] Build, lint, typecheck. Visual QA: edit each field, save, reload, confirm persistence. Add + remove an MCP server. Add + remove a jobs repo (note Settings save is what writes `jobsRepos`).

- [ ] **Commit**: `feat(web): Settings + MCP sections`

---

## Phase 9 — Server cutover + cleanup

**Files:**
- Modify: `src/ui/server.ts` — serve `dist/web/index.html` at `/`, asset files at `/app.js`/`/app.css`/etc. Keep all `/api/*` routes. Auth: token in query allowed once → set session cookie, future requests use cookie or `Authorization` header (the React client sends the token in `Authorization` so cookies are optional).
- Delete: `src/ui/page/` directory in full.
- Update: `README.md` Web UI section — note the build step (`bun run build:web`) and that the page is React.
- Update: any docs/CLAUDE.md hints referring to `src/ui/page/`.

- [ ] **Step 1: server.ts**

The current server reads `htmlPage()` and serves it at `/`. Replace with:
```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const WEB_DIST = join(import.meta.dir, "..", "..", "dist", "web");
const SERVABLE = new Set(["/", "/app.js", "/app.css"]);
// (extend as the build emits additional files)

// inside fetch handler, before /api/* routes:
if (req.method === "GET" && SERVABLE.has(url.pathname)) {
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const path = join(WEB_DIST, file);
  const type = file.endsWith(".html") ? "text/html; charset=utf-8"
              : file.endsWith(".js") ? "application/javascript; charset=utf-8"
              : file.endsWith(".css") ? "text/css; charset=utf-8"
              : "application/octet-stream";
  return new Response(await readFile(path), { headers: { "Content-Type": type } });
}
```

The token gate stays the same for `/api/*`. The HTML/CSS/JS at the root is fine to serve unauthenticated (it's just markup; the data behind `/api/*` is gated).

- [ ] **Step 2: Delete `src/ui/page/`**

`git rm -r src/ui/page/`. Confirm nothing else imports from it (`grep -r "ui/page"` should be clean after deletion).

- [ ] **Step 3: README + docs**

A short "Web UI" section in `README.md` noting: built with React, build via `bun run build:web`, dev via `bun run dev:web`, served by the daemon from `dist/web/`.

- [ ] **Step 4: Build, test, full pass**

```bash
bun run build:web
bun test            # still 262 green (backend untouched)
mise run lint       # or `bun run lint`
bun typecheck
```

Start daemon, visual QA every surface against the parity checklist in the spec. Stop daemon.

- [ ] **Step 5: Version bumps + commit**

```bash
bun run bump:plugin-version
bun run bump:marketplace-version
git add src/ui/server.ts README.md .claude-plugin/
git rm -r src/ui/page/
git commit -m "feat(web): cut over Bun.serve to the React app; delete src/ui/page/"
```

- [ ] **Step 6: Push, open PR**

```bash
git push -u origin feat/web-react-rewrite
gh pr create --title "feat(web): React rewrite with shared component library" --body "<short body referencing the spec>"
```

Do NOT auto-merge — the user reviews and merges.

---

## Self-Review

**Spec coverage:** all of Spec §file-structure, §cross-cutting-solutions, §build-serve, §behavior-parity-checklist are addressed across phases 0–9. ✓

**Phase ordering:** strict serial; each phase only mentions files within its own scope plus shared files (`package.json`) which are extended additively. No phase needs another's output that isn't already locked. ✓

**Tooling:** mise + hk + Biome + ESLint all in Phase 0; every later phase runs lint+typecheck before committing. ✓

**Done definition:** Phase 9 explicitly checks against the parity checklist before pushing. ✓

**Risks flagged in phases:**
- Phase 4: chat streaming protocol must be ported faithfully.
- Phase 6: slash popover behavior + intercepts must match today exactly.
- Phase 9: the `dist/web/` path resolution from `src/ui/server.ts` depends on `import.meta.dir` — verify the relative path.

**Out-of-scope reminders:** no new features, no backend changes, no test coverage for UI layouts.
