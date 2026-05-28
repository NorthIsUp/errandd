import { apiJSON } from "./client";

export interface UpdateCheck {
  kind: "git" | "plugin" | "image";
  currentSha: string | null;
  latestSha: string | null;
  behind: number;
  branch: string;
  canPull: boolean;
  canPlugin: boolean;
  updateCommand: string | null;
  compareUrl: string | null;
  error: string | null;
}

export interface UpdateResult {
  ok: boolean;
  newSha: string | null;
  output: string;
  error: string | null;
}

export function checkForUpdate(force = false): Promise<UpdateCheck> {
  const qs = force ? "?force=1" : "";
  return apiJSON<UpdateCheck>(`/api/runtime/update-check${qs}`);
}

export function applyUpdate(): Promise<UpdateResult> {
  return apiJSON<UpdateResult>("/api/runtime/update", { method: "POST" });
}
