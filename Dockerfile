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
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git gnupg ripgrep jq unzip less openssl passwd \
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

# `useradd` lives in /usr/sbin, which our minimal ENV PATH intentionally
# omits — call it by absolute path so the build doesn't fail with
# "useradd: not found".
RUN /usr/sbin/useradd -m -s /bin/bash claude
USER claude
WORKDIR /home/claude

RUN mkdir -p /home/claude/.npm-global \
    && npm config set prefix /home/claude/.npm-global \
    && npm install -g @anthropic-ai/claude-code
RUN curl -fsSL https://bun.sh/install | bash
# uv — jobs that clone Python repos (e.g. a `uv.lock` backend) use this to
# build a venv without falling back to raw pip.
RUN curl -fsSL https://astral.sh/uv/install.sh | sh

WORKDIR /app
COPY --chown=claude:claude package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY --chown=claude:claude . .

# Pre-build the web bundle so /ui/ is served from disk on first request
# (the daemon doesn't build on demand — without this dist/web/ui/ is missing
# and the SPA 404s).
RUN bun run build:web

# Unify all Claude session state under the persisted VOLUME (/app/.claude).
# sessions.json lives at <cwd>/.claude/clawdcode (= /app/.claude/clawdcode), but
# the agent's *transcripts* are written by the claude CLI to $HOME/.claude/
# projects (= /home/claude/.claude/projects) — which is NOT under the volume.
# Without this, `claude --resume <id>` finds no transcript after a restart, so
# every hook delivery starts a brand-new session and re-sends the full routine
# prompt. Symlink ~/.claude → /app/.claude so transcripts + sessions share the
# one volume and survive restarts. NOTE: the deploy must mount a *persistent*
# (named/host) volume here — an anonymous volume still resets per container.
RUN rm -rf /home/claude/.claude && mkdir -p /app/.claude \
    && ln -sfn /app/.claude /home/claude/.claude

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

ENTRYPOINT ["bun", "run", "src/index.ts"]
# `--web-host 0.0.0.0` is required so port forwarding works from outside the
# container — the daemon's default bind is loopback.
CMD ["start", "--web", "--web-host", "0.0.0.0"]
