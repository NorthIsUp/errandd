/**
 * Inbound webhook SOURCE plugin registry.
 *
 * A `SourcePlugin` owns the FULL inbound lifecycle for one provider — routing,
 * signature/token verification, identity derivation, payload→envelope parsing,
 * per-routine matching, delivery-table extraction, config-rule parsing, and
 * receiver status. The four first-party providers (github / sentry / datadog /
 * linear) are core plugins; additional providers register at runtime through
 * `PluginManager.registerSource` (see app/plugins.ts).
 *
 * Every layer that used to hardcode each provider by name now iterates this
 * registry instead:
 *   - app/ui/server.ts      mounts each `routePath` (+ alias) generically
 *   - app/hooks/receiver.ts drives the shared lifecycle via `webhookSpec`
 *   - app/hooks/deliveries  maps an event → source via `ownsEvent`
 *   - app/hooks/evaluate.ts extracts pk/keys/fields via `extract*`
 *   - app/hooks/schema.ts   parses `on:` triggers via `configKeys`/`parseRule`
 *   - app/ui/routes/hooks   reports receiver status via `providerStatus`
 *
 * Load order: the registry is LAZY. Core providers are imported statically but
 * only referenced inside `ensureLoaded()` (memoized), so the sources ↔ provider
 * ↔ schema/evaluate import cycle never touches an uninitialized binding at
 * module-eval time. Plugin sources may register before or after first use.
 */

import type { DeliverySource } from "../../shared/deliverySources";
import { brandPluginSourceId } from "../../shared/deliverySources";
import type { DeliveryField, DeliveryKeys } from "../../shared/deliveryTypes";
// Core provider plugin objects. These imports create a sources↔provider import
// cycle; it is safe because the plugin objects are only dereferenced inside
// ensureLoaded()/lookups (runtime), never at this module's top-level eval.
import { datadogSource } from "./datadog";
import { cveSource } from "./cve";
import type { CveRule } from "../../shared/cve";
import { githubSource } from "./github";
import { linearSource } from "./linear";
import type {
  ChecksRule,
  CommentRule,
  DatadogRule,
  IssuesRule,
  LinearRule,
  PrRule,
  ReviewRule,
  SentryRule,
} from "./schema";
import { sentrySource } from "./sentry";
import type { WebhookSpec } from "./webhookEnvelope";

/** Per-provider receiver status shown in the Settings UI. `origin` is the
 *  request origin (`https://host`) used to render copy-paste webhook URLs. */
export interface ProviderStatus {
  /** True when the source's secret/token is configured (verification live). */
  configured: boolean;
  /** The raw secret (the UI is bearer-gated; a reveal affordance shows it). */
  secret: string;
  /** Canonical inbound URL to paste into the provider's webhook config. */
  url: string;
  /** The env var that carries the secret (surfaced for setup docs). */
  secretEnv?: string;
  /** Optional provider-specific extras (Datadog token URL + payload template,
   *  Linear bot @mention, …). Merged into the provider's status object. */
  extra?: Record<string, unknown>;
}

/**
 * The mutable accumulator threaded through `parseRule` as a routine's `on:`
 * list is parsed. Each source mutates only the fields it owns; `sawEventTrigger`
 * flips true the moment any event trigger (not a bare `schedule`) is seen.
 */
export interface TriggerBuilder {
  cve: boolean | CveRule;
  prRules: PrRule[];
  comments: boolean | CommentRule;
  reviews: boolean | ReviewRule;
  sentry: boolean | SentryRule;
  datadog: boolean | DatadogRule;
  linear: boolean | LinearRule;
  checks: boolean | ChecksRule;
  issues: boolean | IssuesRule;
  /** Default repo/user scope applied to bare PR rules. */
  prDefaults: { repo: string[]; user: string[] };
  /** Index of the current `on[i]` item (for error messages). */
  index: number;
  sawEventTrigger: boolean;
}

/**
 * A registered inbound source. Core providers implement the whole surface;
 * plugin providers may omit `configKeys`/`parseRule` (no routine-config trigger)
 * and fall back to generic extraction.
 */
