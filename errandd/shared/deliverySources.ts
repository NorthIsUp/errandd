/**
 * Two-tier delivery-source identity space — the browser-safe core.
 *
 * This module is imported by the esbuild **web bundle** as well as the daemon,
 * so it MUST stay pure types + consts: no node/bun imports, no server code.
 *
 * Tier 1 — CORE sources: a closed, compile-time union derived from the static
 *   `CORE_DELIVERY_SOURCES` tuple. The four first-party providers
 *   (github / sentry / datadog / linear) live here and are known at build time,
 *   so `source === "github"` style narrowing keeps working across the codebase.
 *
 * Tier 2 — PLUGIN sources: an OPEN, branded-string identifier space. A
 *   `SourcePlugin` registered at runtime (see app/hooks/sources.ts) picks any
 *   id; it is validated then branded into `PluginDeliverySource`. Because the
 *   brand is erased at runtime, a plugin id is just a string on the wire — but
 *   the type system stops a bare `string` from silently standing in for a
 *   `DeliverySource` without going through {@link asDeliverySource}.
 *
 * DB/API reads must tolerate unknown historical/plugin source strings: use
 * {@link asDeliverySource} (a total, never-throwing coercion) rather than a
 * checked parse, so a historic row or a plugin-written row with an id outside
 * the core union never crashes a reader.
 */

/** The first-party (core) delivery sources, known at compile time. */
export const CORE_DELIVERY_SOURCES = ["github", "sentry", "datadog", "linear", "cve"] as const;

/** Closed compile-time union of the core sources. */
export type CoreDeliverySource = (typeof CORE_DELIVERY_SOURCES)[number];

/**
 * A plugin-registered source id: a branded string. The brand is a compile-time
 * marker only (erased at runtime) so plugin ids remain plain strings on the
 * wire while the type system prevents an unbranded `string` from being used
 * where a validated `DeliverySource` is expected.
 */
export type PluginDeliverySource = string & { readonly __deliverySource: "plugin" };

/** Any delivery source — a known core id or a validated plugin id. */
export type DeliverySource = CoreDeliverySource | PluginDeliverySource;

const CORE_SET: ReadonlySet<string> = new Set(CORE_DELIVERY_SOURCES);

/** Narrow an arbitrary string to a core source id. */
export function isCoreDeliverySource(s: string): s is CoreDeliverySource {
  return CORE_SET.has(s);
}

/** The shape a plugin source id must satisfy: lowercase alphanumerics plus
 *  `-`/`_`, 1–64 chars, not colliding with a core id (core ids are reserved). */
const PLUGIN_SOURCE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** True when `id` is a well-formed plugin source id (and not a reserved core id). */
export function isValidPluginSourceId(id: string): boolean {
  return !CORE_SET.has(id) && PLUGIN_SOURCE_ID_RE.test(id);
}

/**
 * Total, never-throwing coercion of an arbitrary string to a `DeliverySource`.
 * Core ids pass through as their literal type; everything else is branded into
 * the open plugin tier. Use for DB/API reads so an unknown historical or
 * plugin-written id is tolerated rather than crashing the reader.
 */
export function asDeliverySource(s: string): DeliverySource {
  if (isCoreDeliverySource(s)) {
    return s;
  }
  return s as PluginDeliverySource;
}

/**
 * Validate + brand a plugin-registered source id, throwing on a malformed or
 * reserved id. Used at registration time (fail fast) — NOT on read paths.
 */
export function brandPluginSourceId(id: string): PluginDeliverySource {
  if (!isValidPluginSourceId(id)) {
    throw new Error(
      `invalid plugin source id "${id}": must match ${PLUGIN_SOURCE_ID_RE} and not collide with a core source (${CORE_DELIVERY_SOURCES.join(", ")})`,
    );
  }
  return id as PluginDeliverySource;
}
