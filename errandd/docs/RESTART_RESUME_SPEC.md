# Spec: Restart-and-Resume

## Problem

When a Errandd agent needs to restart its own host process (e.g. to pick up a new config, apply a service file change, or deploy updated code), it issues a command like:

```bash
sudo systemctl restart my-service
```

This kills the systemd service — which is the process running the CC session that issued the command. The result:

- The Bash tool receives exit code 144 (process killed mid-execution)
- The CC session is terminated before it can send a reply
- The agent cannot confirm success to the user
- If the session had a pending Discord/Telegram reply queued, it is lost
- If the session is resumed later (e.g. user sends another message), CC resumes the old context and may re-run the restart command, causing a second unnecessary restart

This is a fundamental gap: agents that manage their own lifecycle have no clean way to restart and report back.

## Current workaround

Agents can fire a detached restart:

```bash
nohup bash -c 'sleep 2 && sudo systemctl restart my-service' &
```

This lets the session exit cleanly before the kill arrives. But the agent still cannot send a post-restart confirmation — the session is gone and there is no mechanism for the new instance to know what to report.

A static message queue could patch over this, but it has a fundamental flaw: any message written *before* the restart was composed before the restart happened. It cannot check whether the service came up cleanly, whether the config was applied correctly, or whether any side effects succeeded. A pre-written "restarted successfully" that fires unconditionally is worse than no message: it lies when things go wrong.

## Proposed Solution: Pending Session Resume

Errandd provides a file-based mechanism for agents to schedule a **session continuation** after the next startup. Rather than queuing a static reply, the agent schedules itself to be woken up with a prompt, and the resumed Claude session runs normally — with full tool access, original context, and the ability to observe post-restart state before composing a reply.

### Flow

1. Before triggering the restart, the agent writes `pending-resume.json` to a well-known location:

```json
// .claude/errandd/pending-resume.json
{
  "transport": "discord",
  "channelId": "1234567890",
  "threadId": "9876543210",
  "sessionKey": "1234567890",
  "wakeUpPrompt": "The service was just restarted. Verify it came up cleanly (check systemctl status, recent logs), then report back to the user on the outcome.",
  "expires": 1746100000000
}
```

2. Agent fires the detached restart and ends the session cleanly.

3. On the next startup, after the transport gateway reports ready (Discord READY event, Telegram polling start), Errandd reads the file to check the transport, then atomically renames it (preventing double-fire on crash) and calls `runUserMessage` with the stored session key and wake-up prompt.

4. The resumed Claude session runs as a normal turn — it has all its original context, can run tools, read logs, check process state — and its output is delivered to the stored channel and thread.

### File schema

| Field | Type | Description |
|-------|------|-------------|
| `transport` | `"discord" \| "telegram"` | Which transport delivers the reply |
| `channelId` | string | Discord channel snowflake or Telegram chat ID |
| `threadId` | string? | Discord thread ID |
| `sessionKey` | string? | Key in `sessions.json` for the session to resume; omit to resume the global session |
| `agentName` | string? | Agent working-directory name if the session is agent-scoped |
| `wakeUpPrompt` | string | Injected as the next user turn; should describe the context and what to verify |
| `expires` | number? | Unix milliseconds; files past this timestamp are silently discarded |

### Startup hook location

The hook fires once per process lifetime, immediately after the gateway reports ready — before any incoming user messages are processed:

**Discord** — in the `READY` case of the gateway message handler:
```typescript
runPendingResume(token).catch(/* log */);
```

**Telegram** — in `startPolling`, before the poll loop starts:
```typescript
await runPendingResumeTelegram().catch(/* log */);
```
The resume is wrapped so that a failure does not prevent polling from starting.

The file is parsed first to check the transport, then renamed atomically before executing the wake-up. If the wake-up throws, the file is already gone, so a subsequent crash-restart does not re-fire (prefer a lost message over a duplicate restart confirmation).

