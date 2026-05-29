import { apiJSON } from "./client";

// ---------------------------------------------------------------------------
// Types — mirrors src/ui/services/sessions.ts
// ---------------------------------------------------------------------------

export type SessionTrigger =
  | {
      kind: "hook";
      event: string;
      action?: string;
      repo?: string;
      pr?: { number: number; url?: string };
      actor?: string;
    }
  | { kind: "schedule"; cron: string }
  | { kind: "manual" };

export type SessionResult = "ok" | "error" | "skipped" | "pass";

export interface SessionInfo {
  id: string;
  agent: string;
  channel: "web" | "discord" | "agent" | "job" | "unknown";
  lastUsedAt: string;
  createdAt: string;
  turnCount: number;
  firstMessage: string;
  lastMessage: string;
  title?: string;
  closed: boolean;
  jobName?: string;
  trigger?: SessionTrigger;
  result?: SessionResult;
  resultAt?: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  uuid?: string;
}

export interface MessagesResult {
  messages: ChatMessage[];
  total: number;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

export function listSessions(includeClosed = false): Promise<SessionInfo[]> {
  const qs = includeClosed ? "?includeClosed=1" : "";
  return apiJSON<SessionInfo[]>(`/api/sessions${qs}`);
}

export function getSessionMessages(
  id: string,
  limit = 10,
  offset = 0,
): Promise<MessagesResult> {
  const qs = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  return apiJSON<MessagesResult>(
    `/api/sessions/${encodeURIComponent(id)}/messages?${qs.toString()}`,
  );
}

export interface StoredHookPayload {
  event: string;
  payload: unknown;
}

/** Full raw webhook payload that triggered a hook session (lazy fetch). */
export function getHookPayload(id: string): Promise<StoredHookPayload> {
  return apiJSON<StoredHookPayload>(`/api/sessions/${encodeURIComponent(id)}/hook-payload`);
}

/** Replay a stored hook delivery through the matcher. Returns the jobs fired. */
export function reprocessHook(id: string): Promise<{ ok: boolean; matched: string[] }> {
  return apiJSON<{ ok: boolean; matched: string[] }>(
    `/api/sessions/${encodeURIComponent(id)}/reprocess`,
    { method: "POST" },
  );
}

export function setSessionTitle(
  id: string,
  title: string,
): Promise<{ ok: true }> {
  return apiJSON<{ ok: true }>(
    `/api/sessions/${encodeURIComponent(id)}/title`,
    { method: "PUT", body: JSON.stringify({ title }) },
  );
}

export function setSessionClosed(
  id: string,
  closed: boolean,
): Promise<{ ok: true }> {
  const action = closed ? "close" : "reopen";
  return apiJSON<{ ok: true }>(
    `/api/sessions/${encodeURIComponent(id)}/${action}`,
    { method: "POST" },
  );
}

export function getSessionGoal(id: string): Promise<{ goal: string }> {
  return apiJSON<{ goal: string }>(
    `/api/sessions/${encodeURIComponent(id)}/goal`,
  );
}

export function setSessionGoal(
  id: string,
  goal: string,
): Promise<{ ok: true }> {
  return apiJSON<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/goal`, {
    method: "PUT",
    body: JSON.stringify({ goal }),
  });
}

export function getSessionModel(id: string): Promise<{ model: string }> {
  return apiJSON<{ model: string }>(
    `/api/sessions/${encodeURIComponent(id)}/model`,
  );
}

export function setSessionModel(
  id: string,
  model: string,
): Promise<{ ok: true }> {
  return apiJSON<{ ok: true }>(
    `/api/sessions/${encodeURIComponent(id)}/model`,
    { method: "PUT", body: JSON.stringify({ model }) },
  );
}

export function getSessionEffort(id: string): Promise<{ effort: string }> {
  return apiJSON<{ effort: string }>(
    `/api/sessions/${encodeURIComponent(id)}/effort`,
  );
}

export function setSessionEffort(
  id: string,
  effort: string,
): Promise<{ ok: true }> {
  return apiJSON<{ ok: true }>(
    `/api/sessions/${encodeURIComponent(id)}/effort`,
    { method: "PUT", body: JSON.stringify({ effort }) },
  );
}
