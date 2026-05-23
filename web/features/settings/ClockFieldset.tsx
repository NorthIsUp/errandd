import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Select,
} from "@pikoloo/darwin-ui";
import { useMemo } from "react";
import { Field } from "../../components/Field";

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
  // If the current timezone isn't in the known list, prepend it
  const timezones = useMemo(() => {
    if (timezone && !KNOWN_TIMEZONES.includes(timezone)) {
      return [timezone, ...KNOWN_TIMEZONES];
    }
    return KNOWN_TIMEZONES;
  }, [timezone]);

  return (
    <Card glass>
      <CardHeader>
        <CardTitle>Clock</CardTitle>
      </CardHeader>
      <CardContent>
        <Field label="Format">
          <Select
            value={clockFormat}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "12" || v === "24") onClockFormatChange(v);
            }}
          >
            <Select.Option value="24">24-hour</Select.Option>
            <Select.Option value="12">12-hour</Select.Option>
          </Select>
        </Field>
        <Field label="Timezone">
          <Select
            value={timezone || "UTC"}
            onChange={(e) => {
              onTimezoneChange(e.target.value);
            }}
          >
            {timezones.map((tz) => (
              <Select.Option key={tz} value={tz}>
                {tz}
              </Select.Option>
            ))}
          </Select>
        </Field>
      </CardContent>
    </Card>
  );
}
