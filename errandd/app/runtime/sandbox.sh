#!/bin/sh
# Run "$@" in a pod claimed from an agent-sandbox SandboxWarmPool, then release it.
# Inputs come from env (see sandbox.ts); stdout is the command's own stream.
set -u
k() { kubectl ${ERRANDD_SB_CONTEXT:+--context "$ERRANDD_SB_CONTEXT"} -n "$ERRANDD_SB_NAMESPACE" "$@"; }
pid=""
claim=$(printf '%s' "$ERRANDD_SB_CLAIM" | k create -f - -o name) || exit 1
cleanup() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
  k delete "$claim" --wait=false >/dev/null 2>&1
}
trap 'cleanup; exit 143' TERM INT
k wait --for=condition=Ready "$claim" --timeout=300s >/dev/null || { cleanup; exit 1; }
sb=$(k get "$claim" -o jsonpath='{.status.sandbox.name}')
pod=$(k get sandboxes.agents.x-k8s.io "$sb" -o jsonpath='{.metadata.annotations.agents\.x-k8s\.io/pod-name}')
target="${pod:-$sb}"
# Enabled plugins and Claude settings from the daemon (see sandboxKit.ts). A failed
# copy is loud but not fatal: the job still runs, just without plugin skills.
if [ -n "${ERRANDD_SB_KIT:-}" ]; then
  # shellcheck disable=SC2016 # $HOME expands inside the pod
  printf '%s\n' "$ERRANDD_SB_KIT" | (cd "$ERRANDD_SB_CLAUDE_DIR" && tar czf - -T -) |
    k exec -i "$target" -- sh -c 'mkdir -p "$HOME/.claude" && tar xzf - -C "$HOME/.claude"' ||
    echo "errandd-sandbox: copying plugins into $target failed" >&2
fi
# Env arrives on stdin so tokens stay out of argv. A host cwd usually doesn't
# exist in the pod; say so instead of failing, and keep the template's workdir.
# shellcheck disable=SC2016 # $1/$@ expand inside the pod, not here
printf '%s\n' "$ERRANDD_SB_ENV" | k exec -i "$target" -- sh -c '
  while IFS= read -r kv; do [ -n "$kv" ] && export "$kv"; done
  dir=$1; shift
  if [ -n "$dir" ] && ! cd "$dir" 2>/dev/null; then
    echo "errandd-sandbox: cwd $dir not in pod, using template workdir" >&2
  fi
  exec "$@"' sh "${ERRANDD_SB_CWD:-}" "$@" &
pid=$!
wait "$pid"
rc=$?
pid=""
cleanup
exit "$rc"
