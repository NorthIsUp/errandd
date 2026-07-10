import { getCachedOpenPRs } from "../../pr-poller";
import { json } from "../http";
import type { RouteHandler } from "./types";

/** GET /api/prs/open — flat list of all open PRs from the reconciliation poller. */
export const openPRsList: RouteHandler = () => {
  const { prs, fetchedAt } = getCachedOpenPRs();
  return json({ prs, fetchedAt });
};