export interface SourcePlugin {
  /** Stable id + evaluation `source` tag (core union member or branded plugin id). */
  id: DeliverySource;
  /** Canonical inbound route, e.g. `/api/webhooks/github`. */
  routePath: string;
  /** Deprecated-alias route kept live during URL cutovers, e.g. `/api/github/webhook`. */
  aliasPath?: string;

  /** Build the per-request signed-webhook spec (reads secrets fresh from env).
   *  `receiver.dispatchInbound` feeds this straight into `handleSignedWebhook`. */
  webhookSpec(): WebhookSpec;

  /** Does this event name belong to this source? Drives event→source mapping
   *  (deliveries table, routing) without a central switch. */
  ownsEvent(event: string): boolean;

  /** Ordered headline fields for the deliveries table (most significant first). */
  extractFields(event: string, payload: unknown): DeliveryField[];
  /** The two labeled "key" columns. */
  extractKeys(event: string, payload: unknown): DeliveryKeys;
  /** The short headline id (PR#, issue id, monitor…). */
  extractPk(event: string, payload: unknown): string;

  /** The routine `on:` trigger keys this source owns (e.g. github →
   *  pr/prs/comments/reviews/checks/issues; sentry → sentry). Empty when the
   *  source has no routine-config trigger. */
  configKeys: readonly string[];
  /** Parse one owned `on:` trigger value into the shared builder. Only called
   *  for keys listed in `configKeys`. */
  parseRule?(key: string, val: unknown, b: TriggerBuilder): void;

  /** Per-provider receiver status for the Settings UI. */
  providerStatus(origin: string): ProviderStatus;
}

// ── Registry ─────────────────────────────────────────────────────────────────

/** Core providers, filled lazily on first access (see ensureLoaded). */
const coreSources = new Map<string, SourcePlugin>();
/** Plugin-registered providers (open, branded-id tier). */
const pluginSources = new Map<string, SourcePlugin>();
let coreLoaded = false;

/**
 * Populate the core registry on first use. Core provider modules are imported
 * statically at the bottom of this file; referencing their plugin objects here
 * (lazily) rather than at top-level keeps the import cycle safe.
 */
function ensureLoaded(): void {
  if (coreLoaded) {
    return;
  }
  coreLoaded = true;
  for (const src of [githubSource, sentrySource, datadogSource, linearSource, cveSource]) {
    coreSources.set(src.id, src);
  }
}

/** All registered sources: core first (stable order), then plugin sources. */
export function getSources(): SourcePlugin[] {
  ensureLoaded();
  return [...coreSources.values(), ...pluginSources.values()];
}

/** Look up a source by its id, or undefined. */
export function sourceById(id: string): SourcePlugin | undefined {
  ensureLoaded();
  return coreSources.get(id) ?? pluginSources.get(id);
}

/** The source that owns `event`, or the github core source as the historical
 *  default (GitHub events are the unprefixed majority). Never throws. */
export function sourceForEvent(event: string): SourcePlugin {
  ensureLoaded();
  for (const src of getSources()) {
    if (src !== githubSource && src.ownsEvent(event)) {
      return src;
    }
  }
  return githubSource;
}

/** The source that owns a routine-config trigger key (`sentry`, `pr`, …). */
export function sourceForConfigKey(key: string): SourcePlugin | undefined {
  ensureLoaded();
  for (const src of getSources()) {
    if (src.configKeys.includes(key)) {
      return src;
    }
  }
  return undefined;
}

/**
 * Register a plugin (non-core) source. The id is validated + branded into the
 * open plugin tier (a core-id collision or malformed id throws). Idempotent
 * per id — a re-register replaces the prior plugin.
 */
export function registerSource(plugin: SourcePlugin): void {
  const id = brandPluginSourceId(plugin.id);
  pluginSources.set(id, { ...plugin, id });
}

/** Test-only: drop plugin registrations (core sources are immutable). */
export function __resetPluginSourcesForTests(): void {
  pluginSources.clear();
}
