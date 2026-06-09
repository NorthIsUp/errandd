// Rate-limit singleton state + detection helpers, extracted from runner.ts.
//
// Behavior-preserving: the module-level `rateLimitResetAt` / `rateLimitNotified`
// pair is a process-global singleton exactly as it was when inlined in runner.ts.
// Callers in runner.ts read/write it through these helpers.

export const RATE_LIMIT_PATTERN = /you(?:'|')ve hit your limit|out of extra usage/i;
export const RATE_LIMIT_RESET_PATTERN = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(?\s*UTC\s*\)?/i;

// --- Rate limit state ---
let rateLimitResetAt: number = 0; // epoch ms; 0 = not rate-limited
let rateLimitNotified: boolean = false;

export function parseRateLimitResetTime(text: string): number | null {
  const match = text.match(RATE_LIMIT_RESET_PATTERN);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const ampm = match[3]?.toLowerCase();

  if (ampm === "pm" && hours < 12) hours += 12;
  if (ampm === "am" && hours === 12) hours = 0;

  const now = new Date();
  const reset = new Date(now);
  reset.setUTCHours(hours, minutes, 0, 0);
  if (reset.getTime() <= now.getTime()) {
    reset.setUTCDate(reset.getUTCDate() + 1);
  }
  return reset.getTime();
}

export function isRateLimited(): boolean {
  if (rateLimitResetAt === 0) return false;
  if (Date.now() >= rateLimitResetAt) {
    rateLimitResetAt = 0;
    rateLimitNotified = false;
    return false;
  }
  return true;
}

export function getRateLimitResetAt(): number {
  return rateLimitResetAt;
}

export function wasRateLimitNotified(): boolean {
  return rateLimitNotified;
}

export function markRateLimitNotified(): void {
  rateLimitNotified = true;
}

/**
 * Record a freshly-detected rate limit: parse the reset time out of the message
 * (falling back to "one hour from now" when unparseable) and clear the
 * notified flag so the next surface gets a fresh notification.
 * Returns the resolved reset epoch ms.
 */
export function recordRateLimit(message: string): number {
  const resetTime = parseRateLimitResetTime(message);
  rateLimitResetAt = resetTime ?? (Date.now() + 60 * 60_000);
  rateLimitNotified = false;
  return rateLimitResetAt;
}

export function extractRateLimitMessage(stdout: string, stderr: string): string | null {
  const candidates = [stdout, stderr];
  for (const text of candidates) {
    const trimmed = text.trim();
    if (trimmed && RATE_LIMIT_PATTERN.test(trimmed)) return trimmed;
  }
  return null;
}
