# clawdcode Helm chart

Run the ClawdCode daemon + web UI on Kubernetes from the existing
[`Dockerfile`](../../Dockerfile).

## Quickstart

```sh
helm install clawdcode ./charts/clawdcode \
  --set secrets.anthropicApiKey=sk-ant-... \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=clawdcode.example.com
```

Then port-forward (or hit your Ingress):

```sh
kubectl port-forward svc/clawdcode 4632:4632
# → http://127.0.0.1:4632/ui/?token=<from web.token>
```

The daemon writes its auth token to `/app/.claude/clawdcode/web.token` on
first start. Read it with:

```sh
kubectl exec deploy/clawdcode -- cat /app/.claude/clawdcode/web.token
```

## Values cheat sheet

| Key | Default | Purpose |
| --- | --- | --- |
| `image.repository` | `ghcr.io/northisup/clawdcode` | Container image (the repo Dockerfile, hosted) |
| `image.tag` | `Chart.appVersion` | Image tag |
| `service.port` | `4632` | Web UI port (matches Dockerfile `EXPOSE`) |
| `persistence.enabled` | `true` | Mount a PVC at `/app/.claude` |
| `persistence.size` | `5Gi` | PVC size |
| `secrets.anthropicApiKey` | `""` | Required; goes into the auto-created Secret |
| `secrets.existingSecret` | `""` | BYO Secret with `ANTHROPIC_API_KEY` (+ optional `CLAWDCODE_WEB_TOKEN`) |
| `ingress.enabled` | `false` | Provision an Ingress |
| `resources` | 100m / 256Mi req · 1 CPU / 1Gi limit | Right-size to your load |

See [`values.yaml`](./values.yaml) for the full list.

## What gets created

- **Deployment** (replicas: 1, strategy: Recreate) — single-instance because the
  daemon is stateful.
- **Service** (ClusterIP, port 4632)
- **PVC** at `/app/.claude` — holds jobs, sessions, logs, and the web token.
- **Secret** with `ANTHROPIC_API_KEY` (skipped when `secrets.existingSecret` is set).
- **Ingress** (optional)
- **ServiceAccount** (optional, default-on)

## Notes

- Why `strategy: Recreate`? PVCs default to `ReadWriteOnce`, which can't
  attach to the rolled-out and rolled-in pod at the same time. Recreate
  trades a brief downtime gap for safe storage handoff.
- The daemon binds `0.0.0.0:4632` inside the pod (env vars set on the
  Deployment). Expose externally via the Service / Ingress / port-forward
  rather than `hostNetwork`.
- Liveness + readiness probes hit `/ui/` (returns 200 once the daemon is
  serving). Adjust `probes.*` if you wire up Anthropic-rate-limit aware
  behaviour later.
- The chart does not template a HorizontalPodAutoscaler — horizontal scaling
  isn't safe for a single-PVC, stateful daemon.
