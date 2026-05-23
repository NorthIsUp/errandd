import { useId } from "react";
import { Card } from "../../components/Card";
import { Field } from "../../components/Field";
import { Select } from "../../components/Select";

interface Props {
  level: string;
  onChange: (v: string) => void;
}

export function SecurityFieldset({ level, onChange }: Props) {
  const id = useId();

  return (
    <Card title="Security">
      <Field label="Level" htmlFor={id}>
        <Select
          id={id}
          value={level}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        >
          <option value="locked">Locked</option>
          <option value="strict">Strict</option>
          <option value="moderate">Moderate</option>
          <option value="unrestricted">Unrestricted</option>
        </Select>
      </Field>
    </Card>
  );
}
