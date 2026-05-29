FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_MAJOR=22 \
    HOME=/home/claude \
    BUN_INSTALL=/home/claude/.bun \
    PATH=/home/claude/.bun/bin:/home/claude/.npm-global/bin:/usr/local/bin:/usr/bin:/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git gnupg ripgrep jq unzip less openssl python3 passwd \
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

WORKDIR /app
COPY --chown=claude:claude package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY --chown=claude:claude . .

# Pre-build the web bundle so /ui/ is served from disk on first request
# (the daemon doesn't build on demand — without this dist/web/ui/ is missing
# and the SPA 404s).
RUN bun run build:web

EXPOSE 4632
VOLUME ["/app/.claude"]

ENTRYPOINT ["bun", "run", "src/index.ts"]
# `--web-host 0.0.0.0` is required so port forwarding works from outside the
# container — the daemon's default bind is loopback.
CMD ["start", "--web", "--web-host", "0.0.0.0"]
