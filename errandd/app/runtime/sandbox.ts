// Run a runtime's CLI inside a kubernetes-sigs/agent-sandbox pod instead of on
// the host: claim a pod from a SandboxWarmPool, `kubectl exec` the command into
// it, delete the claim on exit. Stdout is the CLI's own stream, so callers are
// unchanged. https://github.com/kubernetes-sigs/agent-sandbox

export interface SandboxConfig {
  warmPool: string;
  namespace: string;
  /** kubeconfig context; current context when unset. */
  context?: string;
}

// Only model/auth/telemetry vars cross into the pod; host PATH/HOME would break it.
const FORWARDED_ENV = /^(ANTHROPIC_|CLAUDE_|OTEL_|API_TIMEOUT_MS$)/;

const SCRIPT = `
set -u
k() { kubectl \${ERRANDD_SB_CONTEXT:+--context "$ERRANDD_SB_CONTEXT"} -n "$ERRANDD_SB_NAMESPACE" "$@"; }
pid=""
claim=$(printf '%s' "$ERRANDD_SB_CLAIM" | k create -f - -o name) || exit 1
cleanup() { [ -n "$pid" ] && kill "$pid" 2>/dev/null; k delete "$claim" --wait=false >/dev/null 2>&1; }
trap 'cleanup; exit 143' TERM INT
k wait --for=condition=Ready "$claim" --timeout=300s >/dev/null || { cleanup; exit 1; }
sb=$(k get "$claim" -o jsonpath='{.status.sandbox.name}')
pod=$(k get sandboxes.agents.x-k8s.io "$sb" -o jsonpath='{.metadata.annotations.agents\\.x-k8s\\.io/pod-name}')
printf '%s\\n' "$ERRANDD_SB_ENV" | k exec -i "\${pod:-$sb}" -- sh -c 'while IFS= read -r kv; do [ -n "$kv" ] && export "$kv"; done; exec "$@"' sh "$@" &
pid=$!
wait "$pid"; rc=$?
pid=""
cleanup
exit $rc
`;

/** Wrap a host argv so it runs in a freshly claimed sandbox pod. `lifetimeMs`
 *  backs up the trap: the controller deletes the claim if the daemon dies. */
export function sandboxCommand(
  args: string[],
  env: Record<string, string>,
  cfg: SandboxConfig,
  lifetimeMs: number,
  now = Date.now(),
): { argv: string[]; env: Record<string, string> } {
  const [exe = "", ...rest] = args;
  const claim = {
    apiVersion: "extensions.agents.x-k8s.io/v1beta1",
    kind: "SandboxClaim",
    metadata: { generateName: "errandd-" },
    spec: {
      warmPoolRef: { name: cfg.warmPool },
      lifecycle: { shutdownPolicy: "Delete", shutdownTime: new Date(now + lifetimeMs).toISOString() },
    },
  };
  // Values go over exec stdin, not argv, so tokens stay out of `ps` and API audit logs.
  const forwarded = Object.entries(env)
    .filter(([k, v]) => FORWARDED_ENV.test(k) && !v.includes("\n"))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  return {
    // The host's absolute CLI path means nothing in the pod; use its basename.
    argv: ["sh", "-c", SCRIPT, "errandd-sandbox", exe.split("/").pop() ?? exe, ...rest],
    env: {
      ...env,
      ERRANDD_SB_NAMESPACE: cfg.namespace,
      ERRANDD_SB_CONTEXT: cfg.context ?? "",
      ERRANDD_SB_CLAIM: JSON.stringify(claim),
      ERRANDD_SB_ENV: forwarded,
    },
  };
}
