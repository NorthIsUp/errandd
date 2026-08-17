FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_MAJOR=22 \
    HOME=/home/claude \
    BUN_INSTALL=/home/claude/.bun \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    PATH=/home/claude/.local/bin:/home/claude/.bun/bin:/home/claude/.npm-global/bin:/usr/local/bin:/usr/bin:/bin

# postgresql/build-essential/libpq-dev/locales: hook jobs that spin up a
# throwaway Postgres for backend tests (e.g. sentry-triage) were reinstalling
# these from scratch every run — burning apt-get + initdb time on every hook
# delivery. Baking them in means jobs only `initdb`/`pg_ctl start` at runtime.
# Without `locales`, initdb has no UTF-8 locale and silently creates a
# SQL_ASCII cluster; LANG/LC_ALL above plus the generated en_US.UTF-8 avoid it.
# procps: `ps` is not in debian-slim, and app/mcpReaper.ts reads the process
# table to kill MCP servers orphaned by ended sessions — without it the reaper
# silently no-ops and the container OOMs (orphans reach 0.5-2.2GB each).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git gnupg ripgrep jq unzip less openssl passwd procps \
        locales build-essential python3 python3-venv libpq-dev postgresql postgresql-client \
    && echo "en_US.UTF-8 UTF-8" > /etc/locale.gen && /usr/sbin/locale-gen \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# github-mcp-server — the official Go MCP server, registered in user scope so
# routines get structured GitHub tools. Installed as root, before the USER
# switch below, so no sudo is needed in the image.
ARG GH_MCP_VERSION=v1.1.2
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      arm64) rel="Linux_arm64" ;; \
      amd64) rel="Linux_x86_64" ;; \
      *) echo "unsupported arch $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/ghmcp.tgz \
      "https://github.com/github/github-mcp-server/releases/download/${GH_MCP_VERSION}/github-mcp-server_${rel}.tar.gz"; \
    tar -xzf /tmp/ghmcp.tgz -C /tmp github-mcp-server; \
    install -m 0755 /tmp/github-mcp-server /usr/local/bin/github-mcp-server; \
    rm -f /tmp/ghmcp.tgz /tmp/github-mcp-server; \
    github-mcp-server --version

# `useradd` lives in /usr/sbin, which our minimal ENV PATH intentionally
# omits — call it by absolute path so the build doesn't fail with
# "useradd: not found".
RUN /usr/sbin/useradd -m -s /bin/bash claude
USER claude
WORKDIR /home/claude

# Both exec runtimes ship in the image, so one build is deployable as either:
# ERRANDD_RUNTIME=claude (default) or ERRANDD_RUNTIME=pi. See src/runtime/.
#
# pi is pinned because it is a WIRE-FORMAT dependency — src/runtime/pi/stream.ts
# parses the JSON event schema pi 0.80.6 emits. Bump it deliberately and re-run
# `ERRANDD_E2E=1 bun test src/__tests__/runtime-e2e.test.ts`, which drives the
# real binary. Keep this version in lockstep with mise.toml.
#
RUN curl -fsSL https://bun.sh/install | bash
# claude-code is installed with bun (owner preference; it is also what produced
# a correct full-size binary when recovering the 2026-08-13 truncated-CLI
# incident). pi stays on npm: it needs its postinstall to fetch a native binary,
# so do NOT add --ignore-scripts there or `pi` dies with "native binary not
# installed". `--version` on both is a build-time smoke test — the same check
# app/cliHealth.ts runs at boot, so a broken install fails the build, not a
# routine at 03:00.
RUN mkdir -p /home/claude/.npm-global \
    && npm config set prefix /home/claude/.npm-global \
    && npm install -g @earendil-works/pi-coding-agent@0.80.6 @sentry/mcp-server \
    && bun add -g @anthropic-ai/claude-code \
    && claude --version && pi --version
