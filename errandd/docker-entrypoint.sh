#!/bin/sh
# Container entrypoint: point the CLI's canonical config paths at persistent
# storage, then exec the daemon.
#
# The agent CLI insists on ~/.claude/ and ~/.claude.json. Where those should
# actually live differs per deployment, so this resolves it once at startup
# instead of baking one answer into the image:
#
#   ERRANDD_STATE_DIR unset (plain `docker run`)
#     ~/.claude -> /app/.claude, the image's VOLUME. Unchanged behaviour.
#
#   ERRANDD_STATE_DIR=/path (Kubernetes)
#     ~/.claude      -> $ERRANDD_STATE_DIR/claude
#     ~/.claude.json -> $ERRANDD_STATE_DIR/claude.json
#
# The split layout matters: ~/.claude.json sits one level ABOVE ~/.claude, so a
# single volume can hold both only if the volume is mounted as their parent.
# Mounting the file directly with a subPath is not an option — the CLI rewrites
# it by atomic rename(2), and a single-file bind mount pins an inode, so the
# rename lands on a new inode while the mount keeps shadowing the old one. The
# writes then go to a different file than the reads, and onboarding state is
# silently lost across restarts. Symlinks into a directory mount have neither
# problem.
set -e

STATE_DIR="${ERRANDD_STATE_DIR:-}"

if [ -n "$STATE_DIR" ]; then
    mkdir -p "$STATE_DIR/claude"
    [ -e "$STATE_DIR/claude.json" ] || echo '{}' > "$STATE_DIR/claude.json"

    # -n so we replace a symlink rather than dereference into it, and rm -rf
    # first because the image ships ~/.claude as a symlink to /app/.claude.
    rm -rf "$HOME/.claude" "$HOME/.claude.json"
    ln -sfn "$STATE_DIR/claude" "$HOME/.claude"
    ln -sfn "$STATE_DIR/claude.json" "$HOME/.claude.json"

    # Plugin installs rename(2) out of $TMPDIR into ~/.claude/plugins, which
    # fails with EXDEV across filesystems — keep it on the state volume.
    export TMPDIR="$STATE_DIR/claude/tmp"
    mkdir -p "$TMPDIR"

    # Run from $HOME, not the image's WORKDIR. errandd keeps its OWN state
    # (sessions, run ledger, jobs, daemon.pid) under $PWD/.claude/errandd — with
    # cwd=/app that lands on the container filesystem and is lost on every
    # restart, while ~/.claude points at the volume. Matching cwd to $HOME is
    # what makes errandd's state resolve through the symlink onto the volume.
    cd "$HOME"

    echo "errandd: state dir $STATE_DIR (~/.claude -> $STATE_DIR/claude, cwd $HOME)"
fi

exec bun run /app/app/index.ts "$@"
