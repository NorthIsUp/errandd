import { z } from "zod";
import { getCveSubscriptions } from "../../cve-subscriptions";
import { recordNotAffected } from "../../cve-applicability";
import { cveApplicabilitySchema } from "../../../shared/cveApplicability";
import { getReadCache } from "../../readCache";
import { getHookQueue } from "../../hookQueue";
import { json } from "../http";
import type { RouteHandler } from "./types";

const requestSchema = cveApplicabilitySchema.extend({
  job: z.string().min(1), repository: z.string().min(1), id: z.string().min(1),
});
export const cveAssessmentPost: RouteHandler = async ({ req, opts }) => {
  const input = requestSchema.safeParse(await req.json().catch(() => null));
  if (!input.success) return json({ error: "Provide a not_affected verdict, current context, reason, evidence URLs, and findings for every coverage area", details: input.error.issues }, 400);
  const store = getReadCache();
  const scan = getCveSubscriptions(store, opts.getSnapshot().jobs)
    .find(subscription => subscription.name === input.data.job)?.scans
    .find(value => value.repository.toLowerCase() === input.data.repository.toLowerCase());
  if (!scan) return json({ error: "Repository scan not found" }, 404);
  try {
    const finding = recordNotAffected(store, scan, input.data.id, input.data);
    getHookQueue().resolvePendingCve(scan.job, scan.repository, finding.aliases);
    return json({ ok: true, finding });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Assessment could not be recorded" }, 409);
  }
};
