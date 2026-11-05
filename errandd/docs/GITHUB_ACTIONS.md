# GitHub Actions monitoring

Errands can react to workflow status changes through the GitHub webhook receiver.
Subscribe the repository or organization webhook to **Workflow runs**, point it at
`https://<errandd>/api/webhooks/github`, and use the same secret as
`ERRANDD_GITHUB_WEBHOOK_SECRET`. A GitHub App needs Actions read permission and
its `workflow_run` event subscription. This monitors incoming events; it does not
poll historical runs or create GitHub webhook subscriptions automatically.

For deployment completion, create an errand such as `deployments.md`:

```markdown
---
on:
  - checks:
      workflow: https://github.com/teamclara/Clara_V1/actions/workflows/ci-deploy.yml
      branch: [main]
      conclusion: [success, failure, cancelled, timed_out]
---
Inspect this deployment's workflow run and report its outcome. Use the run URL,
head SHA and attempt from the event to identify the deployment. A successful
workflow alone is not proof that a particular fix is deployed: verify that the
deployed revision contains the fix before resolving its issue.
```

To react while a workflow starts as well as when it finishes, replace the
`conclusion` filter with `status: [queued, in_progress, completed]`. GitHub sends
workflow-run actions `requested`, `in_progress` and `completed`; the status filter
matches **`workflow_run.status`**, not the action. Only statuses GitHub actually
delivers can trigger an errand. Explicit `status` defaults the conclusion filter
to `[]` (any outcome), so unfinished runs without a conclusion can match. If both
filters are set, both must match.

| Filter | Values | Default |
| --- | --- | --- |
| `workflow` | Workflow URL, `ci-deploy.yml`, `.github/workflows/ci-deploy.yml`, or glob lists with `!` exclusions | Any check/workflow |
| `repo` | `owner/repo` globs with `!` exclusions | Any repository |
| `status` | Status globs such as `queued`, `in_progress`, `completed` | Completed events only |
| `conclusion` | `success`, `failure`, `cancelled`, `timed_out`, etc., with globs/exclusions | Failure, timed out, cancelled; any outcome when `status` is explicit |
| `branch` | Head-branch globs with `!` exclusions | Any branch |
| `name` / `only` | Check or workflow display-name globs | Any name |
| `ignore` | Display-name denylist | None |

A workflow URL binds both the repository and file, even if its display name
changes. File/path filters can be combined with `repo` to scope them. A workflow
filter matches only `workflow_run`, preventing individual `check_run`,
`check_suite`, or `workflow_job` notifications from triggering the same deployment
errand. Missing workflow identity does not match. Repeated delivery IDs are
processed once; distinct lifecycle changes can each trigger the errand.

Existing `checks: true` remains failure-only and ignores queued/running events.
Use the errand's **CI / checks hooks** editor to configure repository, workflow,
status and conclusion filters. Matching deliveries and their statuses appear in
the existing deliveries view; this does not add a separate workflow dashboard.
