import { getDatadogAlertStore } from "../../alert-snapshots";
import { json } from "../http";
import type { RouteHandler } from "./types";

const snapshot = () => ({ alerts: getDatadogAlertStore().snapshot() });
export const alertsList: RouteHandler = () => json(snapshot());
export const alertsEvents: RouteHandler = ({ req, sseResponse }) => sseResponse(req, send => {
  send(snapshot());
  return getDatadogAlertStore().subscribe(() => send(snapshot()));
});
