/**
 * GitHub App installation-token auth.
 *
 * errandd opens PRs, replies to review comments and resolves threads with `gh`,
 * which needs a write-capable token. A GitHub App installation token is
 * short-lived (1h) and scoped to the installation — no static PAT, no personal
 * credential. This module mints one, hands it to `gh auth login --with-token`
 * (so every `gh` invocation, including the ones the agent's Bash tool makes,
 * picks it up), and re-mints on a timer before it expires.
 *
 * Ported from the deployment's start-errandd.sh, which shelled out to `openssl`
 * to sign the JWT. Signing is done with node:crypto here — one less binary the
 * container has to carry, and no private key ever reaches a temp file or argv.
 *
 * Config comes from `settings.githubApp`, with `GITHUB_APP_*` env vars taking
 * precedence (see {@link resolveGithubAppConfig}). With nothing configured the
 * whole thing is a no-op and any existing `gh` auth is left untouched.
 */

import { createSign } from "node:crypto";
import type { GithubAppSettings } from "../config";

/** Fully-resolved GitHub App config. `enabled=false` ⇒ never mint. */
export interface GithubAppConfig {
  enabled: boolean;
  appId: string;
  installationId: string;
  /** PEM text, already base64-decoded. */
  privateKeyPem: string;
  refreshMinutes: number;
}

/** A minted installation token and when GitHub says it expires. */
export interface InstallationToken {
  token: string;
  /** ISO-8601 expiry as reported by GitHub (empty if absent). */
  expiresAt: string;
}

/** Installation tokens live 60 minutes; re-mint with headroom. */
const DEFAULT_REFRESH_MINUTES = 45;

function firstNonEmpty(...vals: (string | undefined)[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  return undefined;
}

function envFalsy(v: string | undefined): boolean {
  if (!v) {
    return false;
  }
  const s = v.trim().toLowerCase();
  return s === "0" || s === "false" || s === "no" || s === "off";
}

/**
 * Resolve effective config from settings + env.
 *
 * Precedence per value: `ERRANDD_GITHUB_APP_*` → bare `GITHUB_APP_*` →
 * `settings.githubApp` → default. The bare names are kept because the existing
 * deployment already injects them from ESC; the prefixed forms exist so the
 * daemon's own vars can be told apart from anything else on the box.
 *
 * `enabled` is true only when all three credentials resolve — a half-configured
 * App is treated as "not configured" rather than failing at mint time.
 */
export function resolveGithubAppConfig(
  settings: GithubAppSettings | undefined,
  env: Record<string, string | undefined> = process.env,
): GithubAppConfig {
  const appId = firstNonEmpty(env.ERRANDD_GITHUB_APP_ID, env.GITHUB_APP_ID, settings?.appId);
  const installationId = firstNonEmpty(
    env.ERRANDD_GITHUB_APP_INSTALLATION_ID,
    env.GITHUB_APP_INSTALLATION_ID,
    settings?.installationId,
  );
  const keyB64 = firstNonEmpty(
    env.ERRANDD_GITHUB_APP_PRIVATE_KEY_B64,
    env.GITHUB_APP_PRIVATE_KEY_B64,
    settings?.privateKeyBase64,
  );

  const refreshRaw = firstNonEmpty(
    env.ERRANDD_GITHUB_APP_REFRESH_MINUTES,
    settings?.refreshMinutes != null ? String(settings.refreshMinutes) : undefined,
  );
  const parsedRefresh = refreshRaw ? Number(refreshRaw) : Number.NaN;
  const refreshMinutes =
    Number.isFinite(parsedRefresh) && parsedRefresh > 0 ? parsedRefresh : DEFAULT_REFRESH_MINUTES;

  let privateKeyPem = "";
  if (keyB64) {
    try {
      privateKeyPem = Buffer.from(keyB64, "base64").toString("utf-8");
    } catch {
      privateKeyPem = "";
    }
  }
  // Tolerate a key pasted as raw PEM rather than base64 — decoding that yields
  // bytes that don't contain a PEM header, so fall back to the literal value.
  if (keyB64 && !privateKeyPem.includes("-----BEGIN") && keyB64.includes("-----BEGIN")) {
    privateKeyPem = keyB64;
  }

  const configured = Boolean(appId && installationId && privateKeyPem.includes("-----BEGIN"));
  const explicitlyOff =
    envFalsy(env.ERRANDD_GITHUB_APP_ENABLED) || settings?.enabled === false;

  return {
    enabled: configured && !explicitlyOff,
    appId: appId ?? "",
    installationId: installationId ?? "",
    privateKeyPem,
    refreshMinutes,
  };
}

/** base64url without padding, the JWT wire encoding. */
function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Build the RS256 App JWT GitHub accepts in exchange for an installation token.
 *
 * `iat` is backdated 60s because GitHub rejects a token whose `iat` is in its
 * future — a small clock skew between the pod and GitHub is otherwise fatal.
 * `exp` is +9min; GitHub caps App JWTs at 10 minutes.
 */
export function buildAppJwt(
  appId: string,
  privateKeyPem: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${b64url(signer.sign(privateKeyPem))}`;
}

/**
 * Exchange the App JWT for an installation access token. Throws with GitHub's
 * status/body on failure so the caller can log something actionable.
 */
export async function mintInstallationToken(
  cfg: GithubAppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<InstallationToken> {
  const jwt = buildAppJwt(cfg.appId, cfg.privateKeyPem);
  const res = await fetchImpl(
    `https://api.github.com/app/installations/${cfg.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "user-agent": "errandd",
      },
    },
  );
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`GitHub App token mint failed: HTTP ${res.status} ${body}`);
  }
  const json = (await res.json()) as { token?: unknown; expires_at?: unknown };
  if (typeof json.token !== "string" || !json.token) {
    throw new Error("GitHub App token mint failed: response carried no token");
  }
  return {
    token: json.token,
    expiresAt: typeof json.expires_at === "string" ? json.expires_at : "",
  };
}

