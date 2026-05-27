// Build the timezone option list for the Settings dropdown.
// Order: user TZ → server TZ → US sublist → all.

const US_TZS = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
];

function allTimezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  if (typeof intl.supportedValuesOf === "function") {
    return intl.supportedValuesOf("timeZone");
  }
  return [...US_TZS, "UTC", "Europe/London", "Europe/Paris", "Asia/Tokyo"];
}

export interface TzOption {
  value: string;
  label: string;
  disabled?: boolean;
}

const SEP = "─────────────";

export function buildTimezoneOptions(serverTz: string | null): TzOption[] {
  const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const all = allTimezones();
  const seen = new Set<string>();
  const out: TzOption[] = [];

  function push(value: string, label: string) {
    if (seen.has(value)) return;
    seen.add(value);
    out.push({ value, label });
  }

  push(userTz, `${userTz}  (browser)`);
  if (serverTz && serverTz !== userTz) {
    push(serverTz, `${serverTz}  (server)`);
  }

  out.push({ value: `__sep_us__`, label: `${SEP} US ${SEP}`, disabled: true });
  for (const tz of US_TZS) push(tz, tz);

  out.push({ value: `__sep_all__`, label: `${SEP} All ${SEP}`, disabled: true });
  for (const tz of all) push(tz, tz);

  return out;
}
