import { useId, useMemo } from "react";
import { Card } from "../../components/Card";
import { Field } from "../../components/Field";
import { Select } from "../../components/Select";

const KNOWN_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Australia/Sydney",
];

interface Props {
  clockFormat: "12" | "24";
  timezone: string;
  onClockFormatChange: (v: "12" | "24") => void;
  onTimezoneChange: (v: string) => void;
}

export function ClockFieldset({
  clockFormat,
  timezone,
  onClockFormatChange,
  onTimezoneChange,
}: Props) {
  const baseId = useId();
  const formatId = `${baseId}-format`;
  const tzId = `${baseId}-tz`;

  // If the current timezone isn't in the known list, prepend it
  const timezones = useMemo(() => {
    if (timezone && !KNOWN_TIMEZONES.includes(timezone)) {
      return [timezone, ...KNOWN_TIMEZONES];
    }
    return KNOWN_TIMEZONES;
  }, [timezone]);

  return (
    <Card title="Clock">
      <Field label="Format" htmlFor={formatId}>
        <Select
          id={formatId}
          value={clockFormat}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "12" || v === "24") onClockFormatChange(v);
          }}
        >
          <option value="24">24-hour</option>
          <option value="12">12-hour</option>
        </Select>
      </Field>
      <Field label="Timezone" htmlFor={tzId}>
        <Select
          id={tzId}
          value={timezone || "UTC"}
          onChange={(e) => {
            onTimezoneChange(e.target.value);
          }}
        >
          {timezones.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </Select>
      </Field>
    </Card>
  );
}
