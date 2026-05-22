FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_MAJOR=22 \
    HOME=/home/claude \
    BUN_INSTALL=/home/claude/.bun \
    PATH=/home/claude/.bun/bin:/home/claude/.npm-global/bin:/usr/local/bin:/usr/bin:/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git gnupg ripgrep jq unzip less openssl python3 \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash claude
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

ENV CLAUDECLAW_WEB_ENABLED=true \
    CLAUDECLAW_WEB_HOST=0.0.0.0 \
    CLAUDECLAW_WEB_PORT=4632

EXPOSE 4632
VOLUME ["/app/.claude"]

ENTRYPOINT ["bun", "run", "src/index.ts"]
CMD ["start", "--web"]
