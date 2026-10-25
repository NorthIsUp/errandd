import { acceptsCveWebhooks, pollsCves } from "../../../shared/eventSources";
import { getCveConnection, saveCveConnection } from "../../eventSourceSettings";
import { checkCveFeed } from "../../cve-feed";
import { getReadCache } from "../../readCache";
import { getSources } from "../../hooks/sources";
import { json } from "../http";
import type { RouteHandler } from "./types";

export const eventSourcesGet: RouteHandler = ({ opts, url }) => {
  const jobs = opts.getSnapshot().jobs;
  return json({
    sources: getSources().map((source) => {
      const status = source.providerStatus(url.origin);
      const errands = jobs
        .filter((job) => {
          const cfg = job.hookConfig;
          if (!cfg) return false;
          if (source.id === "github")
            return (
              cfg.pr.length > 0 || Boolean(cfg.comments || cfg.reviews || cfg.checks || cfg.issues)
            );
          return Boolean(cfg[source.id as "sentry" | "datadog" | "linear" | "cve"]);
        })
        .map((job) => ({
          name: job.name,
          enabled: job.enabled !== false,
          polling:
            job.hookConfig?.cve === true ||
            (typeof job.hookConfig?.cve === "object" && job.hookConfig.cve.poll),
        }));
      return {
        ...(status.extra?.recommendedPayload
          ? { payloadTemplate: status.extra.recommendedPayload }
          : {}),
        ...(typeof status.extra?.botMention === "string"
          ? { botMention: status.extra.botMention }
          : {}),
        id: source.id,
        url: status.url,
        configured: status.configured,
        secretEnv: status.secretEnv,
        modes: source.id === "cve" ? ["webhook", "poll", "both"] : ["webhook"],
        errands,
        ...(source.id === "cve"
          ? {
              connection: getCveConnection(),
              pollStatus: getReadCache().get("cve-monitor", "status")?.value,
              active: {
                webhook: acceptsCveWebhooks(getCveConnection()) && status.configured,
                poll:
                  pollsCves(getCveConnection()) &&
                  errands.some((job) => job.enabled && job.polling),
              },
            }
          : {}),
      };
    }),
  });
};
export const eventSourcePut: RouteHandler = async ({ req }) => {
  try {
    return json({ ok: true, connection: saveCveConnection(await req.json()) });
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : "Invalid source settings" },
      400,
    );
  }
};
export const eventSourceTest: RouteHandler = async ({ req }) => {
  try {
    const { parseCveConnection } = await import("../../../shared/eventSources");
    return json({ ok: true, ...(await checkCveFeed(parseCveConnection(await req.json()))) });
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : "Feed check failed" },
      400,
    );
  }
};
