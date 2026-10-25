import {
  defaultCveConnection,
  parseCveConnection,
  type CveConnection,
} from "../shared/eventSources";
import { getReadCache, type ReadCache } from "./readCache";
type Store = Pick<ReadCache, "get" | "set">;
export function getCveConnection(store: Store = getReadCache()): CveConnection {
  const saved = store.get<CveConnection>("event-source-settings", "cve");
  return saved ? parseCveConnection(saved.value) : defaultCveConnection();
}
export function saveCveConnection(value: unknown, store: Store = getReadCache()): CveConnection {
  const connection = parseCveConnection(value);
  store.set("event-source-settings", "cve", connection);
  return connection;
}
