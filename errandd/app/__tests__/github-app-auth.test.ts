import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  buildAppJwt,
  mintInstallationToken,
  resolveGithubAppConfig,
  type GithubAppConfig,
} from "../github/appAuth";

/** A real RSA keypair, so signing/verification is genuinely exercised. */
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const PEM_B64 = Buffer.from(privateKey).toString("base64");

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf-8")) as Record<string, unknown>;
}

describe("resolveGithubAppConfig", () => {
  test("nothing configured ⇒ disabled (and never mints)", () => {
    expect(resolveGithubAppConfig(undefined, {}).enabled).toBe(false);
  });

  test("settings alone configure it", () => {
    const cfg = resolveGithubAppConfig(
      { appId: "123", installationId: "456", privateKeyBase64: PEM_B64 },
      {},
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.appId).toBe("123");
    expect(cfg.privateKeyPem).toContain("-----BEGIN");
    expect(cfg.refreshMinutes).toBe(45);
  });

  test("bare GITHUB_APP_* env overrides settings (the deployment already sets these)", () => {
    const cfg = resolveGithubAppConfig(
      { appId: "from-settings", installationId: "s", privateKeyBase64: PEM_B64 },
      { GITHUB_APP_ID: "from-env", GITHUB_APP_INSTALLATION_ID: "e" },
    );
    expect(cfg.appId).toBe("from-env");
    expect(cfg.installationId).toBe("e");
  });

  test("ERRANDD_-prefixed env wins over the bare form", () => {
    const cfg = resolveGithubAppConfig(undefined, {
      ERRANDD_GITHUB_APP_ID: "prefixed",
      GITHUB_APP_ID: "bare",
      GITHUB_APP_INSTALLATION_ID: "i",
      GITHUB_APP_PRIVATE_KEY_B64: PEM_B64,
    });
    expect(cfg.appId).toBe("prefixed");
    expect(cfg.enabled).toBe(true);
  });

  test("half-configured is treated as not configured, not as a mint-time failure", () => {
    const cfg = resolveGithubAppConfig({ appId: "123" }, {});
    expect(cfg.enabled).toBe(false);
  });

  test("a raw PEM (not base64) is still accepted", () => {
    const cfg = resolveGithubAppConfig(
      { appId: "1", installationId: "2", privateKeyBase64: privateKey },
      {},
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.privateKeyPem).toContain("-----BEGIN");
  });

  test("explicit off switch beats present credentials", () => {
    const base = { appId: "1", installationId: "2", privateKeyBase64: PEM_B64 };
    expect(resolveGithubAppConfig({ ...base, enabled: false }, {}).enabled).toBe(false);
    expect(resolveGithubAppConfig(base, { ERRANDD_GITHUB_APP_ENABLED: "false" }).enabled).toBe(
      false,
    );
  });

  test("refresh cadence is overridable and rejects nonsense", () => {
    expect(resolveGithubAppConfig({ refreshMinutes: 10 }, {}).refreshMinutes).toBe(10);
    expect(
      resolveGithubAppConfig(undefined, { ERRANDD_GITHUB_APP_REFRESH_MINUTES: "20" })
        .refreshMinutes,
    ).toBe(20);
    expect(resolveGithubAppConfig({ refreshMinutes: -5 }, {}).refreshMinutes).toBe(45);
    expect(
      resolveGithubAppConfig(undefined, { ERRANDD_GITHUB_APP_REFRESH_MINUTES: "abc" })
        .refreshMinutes,
    ).toBe(45);
  });
});

describe("buildAppJwt", () => {
  test("is a verifiable RS256 JWT with the claims GitHub requires", () => {
    const now = 1_000_000;
    const jwt = buildAppJwt("42", privateKey, now);
    const [h, p, s] = jwt.split(".");

    expect(decodeSegment(h)).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = decodeSegment(p);
    expect(payload.iss).toBe("42");
    // Backdated: GitHub rejects a JWT whose iat is in its future, so pod clock
    // skew must not be able to invalidate every token we mint.
    expect(payload.iat).toBe(now - 60);
    // GitHub caps App JWTs at 10 minutes.
    expect(payload.exp).toBe(now + 540);
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(600);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });
});

describe("mintInstallationToken", () => {
  const cfg: GithubAppConfig = {
    enabled: true,
    appId: "42",
    installationId: "99",
    privateKeyPem: privateKey,
    refreshMinutes: 45,
  };

  test("posts to the installation endpoint with the JWT and returns the token", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let seenMethod = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenMethod = init?.method ?? "";
      seenAuth = String((init?.headers as Record<string, string>)?.authorization ?? "");
      return new Response(JSON.stringify({ token: "ghs_abc", expires_at: "2026-08-17T22:00:00Z" }), {
        status: 201,
      });
    }) as unknown as typeof fetch;

    const out = await mintInstallationToken(cfg, fakeFetch);

    expect(out.token).toBe("ghs_abc");
    expect(out.expiresAt).toBe("2026-08-17T22:00:00Z");
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("https://api.github.com/app/installations/99/access_tokens");
    expect(seenAuth.startsWith("Bearer ")).toBe(true);
    expect(seenAuth.split(" ")[1]?.split(".").length).toBe(3);
  });

  test("a non-2xx surfaces GitHub's status so the log says something actionable", async () => {
    const fakeFetch = (async () =>
      new Response("bad key", { status: 401 })) as unknown as typeof fetch;
    await expect(mintInstallationToken(cfg, fakeFetch)).rejects.toThrow(/HTTP 401/);
  });

  test("a 2xx with no token is still a failure", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ expires_at: "x" }), { status: 201 })) as unknown as typeof fetch;
    await expect(mintInstallationToken(cfg, fakeFetch)).rejects.toThrow(/no token/);
  });
});
