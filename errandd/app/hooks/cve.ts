import { acceptsCveWebhooks } from "../../shared/eventSources";
import { getCveConnection } from "../eventSourceSettings";
import {
  advisoryDigest,
  advisoryAliases,
  findAdvisory,
  mergeAdvisory,
  mergedAdvisory,
  assessmentReceipts,
  assessmentMaterials,
  saveAssessment,
  serializeAdvisory,
  type AdvisoryStore,
} from "../cve-store";
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
import { getReadCache } from "../readCache";
import type { WebhookDeps } from "./receiver";
import type { SourcePlugin } from "./sources";

export const cveDigest = advisoryDigest;
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
    classified(rule.webserver ?? [], alert.technologies) &&
    (!(rule.product.length || rule.vendor.length) ||
      alert.products.some(
        (product) => matches(rule.product, product.product) && matches(rule.vendor, product.vendor),
      ))
  );
}

/** Queue before recording a receipt. A crash or partial fan-out retries the
 * same deterministic queue id; receipts persist beyond the delivery ring. */
export function dispatchCveAlert(
  incoming: CveAlert,
  jobs: Job[],
  fire: NonNullable<WebhookDeps["onHookFire"]>,
  store: AdvisoryStore = getReadCache(),
  pollOnly = false,
): Promise<DeliveryRoutine[]> {
  return serializeAdvisory(store, async () => {
    const eligible = jobs.filter(
      (job) =>
        job.enabled !== false &&
        job.hookConfig?.cve &&
        (!pollOnly || job.hookConfig.cve === true || job.hookConfig.cve.poll) &&
        (job.hookConfig.cve === true ||
          !job.hookConfig.cve.lockfiles ||
          Boolean(incoming.dependencyEvidence?.length)),
    );
    const ruleFor = (job: Job) =>
      job.hookConfig!.cve === true ? defaultCveRule() : (job.hookConfig!.cve as CveRule);
    // Do not retain the entire global catalogue on disk. Keep relevant records
    // and subsequent enrichment/rejections for records already being tracked.
    if (
      incoming.test ||
      (!eligible.some((job) => cveRuleMatches(ruleFor(job), incoming)) &&
        !advisoryAliases(incoming).some((alias) => findAdvisory(store, alias)))
    )
      return eligible.map((job) => ({
        job: job.name,
        outcome: "skip" as const,
        reason: incoming.test
          ? "CVEFeed test delivery; no remediation run"
          : "CVE filters did not match",
      }));
    const record = mergeAdvisory(store, incoming);
    const alert = mergedAdvisory(record);
    const materials: Record<string, string> = incoming.dependencyEvidence
      ? {
          osv: record.observations.osv?.material ?? cveDigest(incoming.affected),
          lockfiles: cveDigest([
            incoming.dependencyEvidence,
            incoming.dependencyScanGeneration ?? 0,
          ]),
        }
      : assessmentMaterials(record);
    const routines: DeliveryRoutine[] = [];
    for (const job of eligible) {
      const rule = ruleFor(job);
      if (!cveRuleMatches(rule, alert)) {
        routines.push({
          job: job.name,
          outcome: "skip",
          reason: alert.rejected
            ? "Advisory was rejected or withdrawn"
            : "CVE filters did not match",
        });
        continue;
      }
      for (const targetRepository of rule.repositories) {
        const receipts = assessmentReceipts(store, record, targetRepository);
        // The first observation from an additional source is enrichment. Once
        // acknowledged, a changed affected range/severity/withdrawal is material.
        const unchanged = receipts.some((receipt) =>
          Object.entries(materials).every(
            ([source, material]) =>
              receipt.materials[source] === undefined || receipt.materials[source] === material,
          ),
        );
        const updateTime = Date.parse(incoming.updatedAt);
        const legacy =
          !receipts.length &&
          record.aliases.some((alias) =>
            eligible.some((candidate) => {
              const key = cveDigest([candidate.name, targetRepository.toLowerCase(), alias]);
              const seen = store.get<{ revision: string; updatedAt: string }>(
                "cve-receipts",
                key,
              )?.value;
              return (
                seen && Number.isFinite(updateTime) && Date.parse(seen.updatedAt) >= updateTime
              );
            }),
          );
        if (unchanged || legacy) {
          saveAssessment(store, record, targetRepository, materials);
          continue;
        }
        const key = cveDigest([record.id, targetRepository.toLowerCase()]);
        const revision = cveDigest(
          Object.keys(materials).map((source) => [
            source,
            materials[source],
            record.observations[source as CveAlert["source"]]?.generation ?? 0,
          ]),
        );
        await fire(job.name, "cve:alert", `cve-${key}-${revision}`, {
          ...alert,
          targetRepository,
          ...(incoming.dependencyEvidence
            ? { dependencyEvidence: incoming.dependencyEvidence }
            : {}),
        });
        saveAssessment(store, record, targetRepository, materials);
        routines.push({ job: job.name, outcome: "trigger" });
      }
    }
    return routines;
  });
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
      !acceptsCveWebhooks(getCveConnection())
        ? { status: 202, body: { ok: true } }
        : readCveAlert(payload)
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
