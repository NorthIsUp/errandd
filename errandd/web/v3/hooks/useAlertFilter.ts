import { useState } from "react";
import { ALERT_FILTERS, type AlertFilter } from "../lib/alerts";
const KEY = "errandd:v3:alert-filter";
function load(): AlertFilter {
  try { return ALERT_FILTERS.find(filter => filter.value === localStorage.getItem(KEY))?.value ?? "all"; }
  catch { return "all"; }
}
export function useAlertFilter(): [AlertFilter, (value: AlertFilter) => void] {
  const [filter, setFilter] = useState<AlertFilter>(load);
  const update = (value: AlertFilter) => {
    setFilter(value);
    try { localStorage.setItem(KEY, value); } catch { /* Storage is optional. */ }
  };
  return [filter, update];
}
