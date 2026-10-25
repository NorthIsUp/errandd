import { createHash } from "node:crypto";
import {
  defaultCveRule,
  parseCveRule,
  queuedCveAlert,
  readCveAlert,
  type CveAlert,
  type CveRule,
} from "../../shared/cve";
import { matchPatternList, matchesGlob } from "../../shared/hookPayload";
import type { DeliveryRoutine } from "../../shared/deliveryTypes";
import type { Job } from "../jobs";
import { getReadCache, type ReadCache } from "../readCache";
import type { WebhookDeps } from "./receiver";
import type { SourcePlugin } from "./sources";

export const cveDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
export function cveRuleMatches(rule: CveRule, alert: CveAlert): boolean {
  const matches = (patterns: string[], value: string) =>
    !patterns.length || matchPatternList(patterns, value);
  const classified = (patterns: string[], values: string[]) => {
    if (!patterns.length) return true;
    if (!values.length) return rule.includeUnclassified;
    if (
      patterns.some(
        (pattern) =>
          pattern.startsWith("!") &&
          values.some((value) => matchesGlob(pattern.slice(1).toLowerCase(), value.toLowerCase())),
      )
    )
      return false;
    const positive = patterns.filter((pattern) => !pattern.startsWith("!"));
    return !positive.length || values.some((value) => matchPatternList(positive, value));
  };
  return (
    !alert.rejected &&
    !alert.test &&
    rule.repositories.length > 0 &&
    rule.severity.length > 0 &&
    matches(rule.severity, alert.severity) &&
    matches(rule.project, alert.project) &&
    classified(rule.ecosystem, alert.ecosystems) &&
    classified(rule.language, alert.languages) &&
    classified(rule.technology, alert.technologies) &&
    (!(rule.product.length || rule.vendor.length) ||
      alert.products.some(
        (product) => matches(rule.product, product.product) && matches(rule.vendor, product.vendor),
      ))
  );
}

/** Queue before recording a receipt. A crash or partial fan-out retries the
 * same deterministic queue id; receipts persist beyond the delivery ring. */
export async function dispatchCveAlert(
  alert: CveAlert,
  jobs: Job[],
  fire: NonNullable<WebhookDeps["onHookFire"]>,
  store: Pick<ReadCache, "get" | "set"> = getReadCache(),
  pollOnly = false,
): Promise<DeliveryRoutine[]> {
  const routines: DeliveryRoutine[] = [];
  const revision = cveDigest([
    alert.id,
    alert.updatedAt,
    alert.title,
    alert.description,
    alert.severity,
    alert.affected,
    alert.products,
  ]);
  for (const job of jobs) {
    if (!job.hookConfig?.cve || job.enabled === false) continue;
    const rule = job.hookConfig.cve === true ? defaultCveRule() : job.hookConfig.cve;
    if (pollOnly && !rule.poll) continue;
    if (!cveRuleMatches(rule, alert)) {
      routines.push({
        job: job.name,
        outcome: "skip",
        reason: alert.test
          ? "CVEFeed test delivery; no remediation run"
          : alert.rejected
            ? "CVE was rejected"
            : "CVE filters did not match",
      });
      continue;
    }
    for (const targetRepository of rule.repositories) {
      const key = cveDigest([job.name, targetRepository.toLowerCase(), alert.id]);
      const seen = store.get<{ revision: string; updatedAt: string }>("cve-receipts", key)?.value;
      if (
        seen?.revision === revision ||
        (seen && Date.parse(seen.updatedAt) > Date.parse(alert.updatedAt))
      )
        continue;
      await fire(job.name, "cve:alert", `cve-${key}-${revision}`, { ...alert, targetRepository });
      store.set("cve-receipts", key, { revision, updatedAt: alert.updatedAt });
      routines.push({ job: job.name, outcome: "trigger" });
    }
  }
  return routines;
}

const alertFor = (payload: unknown) => queuedCveAlert(payload);
export const cveSource: SourcePlugin = {
  id: "cve",
  routePath: "/api/webhooks/cvefeed",
  aliasPath: "/api/webhooks/cve",
  ownsEvent: (event) => event.startsWith("cve:"),
  configKeys: ["cve", "cvefeed"],
  parseRule: (_key, value, builder) => {
    builder.cve = parseCveRule(value);
    builder.sawEventTrigger = true;
  },
  providerStatus: (origin) => ({
    configured: Boolean(process.env.ERRANDD_CVEFEED_WEBHOOK_SECRET),
    secret: process.env.ERRANDD_CVEFEED_WEBHOOK_SECRET ?? "",
    url: `${origin}/api/webhooks/cvefeed`,
    secretEnv: "ERRANDD_CVEFEED_WEBHOOK_SECRET",
    extra: {
      header: "X-Webhook-Secret",
      documentationUrl: "https://docs.cvefeed.io/integrations/webhooks/",
    },
  }),
  extractPk: (_event, payload) => alertFor(payload)?.id ?? "",
  extractFields: (_event, payload) => {
    const alert = alertFor(payload);
    return alert
      ? [
          { label: "cve", value: alert.id },
          { label: "title", value: alert.title },
          { label: "severity", value: alert.severity },
          { label: "product", value: alert.products.map((product) => product.product).join(", ") },
        ]
      : [];
  },
  extractKeys: (_event, payload) => ({
    key1Label: "CVE",
    key1: alertFor(payload)?.id ?? "",
    key2Label: "severity",
    key2: alertFor(payload)?.severity ?? "",
  }),
  webhookSpec: () => ({
    source: "cve",
    deduplicate: false,
    auth: {
      kind: "token",
      required: true,
      headerOnly: true,
      header: "x-webhook-secret",
      secret: process.env.ERRANDD_CVEFEED_WEBHOOK_SECRET ?? "",
    },
    deriveIdentity: (_req, payload) => {
      const alert = alertFor(payload);
      return {
        id: `cvefeed-${cveDigest(payload)}`,
        event: "cve:alert",
        summary: alert
          ? `${alert.id} · ${alert.severity} · ${alert.title}`
          : "Invalid CVEFeed alert",
      };
    },
    preRecord: (_identity, payload) =>
      readCveAlert(payload)
        ? null
        : {
            status: 400,
            body: { ok: false, error: "expected a CVEFeed vulnerability or CVE JSON record" },
          },
    match: async ({ payload, delivery, deps }) => {
      if (!deps.getJobs || !deps.onHookFire) throw new Error("CVE queue is unavailable");
      const routines = await dispatchCveAlert(
        readCveAlert(payload)!,
        await deps.getJobs(),
        deps.onHookFire,
      );
      delivery.matched.push(
        ...new Set(
          routines.filter((routine) => routine.outcome === "trigger").map((routine) => routine.job),
        ),
      );
      return routines;
    },
    recordAttempt: () => {},
  }),
};