# uv — jobs that clone Python repos (e.g. a `uv.lock` backend) use this to
# build a venv without falling back to raw pip.
RUN curl -fsSL https://astral.sh/uv/install.sh | sh

WORKDIR /app
COPY --chown=claude:claude package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY --chown=claude:claude . .

# Pre-build the web bundle so /ui/ is served from disk on first request. This
# is THE reason to deploy this image rather than installing errandd as a plugin
# at runtime: the plugin payload is a git clone with dist/ and node_modules/
# gitignored, so it had to `bun install` and bundle on every boot — which is
# network-, disk- and memory-dependent, and failed silently for the life of a
# deploy when any of those were short.
#
# NODE_ENV is set on this line only, not as an ENV: web/build.ts gates minify on
# it (the deployed bundle was 13.2MB unminified), but a global NODE_ENV=production
# would make the `bun install` above skip the devDependencies the bundler needs.
RUN NODE_ENV=production bun run build:web

# Unify all Claude session state under the persisted VOLUME (/app/.claude).
# sessions.json lives at <cwd>/.claude/errandd (= /app/.claude/errandd), but
# the agent's *transcripts* are written by the claude CLI to $HOME/.claude/
# projects (= /home/claude/.claude/projects) — which is NOT under the volume.
# Without this, `claude --resume <id>` finds no transcript after a restart, so
# every hook delivery starts a brand-new session and re-sends the full routine
# prompt. Symlink ~/.claude → /app/.claude so transcripts + sessions share the
# one volume and survive restarts. NOTE: the deploy must mount a *persistent*
# (named/host) volume here — an anonymous volume still resets per container.
RUN rm -rf /home/claude/.claude && mkdir -p /app/.claude \
    && ln -sfn /app/.claude /home/claude/.claude

# Stage plugin installs on the SAME filesystem as ~/.claude. `claude plugin
# install` and the boot preflight clone into $TMPDIR then rename() into
# ~/.claude/plugins/; with the default /tmp that is a cross-device rename and
# every install dies with "EXDEV: cross-device link not permitted" (seen for
# real: superpowers-marketplace, northisup-skillz and anthropic-agent-skills all
# failed this way on a first boot). The daemon re-creates this at startup too,
# since a mounted volume arrives empty.
ENV TMPDIR=/app/.claude/tmp
RUN mkdir -p /app/.claude/tmp

# Same problem, same fix, for the pi runtime: pi keeps its sessions (and
# auth.json) under ~/.pi/agent/, which is NOT on the volume. Without this,
# `pi --session <id>` finds nothing after a restart and every resume silently
# starts a fresh session — the exact failure the claude symlink above prevents.
# Nested under /app/.claude so the one existing VOLUME covers both runtimes.
RUN rm -rf /home/claude/.pi && mkdir -p /app/.claude/pi \
    && ln -sfn /app/.claude/pi /home/claude/.pi

# Which coding-agent CLI actually executes prompts. "claude" (default) or "pi".
# Both binaries are present, so switching runtimes is a redeploy with a
# different value, not a different image. An unknown value warns and falls back
# to claude (src/runtime/select.ts).
ENV ERRANDD_RUNTIME=claude

EXPOSE 4632
VOLUME ["/app/.claude"]

# Readiness gate for zero-downtime rollouts: /readyz is 503 until startup
# finishes (and again while draining for shutdown), 200 when ready. The daemon
# takes ~a minute to fully initialize, so allow a generous start-period before
# failures count. Uses bun (the runtime — guaranteed present) rather than curl.
# NOTE: orchestrators that don't read Docker HEALTHCHECK (k8s, Fly) should point
# their own readiness probe at /readyz too; liveness goes to /healthz.
HEALTHCHECK --start-period=90s --interval=10s --timeout=5s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:4632/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["bun", "run", "app/index.ts"]
# `--web-host 0.0.0.0` is required so port forwarding works from outside the
# container — the daemon's default bind is loopback.
CMD ["start", "--web", "--web-host", "0.0.0.0"]
