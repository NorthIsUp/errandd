import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isReady } from "../health";
import { handleWebhook } from "../hooks/receiver";
import { attachAuthCookie, authenticate, checkToken } from "./auth";
import { json } from "./http";
import { dispatch } from "./routes";
import type { RouteCtx } from "./routes/types";
import type { StartWebUiOptions, WebServerHandle } from "./types";

// When errandd is installed via `claude plugin install` the source is
// extracted to ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
// without a dist/web/ — `bun run build:web` is a dev-time step that the
// plugin tarball doesn't carry. Without it the /ui/, /darwin/, /os9/,
// /osish/ routes 404 with "UI not built". Detect that on startup and
// build once, blocking until dist/web/ui/index.html exists.
function ensureWebBuilt(): void {
  const pkgRoot = join(import.meta.dir, "..", "..");
  const sentinel = join(pkgRoot, "dist", "web", "v3", "index.html");
  if (existsSync(sentinel)) {
    return;
  }
  console.error("[errandd] dist/web missing — running `bun run build:web`...");
  const r = spawnSync("bun", ["run", "build:web"], {
    cwd: pkgRoot,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error("[errandd] build:web failed — /ui/ will 404 until you fix it.");
  }
}

/**
 * Build a Server-Sent-Events Response. `setup(send)` emits the initial
 * frame(s) and returns a cleanup fn (e.g. an unsubscribe); this helper owns
 * the encoder, the 25s `{type:"ping"}` heartbeat, the closed-flag guard, the
 * abort cleanup, and the SSE headers. Shared by the job-status, deliveries,
 * and hook-queue streams.
 */
function sseResponse(req: Request, setup: (send: (data: unknown) => void) => () => void): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (data: unknown) => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const heartbeat = setInterval(() => send({ type: "ping" }), 25_000);
      const cleanup = setup(send);
      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(heartbeat);
        try {
          cleanup();
        } catch {
          // cleanup is best-effort
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export function startWebUi(opts: StartWebUiOptions): WebServerHandle {
  ensureWebBuilt();

  // Dev API proxy target — validated ONCE at startup, not per-request. Only
  // enabled when ERRANDD_DEV_API_PROXY is a valid http(s) URL AND we are not
  // in production, so a stray env var in a prod deploy can never turn the
  // daemon into an auth-bypassing forwarder. Null = disabled (the normal case).
  const devProxyBase: string | null = (() => {
    const raw = process.env.ERRANDD_DEV_API_PROXY?.trim();
    if (!raw) return null;
    if (process.env.NODE_ENV === "production") {
      console.error("[errandd] ERRANDD_DEV_API_PROXY ignored in production");
      return null;
    }
    try {
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error(`unsupported protocol ${u.protocol}`);
      }
      console.error(`[errandd] DEV API proxy ON → ${u.origin} (local auth bypassed for /api/*)`);
      return raw.replace(/\/+$/, "");
    } catch (err) {
      console.error(`[errandd] ERRANDD_DEV_API_PROXY invalid, ignoring: ${String(err)}`);
      return null;
    }
  })();

  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    idleTimeout: 0,
    fetch: async (req) => {
      const url = new URL(req.url);

      // Liveness + readiness probes — answered FIRST, before Host/CSRF/auth/dev-
      // proxy, so a deploy orchestrator can poll them unconditionally and they
      // always reflect THIS instance.
      //   /healthz → 200 (the process is serving).
      //   /readyz  → 200 once startup finished, 503 while initializing OR
      //              draining for shutdown — so the orchestrator only cuts
      //              traffic to a ready instance and drains the old one first.
      if (url.pathname === "/healthz") {
        return new Response("ok\n", { status: 200, headers: { "content-type": "text/plain" } });
      }
      if (url.pathname === "/readyz") {
        const ready = isReady();
        return new Response(ready ? "ready\n" : "not ready\n", {
          status: ready ? 200 : 503,
          headers: { "content-type": "text/plain" },
        });
      }

      // Task 1.2: Reject DNS rebinding attacks via Host header validation.
      // Wildcard bind addresses (0.0.0.0, ::) mean the user opted into remote access —
      // the browser Host header won't match the bind address, so we skip the check.
      // For specific bind addresses (loopback or LAN IP) we enforce the allowlist.
      const host = req.headers.get("host") ?? "";
      const isWildcardBind = opts.host === "0.0.0.0" || opts.host === "::";
      if (!isWildcardBind) {
        const expectedHosts = new Set([
          `127.0.0.1:${opts.port}`,
          `localhost:${opts.port}`,
          `[::1]:${opts.port}`,
          `${opts.host}:${opts.port}`,
        ]);
        if (!expectedHosts.has(host)) {
          return new Response("Bad Host", { status: 421 });
        }
      }

      // Task 1.3: CSRF defense — reject cross-origin requests for state-changing methods.
      // Accept both http and https origins for validated hosts.
      if (req.method === "POST" || req.method === "PUT" || req.method === "DELETE") {
        const origin = req.headers.get("origin");
        const allowedOrigins = new Set([`http://${host}`, `https://${host}`]);
        // When an Origin is sent it must be same-origin, regardless of how the
        // request authenticates (a cross-origin Origin is never legitimate here).
        if (origin && !allowedOrigins.has(origin)) {
          return new Response("Bad Origin", { status: 403 });
        }
        // Cookie-authed mutations are the CSRF-vulnerable case: a cross-site page
        // can drive the browser to attach our SameSite=Lax cookie on a top-level
        // navigation / form post that may carry no Origin header. Bearer/?token=
        // requests aren't forgeable cross-site (the attacker can't read the
        // token), so they're exempt. For a cookie-only mutation, require a
        // positive same-origin signal: same-origin Origin OR
        // Sec-Fetch-Site: same-origin. An absent Origin with no Sec-Fetch proof
        // is treated as forbidden.
        const hasCookie = !!req.headers.get("cookie");
        const hasBearer = /^Bearer\s+/i.test(req.headers.get("authorization") ?? "");
        const hasQueryToken = !!url.searchParams.get("token");
        if (hasCookie && !hasBearer && !hasQueryToken) {
          const secFetchSite = req.headers.get("sec-fetch-site");
          const sameOriginByFetchMeta = secFetchSite === "same-origin";
          const sameOriginByOrigin = !!origin && allowedOrigins.has(origin);
          if (!(sameOriginByFetchMeta || sameOriginByOrigin)) {
            return new Response("Bad Origin", { status: 403 });
          }
        }
      }

      // Dev API proxy (validated at startup → `devProxyBase`). Forward /api/*
      // upstream so the locally-built UI renders real data. Placed AFTER the
      // host + CSRF guards (so rebinding/cross-origin protection still applies)
      // but before the bearer-token gate (the local UI shouldn't need the local
      // token — the upstream authorizes via its own tailnet trust, so we strip
      // the local bearer/cookie). Streams the body, so SSE endpoints work.
      if (devProxyBase && url.pathname.startsWith("/api/")) {
        const target = `${devProxyBase}${url.pathname}${url.search}`;
        const fwd = new Headers(req.headers);
        fwd.delete("host");
        fwd.delete("authorization");
        fwd.delete("cookie");
        const init: RequestInit = { method: req.method, headers: fwd, redirect: "manual" };
        if (req.method !== "GET" && req.method !== "HEAD") {
          init.body = await req.arrayBuffer();
        }
        try {
          const upstream = await fetch(target, init);
          const outHeaders = new Headers(upstream.headers);
          for (const h of [
            "content-encoding",
            "content-length",
            "transfer-encoding",
            "connection",
          ]) {
            outHeaders.delete(h);
          }
          return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
        } catch (err) {
          return new Response(JSON.stringify({ error: `dev proxy failed: ${String(err)}` }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // Serve the React web app from dist/web/<bundle>/ for all non-API routes.
      // Bundles: /v3/ (default) and /v2/ (legacy ui). The bare root 302s to /v3/.
      {
        const webRoot = join(import.meta.dir, "..", "..", "dist", "web");

        if (url.pathname === "/" || url.pathname === "/index.html") {
          const target = new URL("/v3/", url.origin);
          // If the request handed us a valid ?token=, swap it for a signed
          // cookie and strip the token from the redirected URL. Otherwise we
          // just pass query params through so an invalid attempt still lands
          // at /ui/ for the SPA to react to.
          const authResult = authenticate(req, opts.token, { trustTailnet: opts.trustTailnet });
          if (authResult.valid && authResult.viaQuery) {
            for (const [k, v] of url.searchParams) {
              if (k !== "token") {
                target.searchParams.set(k, v);
              }
            }
            const headers = new Headers({ Location: target.toString() });
            attachAuthCookie(headers, req, opts.token);
            return new Response(null, { status: 302, headers });
          }
          for (const [k, v] of url.searchParams) {
            target.searchParams.set(k, v);
          }
          return Response.redirect(target.toString(), 302);
        }

        const BUNDLES = ["v2", "v3"] as const;
        const match = /^\/([^/]+)(\/.*)?$/.exec(url.pathname);
        const bundle = match
          ? (BUNDLES as readonly string[]).includes(match[1] ?? "")
            ? match[1]
            : null
          : null;

        if (bundle) {
          const rest = match?.[2] ?? "";
          // /darwin (no trailing slash) → 301 to /darwin/ so relative HTML
          // paths like ./app.js resolve under the bundle prefix.
          if (rest === "") {
            const target = new URL(`/${bundle}/`, url.origin);
            for (const [k, v] of url.searchParams) {
              target.searchParams.set(k, v);
            }
            return Response.redirect(target.toString(), 301);
          }
          // /darwin/ → serve the bundle's index.html
          if (rest === "/") {
            const indexPath = join(webRoot, bundle, "index.html");
            try {
              const data = await Bun.file(indexPath).arrayBuffer();
              const headers = new Headers({
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-cache",
              });
              // If they arrived with ?token=, upgrade to a signed cookie now
              // so the SPA can immediately drop the token from its URL.
              const authResult = authenticate(req, opts.token, { trustTailnet: opts.trustTailnet });
              if (authResult.valid && authResult.viaQuery) {
                attachAuthCookie(headers, req, opts.token);
              }
              return new Response(data, { headers });
            } catch {
              return new Response(`${bundle} UI not built — run \`bun run build:web\``, {
                status: 404,
              });
            }
          }
          // /darwin/app.js, /os9/app.css, etc.
          const assetRel = rest.replace(/^\//, "");
          const assetPath = join(webRoot, bundle, assetRel);
          const assetFile = Bun.file(assetPath);
          if (await assetFile.exists()) {
            const type = assetRel.endsWith(".js")
              ? "application/javascript; charset=utf-8"
              : assetRel.endsWith(".css")
                ? "text/css; charset=utf-8"
                : assetRel.endsWith(".svg")
                  ? "image/svg+xml"
                  : assetRel.endsWith(".json")
                    ? "application/json"
                    : "application/octet-stream";
            // The bundle filenames (app.js/app.css) are unhashed, so they MUST
            // revalidate or browsers serve a stale UI across rebuilds/deploys.
            // A weak ETag (size+mtime) makes revalidation a cheap 304.
            const etag = `W/"${assetFile.size}-${Math.floor(assetFile.lastModified)}"`;
            if (req.headers.get("if-none-match") === etag) {
              return new Response(null, {
                status: 304,
                headers: { ETag: etag, "Cache-Control": "no-cache" },
              });
            }
            return new Response(await assetFile.arrayBuffer(), {
              headers: { "Content-Type": type, "Cache-Control": "no-cache", ETag: etag },
            });
          }
        }
      }

      // Health check is intentionally pre-auth so monitors and load balancers work unauthenticated.
      if (url.pathname === "/api/health") {
        return json({ ok: true, now: Date.now() });
      }

      // GitHub webhook is pre-auth — it carries its own HMAC signature
      // (X-Hub-Signature-256) rather than a bearer token. Verification lives
      // inside handleWebhook; an unsigned/invalid request returns 401 there.
      // Canonical path is /api/webhooks/github; /api/github/webhook is kept as
      // a deprecated alias so an in-flight URL cutover (funnel + GitHub config)
      // never has a window where deliveries 404.
      if (
        (url.pathname === "/api/webhooks/github" || url.pathname === "/api/github/webhook") &&
        req.method === "POST"
      ) {
        const result = await handleWebhook(req, {
          getJobs: () => opts.getSnapshot().jobs,
          ...(opts.onHookFire ? { onHookFire: opts.onHookFire } : {}),
          ...(opts.onHookSkip ? { onHookSkip: opts.onHookSkip } : {}),
          ...(opts.hasActiveThread ? { hasActiveThread: opts.hasActiveThread } : {}),
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Sentry / Datadog webhooks — pre-auth like the GitHub one, each
      // carries its own verification (HMAC for Sentry, shared token for
      // Datadog) inside the handler.
      if (
        (url.pathname === "/api/webhooks/sentry" || url.pathname === "/api/sentry/webhook") &&
        req.method === "POST"
      ) {
        const { handleSentryWebhook } = await import("../hooks/sentry");
        const result = await handleSentryWebhook(req, {
          getJobs: () => opts.getSnapshot().jobs,
          ...(opts.onHookFire ? { onHookFire: opts.onHookFire } : {}),
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        (url.pathname === "/api/webhooks/datadog" || url.pathname === "/api/datadog/webhook") &&
        req.method === "POST"
      ) {
        const { handleDatadogWebhook } = await import("../hooks/datadog");
        const result = await handleDatadogWebhook(req, {
          getJobs: () => opts.getSnapshot().jobs,
          ...(opts.onHookFire ? { onHookFire: opts.onHookFire } : {}),
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Linear webhook — a first-class provider alongside Sentry/Datadog/GitHub:
      // pre-auth, verifies its own Linear-Signature HMAC inside the handler,
      // extracts state/priority/assignee/labels/url, matches the structured
      // `on.linear` rule (type/team/action/priority/state/labels + @mention gate),
      // and enriches deliveries. See src/hooks/linear.ts.
      if (
        (url.pathname === "/api/webhooks/linear" || url.pathname === "/api/linear/webhook") &&
        req.method === "POST"
      ) {
        const { handleLinearWebhook } = await import("../hooks/linear");
        const result = await handleLinearWebhook(req, {
          getJobs: () => opts.getSnapshot().jobs,
          ...(opts.onHookFire ? { onHookFire: opts.onHookFire } : {}),
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Task 1.1: Require bearer token for all /api/* routes. Accepts the
      // signed cookie (set after the initial /ui/?token= handshake), a Bearer
      // header, or ?token=… as a one-shot. /api/inject also accepts the
      // legacy settings.apiToken so existing automation isn't broken.
      if (url.pathname.startsWith("/api/")) {
        const apiToken = opts.getSnapshot().settings.apiToken;
        const validWebToken = checkToken(req, opts.token, { trustTailnet: opts.trustTailnet });
        const validApiToken =
          url.pathname === "/api/inject" && !!apiToken && checkToken(req, apiToken);
        if (!(validWebToken || validApiToken)) {
          return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // All /api/* (and remaining) routes are served by the ordered route
      // table (src/ui/routes/). The dispatcher walks it in the same order as
      // the original if-ladder, returning the first handler that produces a
      // Response, or a 405/404 fallback.
      const ctx: RouteCtx = { req, url, opts, sseResponse };
      return dispatch(ctx);
    },
  });

  return {
    stop: () => void server.stop(),
    host: opts.host,
    port: opts.port,
  };
}
