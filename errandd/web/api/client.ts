// ---------------------------------------------------------------------------
// Token management
// Read from ?token= on first load, stash in sessionStorage, inject into every
// /api/* request via Authorization: Bearer.
// ---------------------------------------------------------------------------

const TOKEN_KEY = "errandd.token";

function loadToken(): string {
  const fromUrl = new URL(location.href).searchParams.get("token");
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl);
    // Remove from URL so the token isn't leaked in the browser history.
    const clean = new URL(location.href);
    clean.searchParams.delete("token");
    history.replaceState(null, "", clean.toString());
    return fromUrl;
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? "";
}

let _token: string | null = null;
function getToken(): string {
  _token ??= loadToken();
  return _token;
}

/** Public token accessor for surfaces (EventSource, etc.) that can't set
 *  a Bearer header and need to fall back to ?token=. */
export function getApiToken(): string {
  return getToken();
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class NotAuthorizedError extends ApiError {
  constructor(body?: unknown) {
    super("Not authorized", 401, body);
    this.name = "NotAuthorizedError";
  }
}

// ---------------------------------------------------------------------------
// Base fetch helpers
// ---------------------------------------------------------------------------

/**
 * Fetch with automatic Authorization header injection.
 * Also adds Content-Type: application/json when the body is a string (typical
 * for JSON-serialised payloads).
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(path, { ...init, headers });
}

/**
 * Like `apiFetch` but parses the response as JSON and throws `ApiError` on
 * non-2xx responses.
 */
export async function apiJSON<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => undefined);
    }
    if (res.status === 401) {
      throw new NotAuthorizedError(body);
    }
    throw new ApiError(`HTTP ${res.status} ${res.statusText}`, res.status, body);
  }
  return res.json() as Promise<T>;
}
