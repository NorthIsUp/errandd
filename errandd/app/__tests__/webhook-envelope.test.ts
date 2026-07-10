import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetDeliveryStoreForTests,
  type Delivery,
  type DeliveryRoutine,
  recentDeliveries,
  recordDelivery,
} from "../hooks/deliveries";
import {
  constantTimeEquals,
  handleSignedWebhook,
  verifyHmac,
  type WebhookSpec,
} from "../hooks/webhookEnvelope";

let seq = 0;
const uid = (p: string) => `${p}-${process.pid}-${seq++}`;

afterEach(() => __resetDeliveryStoreForTests());

function jsonReq(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://local/api/webhooks/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

interface SpyState {
  attempts: { status: Delivery["status"]; body: string }[];
  matchCalls: number;
}

function makeSpec(
  spy: SpyState,
  over: Partial<WebhookSpec> = {},
): WebhookSpec {
  const id = uid("dlv");
  return {
    source: "sentry",
    auth: { kind: "hmac", header: "x-sig", secret: "" },
    deriveIdentity: () => ({ event: "test:evt", id, summary: "summary" }),
    match: () => {
      spy.matchCalls++;
      return [];
    },
    recordAttempt: (_req, body, status) => {
      spy.attempts.push({ status, body });
      // Mirror the real receivers: a failed attempt still lands in the ring.
      recordDeliveryRow(uid("attempt"), status, body);
    },
    ...over,
  };
}

function recordDeliveryRow(id: string, status: Delivery["status"], body: string): void {
  // Tiny local helper so the spy records a ring entry the same way a receiver's
  // recordXxxAttempt does (without importing the provider files).
  recordDelivery({
    id,
    event: "test:evt",
    receivedAt: Date.now(),
    summary: "attempt",
    status,
    matched: [],
    payloadSnippet: body.slice(0, 2048),
  });
}

const deps = {};

describe("verifyHmac", () => {
  test("accepts a correct bare-hex signature, rejects a wrong one", () => {
    const body = '{"a":1}';
    const sig = createHmac("sha256", "secret").update(body, "utf8").digest("hex");
    expect(verifyHmac("secret", sig, body)).toBe(true);
    expect(verifyHmac("secret", sig, '{"a":2}')).toBe(false);
    expect(verifyHmac("secret", "", body)).toBe(false);
  });

  test("prefix mode (github sha256=) unwraps and validates", () => {
    const body = "payload";
    const hex = createHmac("sha256", "k").update(body, "utf8").digest("hex");
    expect(verifyHmac("k", `sha256=${hex}`, body, "sha256=")).toBe(true);
    // Missing/incorrect prefix → reject.
    expect(verifyHmac("k", hex, body, "sha256=")).toBe(false);
    expect(verifyHmac("k", `sha1=${hex}`, body, "sha256=")).toBe(false);
  });
});

describe("constantTimeEquals", () => {
  test("equal strings true, unequal/length-mismatch false", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abd")).toBe(false);
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
  });
});

