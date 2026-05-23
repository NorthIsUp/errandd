import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Select,
} from "@pikoloo/darwin-ui";
import { Field } from "../../components/Field";

interface Props {
  level: string;
  onChange: (v: string) => void;
}

export function SecurityFieldset({ level, onChange }: Props) {
  return (
    <Card glass>
      <CardHeader>
        <CardTitle>Security</CardTitle>
      </CardHeader>
      <CardContent>
        <Field label="Level">
          <Select
            value={level}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          >
            <Select.Option value="locked">Locked</Select.Option>
            <Select.Option value="strict">Strict</Select.Option>
            <Select.Option value="moderate">Moderate</Select.Option>
            <Select.Option value="unrestricted">Unrestricted</Select.Option>
          </Select>
        </Field>
      </CardContent>
    </Card>
  );
}
