<p align="center">
  <img src="images/clawdcode-banner.svg" alt="ClawdCode Banner" />
</p>
<p align="center">
  <img src="images/clawdcode-wordmark.png" alt="ClawdCode Wordmark" />
</p>

<p align="center">
  <img src="https://awesome.re/badge.svg" alt="Awesome" />
  <a href="https://github.com/moazbuilds/ClawdCode/stargazers">
    <img src="https://img.shields.io/github/stars/moazbuilds/ClawdCode?style=flat-square&color=f59e0b" alt="GitHub Stars" />
  </a>
  <a href="https://github.com/moazbuilds/ClawdCode">
    <img src="https://img.shields.io/static/v1?label=downloads&message=~15k%20every%2014%20days&color=2da44e&style=flat-square" alt="Downloads ~15k every 14 days" />
  </a>
  <a href="https://github.com/moazbuilds/ClawdCode/commits/master">
    <img src="https://img.shields.io/github/last-commit/moazbuilds/ClawdCode?style=flat-square&color=0ea5e9" alt="Last Commit" />
  </a>
  <a href="https://github.com/moazbuilds/ClawdCode/graphs/contributors">
    <img src="https://img.shields.io/github/contributors/moazbuilds/ClawdCode?style=flat-square&color=a855f7" alt="Contributors" />
  </a>
  <a href="https://x.com/moazbuilds">
    <img src="https://img.shields.io/badge/X-%40moazbuilds-000000?style=flat-square&logo=x" alt="X @moazbuilds" />
  </a>
</p>

<p align="center"><b>A lightweight, open-source OpenClaw version built into your Claude Code.</b></p>

ClawdCode turns your Claude Code into a personal assistant that never sleeps. It runs as a background daemon, executing tasks on a schedule, responding to messages on Telegram, Discord, and Slack, transcribing voice commands, and integrating with any service you need.

> Note: Please don't use ClawdCode for hacking any bank system or doing any illegal activities. Thank you.

## Why ClawdCode?

| Category | ClawdCode | OpenClaw |
| --- | --- | --- |
| Anthropic Will Come After You | No | Yes |
| API Overhead | Directly uses your Claude Code subscription | Nightmare |
| Setup & Installation | ~5 minutes | Nightmare |
| Deployment | Install Claude Code on any device or VPS and run | Nightmare |
| Isolation Model | Folder-based and isolated as needed | Global by default (security nightmare) |
| Reliability | Simple reliable system for agents | Bugs nightmare |
| Feature Scope | Lightweight features you actually use | 600k+ LOC nightmare |
| Security | Average Claude Code usage | Nightmare |
| Cost Efficiency | Efficient usage | Nightmare |
| Memory | Uses Claude internal memory system + `CLAUDE.md` | Nightmare |

## Getting Started in 5 Minutes

```bash
claude plugin marketplace add moazbuilds/clawdcode
claude plugin install clawdcode
```
Then open a Claude Code session and run:
```
/clawdcode:start
```
The setup wizard walks you through model, heartbeat, Telegram, Discord, Slack, and security, then your daemon is live with a web dashboard.

## Configuration & environment overrides

`.claude/clawdcode/settings.json` is the source of truth for all ClawdCode config. Every field can be overridden by a `CLAWDCODE_*` environment variable — env always wins over the file. The bare token names `TELEGRAM_TOKEN`, `DISCORD_TOKEN`, `SLACK_BOT_TOKEN`, and `SLACK_APP_TOKEN` still work as aliases for their `CLAWDCODE_*` counterparts.

Nested arrays and objects (heartbeat exclude windows, agentic modes, allowed user IDs, plugins) are file-only; there are no env vars for those.

See `.env.example` for the full variable list with defaults and descriptions.

**Jobs repo:** set `jobsRepo.url` (or `CLAWDCODE_JOBSREPO_URL`) to a git URL and ClawdCode will clone it on start and pull it on the configured interval (`jobsRepo.intervalSeconds` / `CLAWDCODE_JOBSREPO_INTERVAL`, default 300 s). That repo becomes the jobs directory — a clean way to manage your task queue in version control.

## Run with Docker

```bash
docker build -t clawdcode .
docker run -p 4632:4632 -v $PWD/.claude:/app/.claude --env-file .env clawdcode
```

Config is supplied via `CLAWDCODE_*` env vars — copy `.env.example` to `.env` and fill in your values, then pass it with `--env-file .env`.

State (jobs, logs, generated tokens) persists in the mounted `.claude` volume. Claude authentication comes from one of:
- the mounted `.claude` volume if it already contains credentials from a local `claude` login, or
- a `CLAUDE_CODE_OAUTH_TOKEN` env var obtained by running `claude setup-token` and pasting the result.

### Contributor Note: Plugin Version Metadata

If you change shipped plugin files under `src/`, `commands/`, `prompts/`, or `.claude-plugin/`, the plugin metadata version may also need to be bumped so Claude Code and marketplace consumers detect the update correctly.

Helpers:

```bash
bun run bump:plugin-version
bun run bump:marketplace-version
```

Docs-only and other non-shipped changes do not require these bumps.

## Upgrading

### v1.0.26 — Allowlist behavior change (Telegram & Discord)

Prior to this release, an empty `allowedUserIds` list meant **allow everyone**. That was a potential security vulnerability; any Telegram or Discord user could drive the daemon.

**New behavior:** an empty list means **block everyone**. The daemon will refuse to start if a bot token is configured without at least one allowed user ID.