A module-level `consumed` guard in `pending-resume.ts` ensures the file is only loaded once even if multiple transports are initialised in the same process.

### Implementation

- **`src/pending-resume.ts`** — defines `PendingResume` interface and `loadPendingResume()` function
- **`src/commands/discord.ts`** — calls `runPendingResume()` in READY handler
- **`src/commands/telegram.ts`** — calls `runPendingResumeTelegram()` in `startPolling`

## Why session continuation, not a static message queue

The critical distinction: the agent isn't pre-writing a reply, it's pre-scheduling a **verification step**.

A static queue requires the agent to write the confirmation before the restart — at a point when it cannot know whether the restart will succeed. The resumed Claude session, by contrast, runs after the restart, in the new process, and can:

- Check `systemctl status`
- Read recent logs
- Verify config was applied
- Run any other diagnostic tool

The confirmation the user sees is composed after the restart, by a Claude instance that can actually observe the post-restart state. A static "restarted successfully" that fires unconditionally is worse than no message: it misinforms when things go wrong.

Errandd already has all the session resume infrastructure needed for this (the `--resume` flag, `sessions.json`, `sessionManager`). The only gap was a startup hook that fires proactively, without waiting for the next user message. This patch fills that gap.

## Wait-for-idle before restart

If other sessions are running concurrently (e.g. a long-running thread task), an agent that restarts immediately will interrupt them mid-run.

Errandd writes the current active session count to `.claude/errandd/active-runs` (a plain integer file) whenever a session starts or finishes. Agents can read this to decide whether to wait before restarting.

**Recommended pattern:**

```bash
# Count active sessions. My own session is included, so "idle" means count == 1.
count=$(cat .claude/errandd/active-runs 2>/dev/null || echo 1)
if [ "$count" -gt 1 ]; then
  # Post the waiting notification directly via the transport API — NOT as response text.
  # The CC session ends with a restart, so anything in the response stream is lost.
  # A direct API call goes out immediately, before the poll loop starts.
  curl -s -X POST "https://discord.com/api/v10/channels/$CHANNEL_ID/messages" \
    -H "Authorization: Bot $DISCORD_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"content\": \"Waiting for $((count - 1)) other session(s) to finish before restarting...\"}"

  while [ "$(cat .claude/errandd/active-runs 2>/dev/null || echo 1)" -gt 1 ]; do
    sleep 5
  done
fi

# Write pending-resume.json, then trigger detached restart
cat > .claude/errandd/pending-resume.json <<'EOF'
{ ... }
EOF
nohup bash -c 'sleep 2 && sudo systemctl restart my-service' &
```

**Why direct API call:** the "waiting" message must be sent via a Bash tool `curl` call (or equivalent), not as part of the agent's response text. Errandd only delivers the response to the user after the CC session completes — but this session ends with a restart, so buffered response text is lost. A direct API call goes out immediately and independently.

**Force override:** if the user explicitly asks for an immediate restart regardless of active sessions, skip the wait loop entirely. Always tell the user which sessions will be interrupted before proceeding.

The file is written synchronously on every session start/finish, so the value is always consistent with the in-memory counter.

**Known limitation:** the check happens at LLM execution time, not message-receipt time. If a concurrent session starts and completes in under ~60 seconds (the typical CC startup + LLM first-response latency), it may finish before the agent reads the file. The wait-for-idle pattern is intended for long-running tasks (minutes), not quick ones.

The file is written on a best-effort basis (`active-runs` is absent during the first session before any run completes). Treat a missing file as count = 0 (no active sessions other than your own).

## Scope

- Errandd only (not CC core)
- Works for Discord and Telegram transports (Slack support is out of scope for this PR)
- No change to CC session format or JSONL
- No new permissions required beyond what the agent already has

## Out of scope

- Multi-message queues (single pending resume is sufficient)
- Resuming a partially-completed tool sequence mid-execution
- Cross-restart state serialisation beyond what the session already carries
