import { datadogAlertSnapshots } from "../../alert-snapshots";
import { recentDeliveries, subscribeDeliveries } from "../../hooks/deliveries";
import { json } from "../http";
import type { RouteHandler } from "./types";

const snapshot = () => ({ alerts: datadogAlertSnapshots(recentDeliveries()) });
export const alertsList: RouteHandler = () => json(snapshot());
export const alertsEvents: RouteHandler = ({ req, sseResponse }) => sseResponse(req, send => {
  send(snapshot());
  return subscribeDeliveries(delivery => { if (delivery.event.startsWith("datadog:")) send(snapshot()); });
});