describe("handleSignedWebhook — guards", () => {
  test("415 on a non-JSON content-type, before any auth/match", async () => {
    const spy: SpyState = { attempts: [], matchCalls: 0 };
    const req = new Request("http://local/x", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    const res = await handleSignedWebhook(req, deps, makeSpec(spy));
    expect(res).toEqual({ status: 415, body: { ok: false, error: "json required" } });
    expect(spy.matchCalls).toBe(0);
    expect(spy.attempts).toEqual([]);
  });

  test("401 + recorded attempt on a bad HMAC signature (no match run)", async () => {
    const spy: SpyState = { attempts: [], matchCalls: 0 };
    const spec = makeSpec(spy, { auth: { kind: "hmac", header: "x-sig", secret: "s3cret" } });
    const res = await handleSignedWebhook(jsonReq("{}", { "x-sig": "deadbeef" }), deps, spec);
    expect(res).toEqual({ status: 401, body: { ok: false, error: "bad signature" } });
    expect(spy.matchCalls).toBe(0);
    expect(spy.attempts).toEqual([{ status: "bad-signature", body: "{}" }]);
    // The failed attempt is visible in the ring.
    expect(recentDeliveries().some((d) => d.status === "bad-signature")).toBe(true);
  });

  test("401 token auth reports 'bad token'", async () => {
    const spy: SpyState = { attempts: [], matchCalls: 0 };
    const spec = makeSpec(spy, { auth: { kind: "token", header: "x-token", secret: "T" } });
    const res = await handleSignedWebhook(jsonReq("{}", { "x-token": "nope" }), deps, spec);
    expect(res).toEqual({ status: 401, body: { ok: false, error: "bad token" } });
    expect(spy.attempts[0]?.status).toBe("bad-signature");
  });

  test("token auth passes via a correct ?token= query param", async () => {
    const spy: SpyState = { attempts: [], matchCalls: 0 };
    const spec = makeSpec(spy, { auth: { kind: "token", header: "x-token", secret: "T" } });
    const req = new Request("http://local/x?token=T", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const res = await handleSignedWebhook(req, deps, spec);
    expect(res.status).toBe(200);
    expect(spy.matchCalls).toBe(1);
  });

  test("400 + recorded attempt on invalid JSON (auth disabled)", async () => {
    const spy: SpyState = { attempts: [], matchCalls: 0 };
    const res = await handleSignedWebhook(jsonReq("{not json"), deps, makeSpec(spy));
    expect(res).toEqual({ status: 400, body: { ok: false, error: "invalid json" } });
    expect(spy.matchCalls).toBe(0);
    expect(spy.attempts).toEqual([{ status: "error", body: "{not json" }]);
  });
});

describe("handleSignedWebhook — record / dedup / match", () => {
  test("a fresh delivery runs match and returns matched names", async () => {
    const spy: SpyState = { attempts: [], matchCalls: 0 };
    const spec = makeSpec(spy, {
      derivePk: () => "PK-1",
      match: ({ delivery }): DeliveryRoutine[] => {
        spy.matchCalls++;
        delivery.matched.push("job1");
        return [{ job: "job1", outcome: "trigger" }];
      },
    });
    const res = await handleSignedWebhook(jsonReq('{"x":1}'), deps, spec);
    expect(res).toEqual({ status: 200, body: { ok: true, matched: ["job1"] } });
    expect(spy.matchCalls).toBe(1);
    // The envelope recorded the evaluation (source/pk/routines) onto the ring.
    const rec = recentDeliveries().find((d) => d.event === "test:evt");
    expect(rec?.source).toBe("sentry");
    expect(rec?.pk).toBe("PK-1");
    expect(rec?.routines).toEqual([{ job: "job1", outcome: "trigger" }]);
    expect(rec?.payload).toEqual({ x: 1 });
  });

  test("no match → 200 ok with no `matched` key", async () => {
    const spy: SpyState = { attempts: [], matchCalls: 0 };
    const res = await handleSignedWebhook(jsonReq("{}"), deps, makeSpec(spy));
    expect(res).toEqual({ status: 200, body: { ok: true } });
  });

  test("a duplicate delivery id short-circuits with duplicate:true and skips match", async () => {
    const spy: SpyState = { attempts: [], matchCalls: 0 };
    // Stable id across both calls so the second is a dedup hit.
    const fixedId = uid("dup");
    const spec = makeSpec(spy, {
      deriveIdentity: () => ({ event: "test:evt", id: fixedId, summary: "s" }),
      match: () => {
        spy.matchCalls++;
        return [];
      },
    });
    const first = await handleSignedWebhook(jsonReq("{}"), deps, spec);
    expect(first.status).toBe(200);
    const second = await handleSignedWebhook(jsonReq("{}"), deps, spec);
    expect(second).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    // match ran only for the first (fresh) delivery.
    expect(spy.matchCalls).toBe(1);
  });

  test("evaluate:'match' lets the callback own recording (envelope records nothing)", async () => {
    const spy: SpyState = { attempts: [], matchCalls: 0 };
    const spec = makeSpec(spy, {
      evaluate: "match",
      derivePk: () => "SHOULD-NOT-APPEAR",
      match: ({ delivery }) => {
        delivery.matched.push("g");
        return [{ job: "g", outcome: "trigger" }];
      },
    });
    const res = await handleSignedWebhook(jsonReq("{}"), deps, spec);
    expect(res).toEqual({ status: 200, body: { ok: true, matched: ["g"] } });
    // The envelope did NOT call setDeliveryEvaluation → pk stays unset.
    const rec = recentDeliveries().find((d) => d.event === "test:evt");
    expect(rec?.pk).toBeUndefined();
  });
});
