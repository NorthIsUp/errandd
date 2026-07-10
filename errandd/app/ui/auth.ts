import { chmod, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { join } from "path";

const TOKEN_FILE = join(process.cwd(), ".claude", "errandd", "web.token");

export const AUTH_COOKIE_NAME = "errandd_auth";
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 365; // 1 year
const SIGN_MSG = "errandd-auth-v1";

export async function getOrCreateWebToken(): Promise<string> {
  if (existsSync(TOKEN_FILE)) {
    return (await readFile(TOKEN_FILE, "utf-8")).trim();
  }
  const token = randomBytes(32).toString("base64url");
  await writeFile(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  await chmod(TOKEN_FILE, 0o600); // belt-and-suspenders for systems where mode arg is ignored
  return token;
}

/**
 * The tailnet user attribution extracted from a trusted upstream's headers.
 * Surfaced so request handlers can attribute actions to a specific tailnet
 * identity (e.g. log "adam@ pulled jobs repo") and the UI can render
 * "Signed in as @adam" instead of an opaque cookie.
 */
export interface TailnetIdentity {
  /** The Tailscale login (e.g. `adam@github` or `adam@askclara.com`). */
  login: string;
  /** Human-friendly display name when the proxy provides it. */
  displayName?: string;
  /** The tailnet name (e.g. `claw-clara.ts.net`) when provided. */
  tailnet?: string;
}

/**
 * Result of an auth check: did the request authenticate, and if so, via which
 * channel? `viaQuery` means we should set a fresh signed cookie on the
 * response so the client doesn't keep the token in URLs. `tailnet` is
 * populated when the request was authenticated via the tailnet header
 * bypass — request handlers can use it for attribution.
 */
export interface AuthResult {
  valid: boolean;
  viaQuery: boolean;
  tailnet?: TailnetIdentity;
}

export interface AuthOptions {
  /**
   * If true, requests carrying a non-empty `Tailscale-User-Login` header are
   * treated as authenticated. The Tailscale operator's Ingress proxy stamps
   * this header for tailnet-originated requests and omits it for funnel
   * (public) traffic, so this is safe when the proxy is the only upstream
   * that can reach the daemon (e.g. enforced by NetworkPolicy).
   */
  trustTailnet?: boolean;
}

/** True iff a trusted upstream marked this request as a tailnet visitor. */
export function isTailnetRequest(req: Request): boolean {
  const v = req.headers.get("tailscale-user-login");
  return !!v && v.trim().length > 0;
}

/**
 * Extract the tailnet identity from a request's headers. Returns null when
 * no `Tailscale-User-Login` header is present. Header lookup is
 * case-insensitive because `Headers.get` lowercases the key. Callers are
 * responsible for only trusting this when `trustTailnet` is enabled.
 */
export function getTailnetIdentity(req: Request): TailnetIdentity | null {
  const login = req.headers.get("tailscale-user-login")?.trim();
  if (!login) return null;
  const displayName = req.headers.get("tailscale-user-name")?.trim();
  // Some Tailscale proxies stamp the tailnet via a header; others encode it
  // in the login (`user@tailnet`). Prefer the explicit header when present,
  // otherwise derive from the login suffix.
  const headerTailnet = req.headers.get("tailscale-tailnet")?.trim();
  const derivedTailnet = login.includes("@") ? login.split("@").pop()!.trim() : "";
  const tailnet = headerTailnet || derivedTailnet || undefined;
  return {
    login,
    ...(displayName ? { displayName } : {}),
    ...(tailnet ? { tailnet } : {}),
  };
}

export function authenticate(req: Request, expected: string, opts: AuthOptions = {}): AuthResult {
  // 0) Tailnet bypass (opt-in). The Tailscale operator Ingress strips this
  //    header on funnel-origin requests, so a non-empty value means the
  //    visitor is authenticated against the tailnet.
  if (opts.trustTailnet) {
    const tailnet = getTailnetIdentity(req);
    if (tailnet) {
      return { valid: true, viaQuery: false, tailnet };
    }
  }

  // 1) Signed cookie (preferred — set after the first ?token= handshake).
  const cookie = getCookieValue(req, AUTH_COOKIE_NAME);
  if (cookie && verifyAuthCookie(cookie, expected)) {
    return { valid: true, viaQuery: false };
  }

  // 2) Authorization: Bearer <token>
  const auth = req.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1];

  // 3) ?token=<token>
  const queryToken = new URL(req.url).searchParams.get("token");

  const provided = bearer ?? queryToken ?? "";
  if (!provided) {
    return { valid: false, viaQuery: false };
  }
  if (!constantTimeEqual(provided, expected)) {
    return { valid: false, viaQuery: false };
  }
  // If they used Authorization: Bearer it's already cookie-free; treat the
  // bearer case as "viaQuery" too so we still upgrade clients that hit us
  // with a one-shot bearer (cheap, idempotent).
  return { valid: true, viaQuery: true };
}

/** Back-compat thin wrapper. Use `authenticate` for the cookie-aware result. */
export function checkToken(req: Request, expected: string, opts: AuthOptions = {}): boolean {
  return authenticate(req, expected, opts).valid;
}

export function signAuthCookie(token: string): string {
  return createHmac("sha256", token).update(SIGN_MSG).digest("base64url");
}

export function verifyAuthCookie(cookieValue: string, token: string): boolean {
  const expected = signAuthCookie(token);
  return constantTimeEqual(cookieValue, expected);
}

export function buildAuthCookie(token: string, secure: boolean): string {
  const value = signAuthCookie(token);
  const parts = [
    `${AUTH_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE_SEC}`,
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function attachAuthCookie(headers: Headers, req: Request, token: string): void {
  const secure = new URL(req.url).protocol === "https:";
  headers.append("Set-Cookie", buildAuthCookie(token, secure));
}

function getCookieValue(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) {
    return null;
  }
  for (const raw of header.split(";")) {
    const eq = raw.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const k = raw.slice(0, eq).trim();
    if (k === name) {
      return decodeURIComponent(raw.slice(eq + 1).trim());
    }
  }
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  // Compare byte lengths (not JS character lengths) so non-ASCII input never
  // causes timingSafeEqual to throw.
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}