**Migration:** add your user ID(s) to `settings.json` before upgrading:

```json
"telegram": { "allowedUserIds": [123456789] },
"discord":  { "allowedUserIds": ["987654321012345678"] }
```

Run `clawdcode config` for guided setup if you're unsure of your user ID.

### v1.1.0 — Web UI bearer token gate

All `/api/*` routes (except `/api/health`) now require an `Authorization: Bearer <token>` header. The token is auto-generated on first start and written to `.claude/clawdcode/web.token`. The daemon also prints the full URL with the token embedded when the web UI starts.

**Migration:** update any scripts that call `/api/state` or other API routes to pass the token:

```
Authorization: Bearer <contents of .claude/clawdcode/web.token>
```

Existing `/api/inject` users who configured `settings.apiToken` are unaffected; that fallback still works.

### v1.1.0 — Discord text-attachment truncation limit reduced

Text attachments sent to the Discord bot are now truncated at **2,048 bytes** (previously 51,200). Payloads over that limit have `…[truncated]` appended silently; there is no config knob to restore the old limit.

**Migration:** if you rely on passing large text files through Discord attachments, switch to gists or another file-sharing mechanism and paste the URL instead.

---

## What Would Be Built Next?

> **Mega Post:** Help shape the next ClawdCode features.
> Vote, suggest ideas, and discuss priorities in **[this post](https://github.com/moazbuilds/clawdcode/issues/14)**.

<p align="center">
  <a href="https://github.com/moazbuilds/clawdcode/issues/14">
    <img src="https://img.shields.io/badge/Roadmap-Mega%20Post-blue?style=for-the-badge&logo=github" alt="Roadmap Mega Post" />
  </a>
</p>

## Features

### Automation
- **Heartbeat:** Periodic check-ins with configurable intervals, quiet hours, and editable prompts.
- **Cron Jobs:** Timezone-aware schedules for repeating or one-time tasks with reliable execution.

### Communication
- **Telegram:** Text, image, and voice support.
- **Discord:** DMs, server mentions/replies, slash commands, voice messages, and image attachments.
- **Slack:** Socket Mode bot — DMs, channel mentions, threads, voice messages, and file attachments. Configure `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in your environment or `settings.json`.
- **Time Awareness:** Message time prefixes help the agent understand delays and daily patterns.

### Multi-Session Threads (Discord)
- **Independent Thread Sessions:** Each Discord thread gets its own Claude CLI session, fully isolated from the main channel.
- **Parallel Processing:** Thread conversations run concurrently — messages in different threads don't block each other.
- **Auto-Create:** First message in a new thread automatically bootstraps a fresh session. No setup needed.
- **Session Cleanup:** Thread sessions are automatically cleaned up when threads are deleted or archived.
- **Backward Compatible:** DMs and main channel messages continue using the global session.

See [docs/MULTI_SESSION.md](docs/MULTI_SESSION.md) for technical details.

### Reliability and Control
- **GLM Fallback:** Automatically continue with GLM models if your primary limit is reached.
- **Web Dashboard:** Manage jobs, monitor runs, and inspect logs in real time.
- **Security Levels:** Four access levels from read-only to full system access.
- **Model Selection:** Switch models based on your workload.

## Web UI

The web dashboard is a React + TypeScript app (`web/`) built with Bun's built-in bundler and served by the daemon from `dist/web/`.

**Build:** `bun run build:web` → outputs `dist/web/{index.html,app.js,app.css}`.

**Dev (watch mode):** `bun run dev:web` → rebuilds on file changes for fast iteration.

**Served at:** `/` — the daemon serves `index.html` there; `/app.js` and `/app.css` are served directly. All `/api/*` routes are unchanged and token-gated as before.

**Stack:** React 18, CSS Modules + tokens.css, Radix UI primitives (Dialog/Popover/Tooltip/Toast), hash routing, plain fetch + typed wrappers. Biome (strict) + ESLint (strict React rules) enforced via hk pre-commit hooks.

## FAQ

<details open>
  <summary><strong>Can ClawdCode do &lt;something&gt;?</strong></summary>
  <p>
    If Claude Code can do it, ClawdCode can do it too. ClawdCode adds cron jobs,
    heartbeats, and Telegram/Discord/Slack bridges on top. You can also give your ClawdCode new
    skills and teach it custom workflows.
  </p>
</details>

<details open>
  <summary><strong>Is this project breaking Anthropic ToS?</strong></summary>
  <p>
    No. ClawdCode is local usage inside the Claude Code ecosystem. It wraps Claude Code
    directly and does not require third-party OAuth outside that flow.
    If you build your own scripts to do the same thing, it would be the same.
  </p>
</details>

<details open>
  <summary><strong>Will Anthropic sue you for building ClawdCode?</strong></summary>
  <p>
    I hope not.
  </p>
</details>

<details open>
  <summary><strong>Are you ready to change this project name?</strong></summary>
  <p>
    If it bothers Anthropic, I might rename it to OpenClawd. Not sure yet.
  </p>
</details>

## Screenshots

### Claude Code Folder-Based Status Bar
![Claude Code folder-based status bar](images/bar.png)

### Cool UI to Manage and Check Your ClawdCode
![Cool UI to manage and check your ClawdCode](images/dashboard.png)

## Contributors

Thanks for helping make ClawdCode better.

<a href="https://github.com/moazbuilds/clawdcode/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=moazbuilds/clawdcode" />
</a>
