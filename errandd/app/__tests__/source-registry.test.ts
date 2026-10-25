import { afterEach, describe, expect, test } from "bun:test";
import {
  asDeliverySource,
  brandPluginSourceId,
  CORE_DELIVERY_SOURCES,
  isCoreDeliverySource,
  isValidPluginSourceId,
} from "../../shared/deliverySources";
import {
  __resetDeliveryStoreForTests,
  deliverySourceFromEvent,
  recentDeliveries,
} from "../hooks/deliveries";
import { createGenericWebhookSource, genericWebhookPlugin } from "../hooks/genericWebhook";
import { dispatchInbound } from "../hooks/receiver";
import {
  __resetPluginSourcesForTests,
  getSources,
  registerSource,
  sourceById,
  sourceForConfigKey,
  sourceForEvent,
} from "../hooks/sources";
import type { PluginApi } from "../plugins";

afterEach(() => {
  __resetPluginSourcesForTests();
  __resetDeliveryStoreForTests();
});

describe("two-tier DeliverySource", () => {
  test("core ids narrow; arbitrary strings do not", () => {
    expect(CORE_DELIVERY_SOURCES).toEqual(["github", "sentry", "datadog", "linear", "cve"]);
    expect(isCoreDeliverySource("github")).toBe(true);
    expect(isCoreDeliverySource("acme")).toBe(false);
  });

  test("asDeliverySource is total — never throws on unknown/historical ids", () => {
    expect(asDeliverySource("github")).toBe("github");
    // A historic or plugin-written id passes through (branded), no crash.
    expect(asDeliverySource("legacy-source-42") as string).toBe("legacy-source-42");
    expect(asDeliverySource("") as string).toBe("");
  });

  test("plugin id validation rejects malformed / core-colliding ids", () => {
    expect(isValidPluginSourceId("acme")).toBe(true);
    expect(isValidPluginSourceId("github")).toBe(false); // reserved core id
    expect(isValidPluginSourceId("Bad Id")).toBe(false); // whitespace/uppercase
    expect(() => brandPluginSourceId("github")).toThrow();
    expect(brandPluginSourceId("acme") as string).toBe("acme");
  });
});

describe("core registry", () => {
  test("the four core sources are registered with stable order + routes", () => {
    const ids = getSources().map((s) => s.id);
    expect(ids.slice(0, 4)).toEqual(["github", "sentry", "datadog", "linear"]);
    expect(sourceById("github")?.routePath).toBe("/api/webhooks/github");
    expect(sourceById("sentry")?.aliasPath).toBe("/api/sentry/webhook");
  });

  test("sourceForEvent maps prefixes to sources; github is the fallback", () => {
    expect(sourceForEvent("sentry:issue").id).toBe("sentry");
    expect(sourceForEvent("datadog:alert").id).toBe("datadog");
    expect(sourceForEvent("linear:issue").id).toBe("linear");
    expect(sourceForEvent("pull_request").id).toBe("github");
    expect(deliverySourceFromEvent("sentry:error")).toBe("sentry");
    expect(deliverySourceFromEvent("push")).toBe("github");
  });

  test("sourceForConfigKey routes trigger keys to their owning source", () => {
    expect(sourceForConfigKey("pr")?.id).toBe("github");
    expect(sourceForConfigKey("comments")?.id).toBe("github");
    expect(sourceForConfigKey("sentry")?.id).toBe("sentry");
    expect(sourceForConfigKey("datadog")?.id).toBe("datadog");
    expect(sourceForConfigKey("linear")?.id).toBe("linear");
    expect(sourceForConfigKey("nope")).toBeUndefined();
  });
});

describe("registerSource — open plugin tier", () => {
  test("a plugin source joins the registry and is looked up by id/event", () => {
    registerSource(createGenericWebhookSource({ id: "acme" }));
    expect(sourceById("acme")?.routePath).toBe("/api/webhooks/acme");
    expect(sourceForEvent("acme:deploy").id as string).toBe("acme");
    expect(getSources().map((s) => s.id as string)).toContain("acme");
  });

  test("a core-id collision throws (core ids are reserved)", () => {
    expect(() => registerSource(createGenericWebhookSource({ id: "github" }))).toThrow();
  });

  test("PluginManager-style registerSource routes into the same registry", () => {
    // A minimal PluginApi stub — only registerSource is exercised here.
    const api = {
      registerSource,
    } as unknown as PluginApi;
    void genericWebhookPlugin(api);
    expect(sourceById("generic")?.id as string | undefined).toBe("generic");
  });
});

describe("generic-webhook source — full inbound lifecycle", () => {
  function jsonReq(body: unknown, headers: Record<string, string> = {}): Request {
    return new Request("http://local/api/webhooks/acme", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  test("token-auth (header or ?token=) + configurable event field", async () => {
    const prev = process.env.ACME_TOKEN;
    process.env.ACME_TOKEN = "T0ken";
    try {
      const src = createGenericWebhookSource({
        id: "acme",
        tokenEnv: "ACME_TOKEN",
        tokenHeader: "x-acme-token",
        eventField: "type",
      });
      registerSource(src);

      // Wrong token → 401 (bad token).
      const bad = await dispatchInbound(src, jsonReq({ type: "deploy" }, { "x-acme-token": "no" }));
      expect(bad).toEqual({ status: 401, body: { ok: false, error: "bad token" } });

      // Correct token via header → 200, recorded with the branded source id and
      // the configurable event field folded into the event name.
      const ok = await dispatchInbound(
        src,
        jsonReq({ type: "deploy", id: "d-1", title: "shipped" }, { "x-acme-token": "T0ken" }),
      );
      expect(ok.status).toBe(200);
      const rec = recentDeliveries().find((d) => d.id === "acme-d-1");
      expect(rec?.event).toBe("acme:deploy");
      expect(rec?.source as string | undefined).toBe("acme");
      expect(rec?.pk).toBe("d-1");
      expect(rec?.fields).toEqual([
        { label: "type", value: "deploy" },
        { label: "title", value: "shipped" },
      ]);

      // Correct token via ?token= query param also passes.
      const viaQuery = new Request("http://local/api/webhooks/acme?token=T0ken", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "rollback", id: "d-2" }),
      });
      const ok2 = await dispatchInbound(src, viaQuery);
      expect(ok2.status).toBe(200);
      expect(recentDeliveries().some((d) => d.id === "acme-d-2")).toBe(true);
    } finally {
      if (prev === undefined) {
        delete process.env.ACME_TOKEN;
      } else {
        process.env.ACME_TOKEN = prev;
      }
    }
  });

  test("unset token ⇒ verification disabled (accept as-is), like the core sources", async () => {
    const src = createGenericWebhookSource({ id: "acme", tokenEnv: "UNSET_ACME_TOKEN" });
    const res = await dispatchInbound(src, jsonReq({ event: "ping", id: "p-1" }));
    expect(res.status).toBe(200);
    expect(recentDeliveries().some((d) => d.id === "acme-p-1")).toBe(true);
  });
});