/**
 * Hand the token to `gh` itself rather than exporting GITHUB_TOKEN.
 *
 * `gh auth login --with-token` stores it in gh's own config, which every later
 * `gh` invocation reads — including the ones the agent's Bash tool makes. An
 * exported GITHUB_TOKEN would instead SHADOW that store, pinning every process
 * to whatever value was set at boot and defeating the re-mint below.
 */
export async function authenticateGh(
  token: string,
  spawn: typeof Bun.spawn = Bun.spawn,
): Promise<boolean> {
  try {
    const proc = spawn(["gh", "auth", "login", "--with-token"], {
      stdin: new TextEncoder().encode(token),
      stdout: "ignore",
      stderr: "pipe",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** Wire `git` to authenticate HTTPS remotes through gh's (refreshing) token. */
async function setupGitCredentialHelper(spawn: typeof Bun.spawn = Bun.spawn): Promise<void> {
  try {
    const proc = spawn(["gh", "auth", "setup-git"], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  } catch {
    // best-effort — git over HTTPS just stays unauthenticated
  }
}

/** One mint + authenticate cycle. Returns false (never throws) on any failure. */
export async function refreshGithubAppAuth(
  cfg: GithubAppConfig,
  log: (msg: string) => void,
): Promise<boolean> {
  if (!cfg.enabled) {
    return false;
  }
  try {
    const { token, expiresAt } = await mintInstallationToken(cfg);
    if (!(await authenticateGh(token))) {
      log("github app: minted a token but `gh auth login --with-token` failed");
      return false;
    }
    log(`github app: minted installation token${expiresAt ? ` (expires ${expiresAt})` : ""}`);
    return true;
  } catch (err) {
    log(`github app: ${String(err)}`);
    return false;
  }
}

/**
 * Mint now and keep re-minting. Returns a stop function, or null when no App is
 * configured (the caller then leaves existing `gh` auth alone).
 */
export async function startGithubAppAuth(
  cfg: GithubAppConfig,
  log: (msg: string) => void = (m) => console.log(m),
): Promise<(() => void) | null> {
  if (!cfg.enabled) {
    return null;
  }
  if (await refreshGithubAppAuth(cfg, log)) {
    await setupGitCredentialHelper();
  }
  const timer = setInterval(
    () => void refreshGithubAppAuth(cfg, log),
    cfg.refreshMinutes * 60 * 1000,
  );
  return () => clearInterval(timer);
}
