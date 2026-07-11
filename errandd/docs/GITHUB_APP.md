# errandd GitHub App — spec

Status: **proposed**. This describes giving errandd its own GitHub App identity so it can

- be **`@errandd`-mentioned** in a PR/issue comment as a first-class hook trigger, and
- **clone/fetch/push any installed repo on demand** via a per-installation token —

which makes the `clone-base-repo` routine and the pre-provisioned container `gh` token obsolete.

## Why

Today errandd _posts_ as a GitHub App bot, but the daemon doesn't **manage** the App: it borrows whatever token
`gh auth setup-git` left in the container (`app/jobsRepo.ts:63`), and every repo it touches must be cloned ahead of time
(that's the whole job of `clone-base-repo.md`). GitHub `@`-mentions are parsed ad-hoc inside `pr-comments`; only **Linear**
has a real `@mention` gate (`app/hooks/schema.ts`, `app/hooks/match.ts`).

A managed App fixes all three:

| Problem today | With the App |
| --- | --- |
| Repo must be pre-cloned (`clone-base-repo`) | Mint an installation token → clone/fetch on demand |
| One global PAT, broad scope | Per-installation, least-privilege, short-lived tokens |
| `@errandd` on GitHub is ad-hoc body parsing | A first-class `github` mention trigger, like Linear's |

## 1. Register the App (manual, one-time)

Register a **GitHub App** (not an OAuth App — the App gives both the mention identity and installation tokens).

- **Name:** `errandd` (globally unique; the name is what makes the bot `@errandd`). Grab it early.
- **Owner:** prefer an **org** (transferable, team-managed). A personal account works and can be transferred later.
- **Repository permissions:** Contents **R/W**, Pull requests **R/W**, Issues **R/W**, Checks **R**, Commit statuses **R**,
  Metadata **R** (mandatory). Add **Members R** (org perm) only if you want team-scoped access.
- **Subscribe to events:** `pull_request`, `pull_request_review`, `pull_request_review_comment`, `issue_comment`,
  `issues`, `check_suite`, `check_run`. (These map 1:1 to the routines' `on:` triggers.)
- **Webhook:** URL → errandd's `POST /api/webhooks/github`; secret → the same value as `ERRANDD_GITHUB_WEBHOOK_SECRET`.
  Both are editable after creation.
- **Skip** "Request user authorization (OAuth) during installation" unless you later want user-identity login — the
  installation token already covers clone/push and acting as `@errandd`.
- After creating: **generate + download the private key** (`.pem`), note the **App ID**, then **Install** the App on the
  repos/org errandd should access.

Outputs you hand to the daemon: **App ID**, **private key (PEM)**. (Installation IDs are discovered at runtime.)

## 2. Daemon: installation-token auth

New module `app/github/app.ts` (name TBD):

1. **App JWT** — sign `{iat, exp (≤10m), iss: appId}` with the PEM (RS256). Used only to talk to the `/app/*` endpoints.
2. **Installation token** — `POST /app/installations/{installation_id}/access_tokens` → a token valid ~1h, scoped to that
   installation's repos + the granted permissions. Discover installations via `GET /app/installations` (cache
   `owner → installation_id`).
3. **Cache + refresh** — cache `installation_id → {token, expiresAt}`; refresh when `expiresAt - now < 5m`. Tokens are
   secrets: never log them, and add the key to `SECRET_KEYS` (`app/ui/services/state.ts`) so state dumps redact them.
4. **git credential helper** — configure `git`/`gh` to use the installation token for a given owner. Either a transient
   `git -c credential.helper=…` per invocation, or write `https://x-access-token:<token>@github.com` into a per-run
   askpass. `gh` picks up `GH_TOKEN=<installation-token>` in the routine's env.

**Fallback:** if no App is configured (`github.appId` unset), keep today's behavior (the container's `gh` token). The App
path is opt-in; nothing breaks for a single-repo local setup.

## 3. On-demand clone (replaces `clone-base-repo`)

Helper `ensureRepoCheckout(owner, repo, ref?) → dir`:

- Resolve the installation token for `owner`.
- If the checkout dir is missing, `git clone https://x-access-token:<token>@github.com/<owner>/<repo>` into a stable path
  (e.g. `<state>/repos/<owner>/<repo>`); else `git fetch --all --prune`.
- Return the dir. Worktree-per-PR logic (already in `pr-babysit`) layers on top unchanged, just against a checkout errandd
  provisioned instead of one `clone-base-repo` pre-made.

**Effect on the jobs repo:** delete `clone-base-repo.md`; routines stop referencing a hand-maintained `<repo-dir>` and
instead assume errandd hands them a fresh checkout. Document the `ensureRepoCheckout` contract in the jobs README.

## 4. `@errandd` GitHub mention trigger

Add a mention gate to the GitHub comment path, mirroring Linear's (`schema.ts` `mention: boolean`, `match.ts`
`matchLinearRule`):

- New trigger shape: `- comments: { mention: true }` (or a dedicated `- mention: true`) fires a routine **only** when the
  comment body `@`-mentions the App's bot login.
- Bot login comes from config (`github.botLogin`, default derived from the App slug, e.g. `errandd[bot]`), so a rename or a
  differently-named App still resolves.
- This is the clean home for "someone typed `@errandd fix the failing test`" → spawn a routine on that PR/issue thread.
  It supersedes the ad-hoc `@`-parsing in `pr-comments`.

## 5. Config & secrets

`settings.github` (all overridable by `ERRANDD_*` env, per the existing pattern):

| Field | Env | Meaning |
| --- | --- | --- |
| `github.appId` | `ERRANDD_GITHUB_APP_ID` | App ID (enables the App path when set) |
| `github.privateKey` | `ERRANDD_GITHUB_APP_PRIVATE_KEY` | PEM contents (or `…_PRIVATE_KEY_FILE` for a path) |
| `github.botLogin` | `ERRANDD_GITHUB_BOT_LOGIN` | Mention handle, default from the App slug |

Helm: add a `secrets.githubAppPrivateKey` value → mounted/`env`-injected like `secrets.anthropicApiKey`. The webhook
secret already exists (`ERRANDD_GITHUB_WEBHOOK_SECRET`).

## 6. Security

- Installation tokens are **short-lived** (~1h) and **least-privilege** (only granted permissions, only installed repos).
- Private key never leaves the secret store; never logged; redacted in state dumps.
- The webhook HMAC (`X-Hub-Signature-256`) already authenticates inbound events — unchanged.
- A per-owner token means a routine acting on repo A can't reach repo B unless the App is installed there too.

## 7. Build phases

1. **Auth core** — JWT + installation-token mint/cache + git credential helper; unit-tested against a fake JWKS/token
   endpoint. Fallback to the container token when unconfigured.
2. **On-demand clone** — `ensureRepoCheckout`; wire the runner to provision a checkout for PR/issue routines; delete
   `clone-base-repo` from the jobs defaults.
3. **`@errandd` mention trigger** — the `github` mention gate + schema + a routine that answers a mention.
4. **Config/Helm/docs** — settings, chart secret, `.env.example`, and a jobs-README note on the new checkout contract.

Each phase is independently shippable; phase 1 unlocks 2 and 3.
