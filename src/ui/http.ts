export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw ? Number(raw) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/**
 * Wrap an async handler so its return value lands as a 200 JSON response,
 * and any thrown error turns into an `{ ok: false, error }` body at the
 * caller-supplied `errorStatus` (typically 400 for client-side mistakes
 * like a malformed body, 500 for unexpected server faults).
 *
 * The async dual to `json()`: `json()` is for synchronous success bodies;
 * `withJson` is for the async-with-rejectable case. Importers (e.g.
 * src/ui/server.ts) referenced this helper before it was exported, so
 * module init crashed with
 *   `Export named 'withJson' not found in module '.../http.ts'.`
 */
export async function withJson(
  fn: () => Promise<unknown>,
  errorStatus = 500,
): Promise<Response> {
  try {
    const data = await fn();
    return json(data ?? { ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: message }, errorStatus);
  }
}
